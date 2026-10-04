import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { logActivity, jsonError, nowIso } from '../lib/db.js';

export const accountingRoutes = new Hono();
accountingRoutes.use('*', requireAuth);

// ---------------------------------------------------------------------------
// صلاحيات قسم الملفات (الحسابات + الشئون القانونية + HR)
// ---------------------------------------------------------------------------
// - موظفو الحسابات (department='accounting') + الشئون القانونية (department='legal')
//   + HR (isHr) + المالك (isOwner): تحكم كامل في الملفات وأذونات الحركة.
// - قائد الفريق العادي: يشوف حركة الملفات فقط (قراءة بدون أي تعديل).
// - موظف خدمة العملاء العادي: لا يصل لأي شيء في الملفات.
// ---------------------------------------------------------------------------

function isAccountingUser(user) {
  return user.isOwner || user.department === 'accounting' || user.department === 'legal' || user.isHr;
}

function canViewMovements(user) {
  return user.isOwner || user.department === 'accounting' || user.department === 'legal' || user.role === 'team_leader' || user.isHr;
}

// حارس: العمليات الكاملة (إنشاء/تعديل ملفات وحركات) — حسابات + المالك فقط
async function requireAccountingAccess(c, next) {
  const user = c.get('user');
  if (!isAccountingUser(user)) {
    return jsonError(c, 403, 'هذا القسم مخصص لموظفي الحسابات فقط', 'FORBIDDEN_ACCOUNTING');
  }
  return next();
}

// حارس: عرض الحركات فقط (قراءة) — حسابات + المالك + قائد الفريق + HR
async function requireMovementViewAccess(c, next) {
  const user = c.get('user');
  if (!canViewMovements(user)) {
    return jsonError(c, 403, 'غير مصرح بعرض حركة الملفات', 'FORBIDDEN_MOVEMENTS');
  }
  return next();
}

const LOCATIONS = ['office', 'accounting', 'legal'];
const LOCATION_LABELS = { office: 'المكتب (أ. هاني)', accounting: 'الحسابات', legal: 'الشئون القانونية' };
const STATUSES = ['active_regular', 'active_late', 'rejected', 'needs_review'];

// ===== ملفات العملاء =====

// قائمة الملفات مع بحث وفلترة
accountingRoutes.get('/files', requireAccountingAccess, async (c) => {
  const db = c.env.DB;
  const q = c.req.query('q')?.trim();
  const status = c.req.query('status');
  const location = c.req.query('location');
  const payment = c.req.query('payment'); // active | inactive | overdue
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  let where = '1=1';
  const params = [];

  if (q) {
    where += ` AND (cf.file_number LIKE ? OR cf.client_name LIKE ? OR cf.client_phone LIKE ? OR cf.guarantor_name LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status && STATUSES.includes(status)) {
    where += ` AND cf.status = ?`;
    params.push(status);
  }
  if (location && LOCATIONS.includes(location)) {
    where += ` AND cf.current_location = ?`;
    params.push(location);
  }
  if (payment === 'active') {
    where += ` AND COALESCE(cfpi.payment_active, 1) = 1`;
  } else if (payment === 'inactive') {
    where += ` AND cfpi.payment_active = 0`;
  } else if (payment === 'overdue') {
    where += ` AND COALESCE(cfpi.payment_active, 1) = 1 AND cfpi.installment_due_date IS NOT NULL AND cfpi.installment_due_date < date('now')`;
  }

  // COUNT needs the same JOINs when filtering by payment
  const needsPaymentJoin = !!payment;
  const countSql = needsPaymentJoin
    ? `SELECT COUNT(*) AS total FROM client_files cf LEFT JOIN client_file_payment_info cfpi ON cfpi.file_id = cf.id WHERE ${where}`
    : `SELECT COUNT(*) AS total FROM client_files cf WHERE ${where}`;
  const countRow = await db.prepare(countSql).bind(...params).first();

  const rows = await db.prepare(
    `SELECT cf.*, u.display_name AS created_by_name,
            cfd.installment_value, cfd.product_type, cfd.sales_rep, cfd.investigation_rep,
            COALESCE(cfpi.payment_active, 1) AS payment_active,
            cfpi.installment_due_date
     FROM client_files cf
     LEFT JOIN users u ON u.id = cf.created_by
     LEFT JOIN client_file_details cfd ON cfd.file_id = cf.id
     LEFT JOIN client_file_payment_info cfpi ON cfpi.file_id = cf.id
     WHERE ${where}
     ORDER BY cf.id DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return c.json({ files: rows.results, total: countRow.total, page, limit });
});

// تفاصيل ملف واحد
accountingRoutes.get('/files/:id', requireAccountingAccess, async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const file = await db.prepare(
    `SELECT cf.*, u.display_name AS created_by_name,
            cfd.installment_value, cfd.product_type, cfd.sales_rep, cfd.investigation_rep,
            COALESCE(cfpi.payment_active, 1) AS payment_active,
            cfpi.installment_due_date
     FROM client_files cf LEFT JOIN users u ON u.id = cf.created_by
     LEFT JOIN client_file_details cfd ON cfd.file_id = cf.id
     LEFT JOIN client_file_payment_info cfpi ON cfpi.file_id = cf.id
     WHERE cf.id = ?`
  ).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود', 'FILE_NOT_FOUND');
  return c.json({ file });
});

// إنشاء ملف جديد
accountingRoutes.post('/files', requireAccountingAccess, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const fileNumber = String(body.fileNumber || '').trim();
  const clientName = String(body.clientName || '').trim();
  const clientPhone = body.clientPhone ? String(body.clientPhone).trim() : null;
  const guarantorName = body.guarantorName ? String(body.guarantorName).trim() : null;
  const guarantorPhone = body.guarantorPhone ? String(body.guarantorPhone).trim() : null;
  const status = body.status || 'active_regular';
  const statusReason = body.statusReason ? String(body.statusReason).trim() : null;
  const currentLocation = body.currentLocation || 'accounting';
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!fileNumber) return jsonError(c, 400, 'رقم الملف مطلوب', 'MISSING_FILE_NUMBER');
  if (!clientName) return jsonError(c, 400, 'اسم العميل مطلوب', 'MISSING_CLIENT_NAME');
  if (!STATUSES.includes(status)) return jsonError(c, 400, 'حالة الملف غير صالحة', 'INVALID_STATUS');
  if (!LOCATIONS.includes(currentLocation)) return jsonError(c, 400, 'الموقع غير صالح', 'INVALID_LOCATION');
  if ((status === 'rejected' || status === 'needs_review') && !statusReason) {
    return jsonError(c, 400, 'يجب تحديد السبب عند اختيار هذه الحالة', 'MISSING_STATUS_REASON');
  }

  const existing = await db.prepare(`SELECT id FROM client_files WHERE file_number = ?`).bind(fileNumber).first();
  if (existing) return jsonError(c, 409, 'رقم الملف موجود بالفعل', 'DUPLICATE_FILE_NUMBER');

  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO client_files (file_number, client_name, client_phone, guarantor_name, guarantor_phone, status, status_reason, current_location, notes, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(fileNumber, clientName, clientPhone, guarantorName, guarantorPhone, status, statusReason, currentLocation, notes, user.id, user.id, now, now).first();

  // Insert extra details into client_file_details
  const installmentValue = body.installmentValue != null ? Number(body.installmentValue) : 0;
  const productType = body.productType ? String(body.productType).trim() : null;
  const salesRep = body.salesRep ? String(body.salesRep).trim() : null;
  const investigationRep = body.investigationRep ? String(body.investigationRep).trim() : null;
  await db.prepare(
    `INSERT INTO client_file_details (file_id, installment_value, product_type, sales_rep, investigation_rep, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, installmentValue, productType, salesRep, investigationRep, now, now).run();

  // بيانات الدفع — جدول منفصل (ALTER TABLE ممنوع)
  const paymentActive = body.paymentActive != null ? (body.paymentActive ? 1 : 0) : 1;
  const installmentDueDate = body.installmentDueDate ? String(body.installmentDueDate).trim() : null;
  await db.prepare(
    `INSERT INTO client_file_payment_info (file_id, payment_active, installment_due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(row.id, paymentActive, installmentDueDate, now, now).run();

  await logActivity(db, {
    actor: user, action: 'FILE_CREATED', entityType: 'client_file', entityId: String(row.id),
    metadata: { fileNumber, clientName },
  });

  return c.json({ ok: true, fileId: row.id });
});

// تعديل ملف
accountingRoutes.put('/files/:id', requireAccountingAccess, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const file = await db.prepare(`SELECT * FROM client_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود', 'FILE_NOT_FOUND');

  const clientName = body.clientName ? String(body.clientName).trim() : file.client_name;
  const clientPhone = body.clientPhone !== undefined ? (body.clientPhone ? String(body.clientPhone).trim() : null) : file.client_phone;
  const guarantorName = body.guarantorName !== undefined ? (body.guarantorName ? String(body.guarantorName).trim() : null) : file.guarantor_name;
  const guarantorPhone = body.guarantorPhone !== undefined ? (body.guarantorPhone ? String(body.guarantorPhone).trim() : null) : file.guarantor_phone;
  const status = body.status || file.status;
  const statusReason = body.statusReason !== undefined ? (body.statusReason ? String(body.statusReason).trim() : null) : file.status_reason;
  const notes = body.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : file.notes;

  if (!STATUSES.includes(status)) return jsonError(c, 400, 'حالة الملف غير صالحة', 'INVALID_STATUS');
  if ((status === 'rejected' || status === 'needs_review') && !statusReason) {
    return jsonError(c, 400, 'يجب تحديد السبب عند اختيار هذه الحالة', 'MISSING_STATUS_REASON');
  }

  const now = nowIso();
  await db.prepare(
    `UPDATE client_files SET client_name=?, client_phone=?, guarantor_name=?, guarantor_phone=?, status=?, status_reason=?, notes=?, updated_by=?, updated_at=? WHERE id=?`
  ).bind(clientName, clientPhone, guarantorName, guarantorPhone, status, statusReason, notes, user.id, now, id).run();

  // Upsert extra details into client_file_details
  const installmentValue = body.installmentValue != null ? Number(body.installmentValue) : 0;
  const productType = body.productType !== undefined ? (body.productType ? String(body.productType).trim() : null) : null;
  const salesRep = body.salesRep !== undefined ? (body.salesRep ? String(body.salesRep).trim() : null) : null;
  const investigationRep = body.investigationRep !== undefined ? (body.investigationRep ? String(body.investigationRep).trim() : null) : null;
  await db.prepare(
    `INSERT INTO client_file_details (file_id, installment_value, product_type, sales_rep, investigation_rep, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       installment_value = excluded.installment_value,
       product_type = excluded.product_type,
       sales_rep = excluded.sales_rep,
       investigation_rep = excluded.investigation_rep,
       updated_at = excluded.updated_at`
  ).bind(id, installmentValue, productType, salesRep, investigationRep, now, now).run();

  // Upsert بيانات الدفع
  const paymentActive = body.paymentActive != null ? (body.paymentActive ? 1 : 0) : 1;
  const installmentDueDate = body.installmentDueDate !== undefined
    ? (body.installmentDueDate ? String(body.installmentDueDate).trim() : null)
    : null;
  await db.prepare(
    `INSERT INTO client_file_payment_info (file_id, payment_active, installment_due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       payment_active = excluded.payment_active,
       installment_due_date = excluded.installment_due_date,
       updated_at = excluded.updated_at`
  ).bind(id, paymentActive, installmentDueDate, now, now).run();

  await logActivity(db, {
    actor: user, action: 'FILE_UPDATED', entityType: 'client_file', entityId: String(id),
    metadata: { fileNumber: file.file_number, status },
  });

  return c.json({ ok: true });
});

// ===== حركة الملفات =====

// إنشاء إذن حركة (نقل ملف من قسم لقسم)
accountingRoutes.post('/files/:id/movements', requireAccountingAccess, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const fileId = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const file = await db.prepare(`SELECT * FROM client_files WHERE id = ?`).bind(fileId).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود', 'FILE_NOT_FOUND');

  const toLocation = String(body.toLocation || '').trim();
  const takenByName = String(body.takenByName || '').trim();
  const reason = String(body.reason || '').trim();
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!toLocation || !LOCATIONS.includes(toLocation)) return jsonError(c, 400, 'القسم المستلم غير صالح', 'INVALID_LOCATION');
  if (toLocation === file.current_location) return jsonError(c, 400, 'الملف موجود بالفعل في هذا القسم', 'SAME_LOCATION');
  if (!takenByName) return jsonError(c, 400, 'اسم الموظف المستلم مطلوب', 'MISSING_TAKEN_BY');
  if (!reason) return jsonError(c, 400, 'سبب الحركة مطلوب', 'MISSING_REASON');

  const now = nowIso();
  const fromLocation = file.current_location;

  await db.prepare(
    `INSERT INTO file_movements (file_id, from_location, to_location, taken_by_name, reason, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(fileId, fromLocation, toLocation, takenByName, reason, notes, user.id, now).run();

  // تحديث الموقع الحالي للملف
  await db.prepare(`UPDATE client_files SET current_location = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
    .bind(toLocation, user.id, now, fileId).run();

  await logActivity(db, {
    actor: user, action: 'FILE_MOVED', entityType: 'client_file', entityId: String(fileId),
    metadata: { fileNumber: file.file_number, from: fromLocation, to: toLocation, takenBy: takenByName, reason },
  });

  return c.json({ ok: true });
});

// سجل حركات ملف واحد
accountingRoutes.get('/files/:id/movements', requireMovementViewAccess, async (c) => {
  const db = c.env.DB;
  const fileId = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT file_number, client_name FROM client_files WHERE id = ?`).bind(fileId).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود', 'FILE_NOT_FOUND');

  const rows = await db.prepare(
    `SELECT fm.*, u.display_name AS created_by_name
     FROM file_movements fm
     LEFT JOIN users u ON u.id = fm.created_by
     WHERE fm.file_id = ?
     ORDER BY fm.created_at DESC`
  ).bind(fileId).all();

  return c.json({ movements: rows.results, file });
});

// سجل كل الحركات الأخيرة (لصفحة "حركة الملفات")
accountingRoutes.get('/movements', requireMovementViewAccess, async (c) => {
  const db = c.env.DB;
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const q = c.req.query('q')?.trim();

  let where = '1=1';
  const params = [];
  if (q) {
    where += ` AND (cf.file_number LIKE ? OR cf.client_name LIKE ? OR fm.taken_by_name LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const countRow = await db.prepare(
    `SELECT COUNT(*) AS total FROM file_movements fm JOIN client_files cf ON cf.id = fm.file_id WHERE ${where}`
  ).bind(...params).first();

  const rows = await db.prepare(
    `SELECT fm.*, cf.file_number, cf.client_name, u.display_name AS created_by_name
     FROM file_movements fm
     JOIN client_files cf ON cf.id = fm.file_id
     LEFT JOIN users u ON u.id = fm.created_by
     WHERE ${where}
     ORDER BY fm.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return c.json({ movements: rows.results, total: countRow.total, page, limit });
});

// إحصائيات سريعة (عدد الملفات لكل حالة/موقع)
accountingRoutes.get('/stats', requireAccountingAccess, async (c) => {
  const db = c.env.DB;
  const byStatus = await db.prepare(`SELECT status, COUNT(*) AS cnt FROM client_files GROUP BY status`).all();
  const byLocation = await db.prepare(`SELECT current_location, COUNT(*) AS cnt FROM client_files GROUP BY current_location`).all();
  const totalMovements = await db.prepare(`SELECT COUNT(*) AS cnt FROM file_movements`).first();
  const todayMovements = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM file_movements WHERE created_at >= date('now', 'start of day')`
  ).first();

  // إحصائيات الدفع
  const paymentActive = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM client_file_payment_info WHERE payment_active = 1`
  ).first();
  const paymentInactive = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM client_file_payment_info WHERE payment_active = 0`
  ).first();
  const overdueCount = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM client_file_payment_info
     WHERE installment_due_date IS NOT NULL AND installment_due_date < date('now') AND payment_active = 1`
  ).first();

  return c.json({
    byStatus: byStatus.results,
    byLocation: byLocation.results,
    totalMovements: totalMovements.cnt,
    todayMovements: todayMovements.cnt,
    paymentActive: paymentActive?.cnt || 0,
    paymentInactive: paymentInactive?.cnt || 0,
    overdueCount: overdueCount?.cnt || 0,
  });
});

// =====================================================================
//  نظام المرتبات — Payroll System
// =====================================================================

// ── تكوين المرتبات (salary_config) ──

// عرض قائمة الموظفين مع رواتبهم
accountingRoutes.get('/payroll/salaries', requireAccountingAccess, async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(
    `SELECT e.id AS employee_id, e.name, COALESCE(e.name_ar, e.name) AS name_ar, e.active,
            sc.base_salary, sc.housing_allowance, sc.transport_allowance, sc.other_allowance,
            sc.effective_from, sc.notes AS salary_notes,
            hp.job_title, hp.department AS hr_department
     FROM employees e
     LEFT JOIN salary_config sc ON sc.employee_id = e.id
     LEFT JOIN employee_hr_profiles hp ON hp.employee_id = e.id
     WHERE e.active = 1
     ORDER BY e.name COLLATE NOCASE`
  ).all();
  return c.json({ employees: rows.results });
});

// حفظ / تحديث راتب موظف
accountingRoutes.post('/payroll/salaries/:employeeId', requireAccountingAccess, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const employeeId = Number(c.req.param('employeeId'));
  const body = await c.req.json().catch(() => ({}));

  const emp = await db.prepare(`SELECT id, name FROM employees WHERE id = ? AND active = 1`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'EMPLOYEE_NOT_FOUND');

  const baseSalary = Number(body.baseSalary) || 0;
  const housingAllowance = Number(body.housingAllowance) || 0;
  const transportAllowance = Number(body.transportAllowance) || 0;
  const otherAllowance = Number(body.otherAllowance) || 0;
  const effectiveFrom = body.effectiveFrom || new Date().toISOString().slice(0, 10);
  const notes = body.notes ? String(body.notes).trim() : null;

  if (baseSalary < 0) return jsonError(c, 400, 'الراتب الأساسي لا يمكن أن يكون سالبًا', 'INVALID_SALARY');

  const now = nowIso();
  const existing = await db.prepare(`SELECT id FROM salary_config WHERE employee_id = ?`).bind(employeeId).first();

  if (existing) {
    await db.prepare(
      `UPDATE salary_config SET base_salary=?, housing_allowance=?, transport_allowance=?, other_allowance=?, effective_from=?, notes=?, updated_by=?, updated_at=? WHERE employee_id=?`
    ).bind(baseSalary, housingAllowance, transportAllowance, otherAllowance, effectiveFrom, notes, user.id, now, employeeId).run();
  } else {
    await db.prepare(
      `INSERT INTO salary_config (employee_id, base_salary, housing_allowance, transport_allowance, other_allowance, effective_from, notes, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(employeeId, baseSalary, housingAllowance, transportAllowance, otherAllowance, effectiveFrom, notes, user.id, user.id, now, now).run();
  }

  await logActivity(db, {
    actor: user, action: 'SALARY_CONFIGURED', entityType: 'salary_config', entityId: String(employeeId),
    metadata: { employeeName: emp.name, baseSalary },
  });

  return c.json({ ok: true });
});

// ── دورات المرتبات (payroll_runs) ──

// قائمة الدورات
accountingRoutes.get('/payroll/runs', requireAccountingAccess, async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(
    `SELECT pr.*, u1.display_name AS created_by_name, u2.display_name AS closed_by_name
     FROM payroll_runs pr
     LEFT JOIN users u1 ON u1.id = pr.created_by
     LEFT JOIN users u2 ON u2.id = pr.closed_by
     ORDER BY pr.month DESC`
  ).all();
  return c.json({ runs: rows.results });
});

// إنشاء دورة مرتبات جديدة (مسودة) + حساب تلقائي
accountingRoutes.post('/payroll/runs', requireAccountingAccess, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const month = String(body.month || '').trim(); // YYYY-MM
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return jsonError(c, 400, 'صيغة الشهر غير صالحة (YYYY-MM)', 'INVALID_MONTH');
  }

  const existing = await db.prepare(`SELECT id, status FROM payroll_runs WHERE month = ?`).bind(month).first();
  if (existing) {
    return jsonError(c, 409, `يوجد بالفعل دورة مرتبات لشهر ${month} (${existing.status === 'CLOSED' ? 'مغلقة' : 'مسودة'})`, 'DUPLICATE_RUN');
  }

  // جلب الموظفين النشطين مع رواتبهم
  const employees = await db.prepare(
    `SELECT e.id, e.name, COALESCE(e.name_ar, e.name) AS name_ar,
            COALESCE(sc.base_salary, 0) AS base_salary,
            COALESCE(sc.housing_allowance, 0) AS housing_allowance,
            COALESCE(sc.transport_allowance, 0) AS transport_allowance,
            COALESCE(sc.other_allowance, 0) AS other_allowance
     FROM employees e
     LEFT JOIN salary_config sc ON sc.employee_id = e.id
     WHERE e.active = 1
     ORDER BY e.name COLLATE NOCASE`
  ).all();

  const monthStart = month + '-01';
  const monthEndDate = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
  const monthEnd = month + '-' + String(monthEndDate.getDate()).padStart(2, '0');
  const daysInMonth = monthEndDate.getDate();

  const now = nowIso();

  // إنشاء الدورة أولاً
  const runRow = await db.prepare(
    `INSERT INTO payroll_runs (month, status, notes, created_by, created_at, updated_at)
     VALUES (?, 'DRAFT', ?, ?, ?, ?) RETURNING id`
  ).bind(month, notes, user.id, now, now).first();
  const runId = runRow.id;

  let totalBase = 0, totalAllowances = 0, totalBonuses = 0;
  let totalDeductions = 0, totalAdvances = 0, totalPenalties = 0, totalNet = 0;

  // حساب كشف مرتب لكل موظف
  for (const emp of employees.results) {
    const eid = emp.id;

    // ─ بدلات من employee_benefits ─
    const benefitsAllow = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_benefits
       WHERE employee_id = ? AND benefit_type = 'ALLOWANCE' AND status = 'APPROVED'
       AND effective_date >= ? AND effective_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();

    const benefitsBonuses = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_benefits
       WHERE employee_id = ? AND benefit_type = 'BONUS' AND status = 'APPROVED'
       AND effective_date >= ? AND effective_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();

    const benefitsDeductions = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_benefits
       WHERE employee_id = ? AND benefit_type = 'DEDUCTION' AND status = 'APPROVED'
       AND effective_date >= ? AND effective_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();

    const benefitsAdvances = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_benefits
       WHERE employee_id = ? AND benefit_type = 'ADVANCE' AND status IN ('APPROVED','PAID')
       AND effective_date >= ? AND effective_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();

    // ─ مكافآت المبيعات (reward_transactions) ─
    const rewardRow = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS bonuses,
              COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS deductions
       FROM reward_transactions
       WHERE employee_id = ? AND created_at >= ? AND created_at < ?`
    ).bind(eid, monthStart + 'T00:00:00', monthEnd + 'T23:59:59').first();

    // ─ حوافز (motivation_events) ─
    const motivRow = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS bonuses,
              COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS penalties
       FROM motivation_events
       WHERE employee_id = ? AND created_at >= ? AND created_at < ?`
    ).bind(eid, monthStart + 'T00:00:00', monthEnd + 'T23:59:59').first();

    // ─ الغياب (إجازات بدون مرتب) ─
    const absenceRow = await db.prepare(
      `SELECT COALESCE(SUM(days_count), 0) AS days FROM leave_requests
       WHERE employee_id = ? AND leave_type = 'UNPAID' AND status = 'APPROVED'
       AND start_date >= ? AND start_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();
    const absenceDays = absenceRow.days;
    const dailyRate = emp.base_salary > 0 ? emp.base_salary / 30 : 0;
    const absenceDeduction = Math.round(absenceDays * dailyRate * 100) / 100;

    // ─ التأخير ─
    const lateRow = await db.prepare(
      `SELECT COALESCE(late_count_at_penalty, 0) AS cnt FROM attendance_penalties
       WHERE user_id = (SELECT user_id FROM employees WHERE id = ?) AND month = ?`
    ).bind(eid, month).first();
    const lateCount = lateRow?.cnt || 0;
    // خصم التأخير: كل 3 تأخيرات = يوم خصم
    const latePenaltyDays = Math.floor(lateCount / 3);
    const lateDeduction = Math.round(latePenaltyDays * dailyRate * 100) / 100;

    // ─ مخالفات (غرامات) ─
    const violRow = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN action_taken = 'FINE' THEN 1 ELSE 0 END), 0) AS fines
       FROM employee_violations
       WHERE employee_id = ? AND created_at >= ? AND created_at < ?`
    ).bind(eid, monthStart + 'T00:00:00', monthEnd + 'T23:59:59').first();
    // كل مخالفة غرامة = خصم يوم
    const violationFines = Math.round((violRow?.fines || 0) * dailyRate * 100) / 100;

    // ─ الحساب النهائي ─
    const configAllowances = emp.housing_allowance + emp.transport_allowance + emp.other_allowance;
    const gross = emp.base_salary + configAllowances + (benefitsAllow?.total || 0) + (benefitsBonuses?.total || 0) + (rewardRow?.bonuses || 0) + (motivRow?.bonuses || 0);
    const deductions = (benefitsDeductions?.total || 0) + (benefitsAdvances?.total || 0) + absenceDeduction + lateDeduction + violationFines + (rewardRow?.deductions || 0) + (motivRow?.penalties || 0);
    const net = Math.round((gross - deductions) * 100) / 100;

    const details = {
      rewards: { bonuses: rewardRow?.bonuses || 0, deductions: rewardRow?.deductions || 0 },
      motivation: { bonuses: motivRow?.bonuses || 0, penalties: motivRow?.penalties || 0 },
      absence: { days: absenceDays, deduction: absenceDeduction },
      late: { count: lateCount, penaltyDays: latePenaltyDays, deduction: lateDeduction },
      violations: { fineCount: violRow?.fines || 0, deduction: violationFines },
    };

    await db.prepare(
      `INSERT INTO payslips (payroll_run_id, employee_id, employee_name, base_salary,
        housing_allowance, transport_allowance, other_allowance,
        benefits_allowances, benefits_bonuses, reward_bonus, motivation_bonus,
        benefits_deductions, benefits_advances, absence_days, absence_deduction,
        late_count, late_deduction, violation_fines, gross_salary, total_deductions, net_salary, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      runId, eid, emp.name_ar || emp.name, emp.base_salary,
      emp.housing_allowance, emp.transport_allowance, emp.other_allowance,
      benefitsAllow?.total || 0, benefitsBonuses?.total || 0, rewardRow?.bonuses || 0, motivRow?.bonuses || 0,
      benefitsDeductions?.total || 0, benefitsAdvances?.total || 0, absenceDays, absenceDeduction,
      lateCount, lateDeduction, violationFines, gross, deductions, net, JSON.stringify(details), now
    ).run();

    totalBase += emp.base_salary;
    totalAllowances += configAllowances + (benefitsAllow?.total || 0);
    totalBonuses += (benefitsBonuses?.total || 0) + (rewardRow?.bonuses || 0) + (motivRow?.bonuses || 0);
    totalDeductions += (benefitsDeductions?.total || 0) + (rewardRow?.deductions || 0) + (motivRow?.penalties || 0) + violationFines;
    totalAdvances += (benefitsAdvances?.total || 0);
    totalPenalties += absenceDeduction + lateDeduction;
    totalNet += net;
  }

  // تحديث إجماليات الدورة
  await db.prepare(
    `UPDATE payroll_runs SET total_base=?, total_allowances=?, total_bonuses=?, total_deductions=?, total_advances=?, total_penalties=?, total_net=?, employee_count=?, updated_at=? WHERE id=?`
  ).bind(
    Math.round(totalBase * 100) / 100,
    Math.round(totalAllowances * 100) / 100,
    Math.round(totalBonuses * 100) / 100,
    Math.round(totalDeductions * 100) / 100,
    Math.round(totalAdvances * 100) / 100,
    Math.round(totalPenalties * 100) / 100,
    Math.round(totalNet * 100) / 100,
    employees.results.length, now, runId
  ).run();

  await logActivity(db, {
    actor: user, action: 'PAYROLL_CREATED', entityType: 'payroll_run', entityId: String(runId),
    metadata: { month, employeeCount: employees.results.length },
  });

  return c.json({ ok: true, runId, month, employeeCount: employees.results.length });
});

// تفاصيل دورة مرتبات مع كشوف المرتبات
accountingRoutes.get('/payroll/runs/:id', requireAccountingAccess, async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const run = await db.prepare(
    `SELECT pr.*, u1.display_name AS created_by_name, u2.display_name AS closed_by_name
     FROM payroll_runs pr
     LEFT JOIN users u1 ON u1.id = pr.created_by
     LEFT JOIN users u2 ON u2.id = pr.closed_by
     WHERE pr.id = ?`
  ).bind(id).first();
  if (!run) return jsonError(c, 404, 'الدورة غير موجودة', 'RUN_NOT_FOUND');

  const payslips = await db.prepare(
    `SELECT * FROM payslips WHERE payroll_run_id = ? ORDER BY employee_name COLLATE NOCASE`
  ).bind(id).all();

  return c.json({ run, payslips: payslips.results });
});

// إغلاق دورة المرتبات
accountingRoutes.post('/payroll/runs/:id/close', requireAccountingAccess, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const run = await db.prepare(`SELECT * FROM payroll_runs WHERE id = ?`).bind(id).first();
  if (!run) return jsonError(c, 404, 'الدورة غير موجودة', 'RUN_NOT_FOUND');
  if (run.status === 'CLOSED') return jsonError(c, 400, 'الدورة مغلقة بالفعل', 'ALREADY_CLOSED');

  const now = nowIso();
  await db.prepare(
    `UPDATE payroll_runs SET status='CLOSED', closed_by=?, closed_at=?, updated_at=? WHERE id=?`
  ).bind(user.id, now, now, id).run();

  await logActivity(db, {
    actor: user, action: 'PAYROLL_CLOSED', entityType: 'payroll_run', entityId: String(id),
    metadata: { month: run.month },
  });

  return c.json({ ok: true });
});

// إعادة فتح دورة مغلقة (المالك فقط)
accountingRoutes.post('/payroll/runs/:id/reopen', requireAccountingAccess, async (c) => {
  const user = c.get('user');
  if (!user.isOwner) return jsonError(c, 403, 'إعادة الفتح متاحة للمالك فقط', 'OWNER_ONLY');

  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const run = await db.prepare(`SELECT * FROM payroll_runs WHERE id = ?`).bind(id).first();
  if (!run) return jsonError(c, 404, 'الدورة غير موجودة', 'RUN_NOT_FOUND');
  if (run.status !== 'CLOSED') return jsonError(c, 400, 'الدورة ليست مغلقة', 'NOT_CLOSED');

  const now = nowIso();
  await db.prepare(
    `UPDATE payroll_runs SET status='DRAFT', closed_by=NULL, closed_at=NULL, updated_at=? WHERE id=?`
  ).bind(now, id).run();

  await logActivity(db, {
    actor: user, action: 'PAYROLL_REOPENED', entityType: 'payroll_run', entityId: String(id),
    metadata: { month: run.month },
  });

  return c.json({ ok: true });
});

// إعادة حساب دورة (حذف الكشوف القديمة وإعادة الحساب)
accountingRoutes.post('/payroll/runs/:id/recalculate', requireAccountingAccess, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const run = await db.prepare(`SELECT * FROM payroll_runs WHERE id = ?`).bind(id).first();
  if (!run) return jsonError(c, 404, 'الدورة غير موجودة', 'RUN_NOT_FOUND');
  if (run.status === 'CLOSED') return jsonError(c, 400, 'لا يمكن إعادة حساب دورة مغلقة', 'RUN_CLOSED');

  // حذف الكشوف القديمة
  await db.prepare(`DELETE FROM payslips WHERE payroll_run_id = ?`).bind(id).run();

  // إعادة الحساب (نفس منطق الإنشاء)
  const month = run.month;
  const employees = await db.prepare(
    `SELECT e.id, e.name, COALESCE(e.name_ar, e.name) AS name_ar,
            COALESCE(sc.base_salary, 0) AS base_salary,
            COALESCE(sc.housing_allowance, 0) AS housing_allowance,
            COALESCE(sc.transport_allowance, 0) AS transport_allowance,
            COALESCE(sc.other_allowance, 0) AS other_allowance
     FROM employees e
     LEFT JOIN salary_config sc ON sc.employee_id = e.id
     WHERE e.active = 1
     ORDER BY e.name COLLATE NOCASE`
  ).all();

  const monthStart = month + '-01';
  const monthEndDate = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
  const monthEnd = month + '-' + String(monthEndDate.getDate()).padStart(2, '0');
  const now = nowIso();

  let totalBase = 0, totalAllowances = 0, totalBonuses = 0;
  let totalDeductions = 0, totalAdvances = 0, totalPenalties = 0, totalNet = 0;

  for (const emp of employees.results) {
    const eid = emp.id;
    const benefitsAllow = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_benefits WHERE employee_id = ? AND benefit_type = 'ALLOWANCE' AND status = 'APPROVED' AND effective_date >= ? AND effective_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();
    const benefitsBonuses = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_benefits WHERE employee_id = ? AND benefit_type = 'BONUS' AND status = 'APPROVED' AND effective_date >= ? AND effective_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();
    const benefitsDeductions = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_benefits WHERE employee_id = ? AND benefit_type = 'DEDUCTION' AND status = 'APPROVED' AND effective_date >= ? AND effective_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();
    const benefitsAdvances = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_benefits WHERE employee_id = ? AND benefit_type = 'ADVANCE' AND status IN ('APPROVED','PAID') AND effective_date >= ? AND effective_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();
    const rewardRow = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS bonuses, COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS deductions FROM reward_transactions WHERE employee_id = ? AND created_at >= ? AND created_at < ?`
    ).bind(eid, monthStart + 'T00:00:00', monthEnd + 'T23:59:59').first();
    const motivRow = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS bonuses, COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS penalties FROM motivation_events WHERE employee_id = ? AND created_at >= ? AND created_at < ?`
    ).bind(eid, monthStart + 'T00:00:00', monthEnd + 'T23:59:59').first();
    const absenceRow = await db.prepare(
      `SELECT COALESCE(SUM(days_count), 0) AS days FROM leave_requests WHERE employee_id = ? AND leave_type = 'UNPAID' AND status = 'APPROVED' AND start_date >= ? AND start_date <= ?`
    ).bind(eid, monthStart, monthEnd).first();
    const absenceDays = absenceRow.days;
    const dailyRate = emp.base_salary > 0 ? emp.base_salary / 30 : 0;
    const absenceDeduction = Math.round(absenceDays * dailyRate * 100) / 100;
    const lateRow = await db.prepare(
      `SELECT COALESCE(late_count_at_penalty, 0) AS cnt FROM attendance_penalties WHERE user_id = (SELECT user_id FROM employees WHERE id = ?) AND month = ?`
    ).bind(eid, month).first();
    const lateCount = lateRow?.cnt || 0;
    const latePenaltyDays = Math.floor(lateCount / 3);
    const lateDeduction = Math.round(latePenaltyDays * dailyRate * 100) / 100;
    const violRow = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN action_taken = 'FINE' THEN 1 ELSE 0 END), 0) AS fines FROM employee_violations WHERE employee_id = ? AND created_at >= ? AND created_at < ?`
    ).bind(eid, monthStart + 'T00:00:00', monthEnd + 'T23:59:59').first();
    const violationFines = Math.round((violRow?.fines || 0) * dailyRate * 100) / 100;

    const configAllowances = emp.housing_allowance + emp.transport_allowance + emp.other_allowance;
    const gross = emp.base_salary + configAllowances + (benefitsAllow?.total || 0) + (benefitsBonuses?.total || 0) + (rewardRow?.bonuses || 0) + (motivRow?.bonuses || 0);
    const deductions = (benefitsDeductions?.total || 0) + (benefitsAdvances?.total || 0) + absenceDeduction + lateDeduction + violationFines + (rewardRow?.deductions || 0) + (motivRow?.penalties || 0);
    const net = Math.round((gross - deductions) * 100) / 100;

    const details = {
      rewards: { bonuses: rewardRow?.bonuses || 0, deductions: rewardRow?.deductions || 0 },
      motivation: { bonuses: motivRow?.bonuses || 0, penalties: motivRow?.penalties || 0 },
      absence: { days: absenceDays, deduction: absenceDeduction },
      late: { count: lateCount, penaltyDays: latePenaltyDays, deduction: lateDeduction },
      violations: { fineCount: violRow?.fines || 0, deduction: violationFines },
    };

    await db.prepare(
      `INSERT INTO payslips (payroll_run_id, employee_id, employee_name, base_salary, housing_allowance, transport_allowance, other_allowance, benefits_allowances, benefits_bonuses, reward_bonus, motivation_bonus, benefits_deductions, benefits_advances, absence_days, absence_deduction, late_count, late_deduction, violation_fines, gross_salary, total_deductions, net_salary, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, eid, emp.name_ar || emp.name, emp.base_salary,
      emp.housing_allowance, emp.transport_allowance, emp.other_allowance,
      benefitsAllow?.total || 0, benefitsBonuses?.total || 0, rewardRow?.bonuses || 0, motivRow?.bonuses || 0,
      benefitsDeductions?.total || 0, benefitsAdvances?.total || 0, absenceDays, absenceDeduction,
      lateCount, lateDeduction, violationFines, gross, deductions, net, JSON.stringify(details), now
    ).run();

    totalBase += emp.base_salary;
    totalAllowances += configAllowances + (benefitsAllow?.total || 0);
    totalBonuses += (benefitsBonuses?.total || 0) + (rewardRow?.bonuses || 0) + (motivRow?.bonuses || 0);
    totalDeductions += (benefitsDeductions?.total || 0) + (rewardRow?.deductions || 0) + (motivRow?.penalties || 0) + violationFines;
    totalAdvances += (benefitsAdvances?.total || 0);
    totalPenalties += absenceDeduction + lateDeduction;
    totalNet += net;
  }

  await db.prepare(
    `UPDATE payroll_runs SET total_base=?, total_allowances=?, total_bonuses=?, total_deductions=?, total_advances=?, total_penalties=?, total_net=?, employee_count=?, updated_at=? WHERE id=?`
  ).bind(
    Math.round(totalBase * 100) / 100, Math.round(totalAllowances * 100) / 100,
    Math.round(totalBonuses * 100) / 100, Math.round(totalDeductions * 100) / 100,
    Math.round(totalAdvances * 100) / 100, Math.round(totalPenalties * 100) / 100,
    Math.round(totalNet * 100) / 100, employees.results.length, now, id
  ).run();

  await logActivity(db, {
    actor: user, action: 'PAYROLL_RECALCULATED', entityType: 'payroll_run', entityId: String(id),
    metadata: { month: run.month },
  });

  return c.json({ ok: true, employeeCount: employees.results.length });
});

// كشف مرتب فردي (payslip)
accountingRoutes.get('/payroll/payslip/:id', requireAccountingAccess, async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const slip = await db.prepare(`SELECT * FROM payslips WHERE id = ?`).bind(id).first();
  if (!slip) return jsonError(c, 404, 'كشف المرتب غير موجود', 'PAYSLIP_NOT_FOUND');

  const run = await db.prepare(`SELECT month, status FROM payroll_runs WHERE id = ?`).bind(slip.payroll_run_id).first();

  return c.json({ payslip: slip, run });
});
