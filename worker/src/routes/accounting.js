import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { logActivity, jsonError, nowIso } from '../lib/db.js';

export const accountingRoutes = new Hono();
accountingRoutes.use('*', requireAuth);

// ---------------------------------------------------------------------------
// صلاحيات قسم الحسابات
// ---------------------------------------------------------------------------
// - موظفو الحسابات (department='accounting') + المالك (isOwner): تحكم كامل
//   في الملفات وأذونات الحركة (إنشاء/تعديل/حذف).
// - أ. هاني (المالك) هو الوحيد اللي يقدر يعدّل ويحرّك مع الحسابات من برّا
//   القسم نفسه.
// - قائد الفريق / HR: يشوفوا حركة الملفات فقط (قراءة بدون أي تعديل).
// - موظف خدمة العملاء العادي: لا يصل لأي شيء في الحسابات.
// ---------------------------------------------------------------------------

function isAccountingUser(user) {
  return user.isOwner || user.department === 'accounting';
}

function canViewMovements(user) {
  return user.isOwner || user.department === 'accounting' || user.role === 'team_leader' || user.isHr;
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

  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM client_files cf WHERE ${where}`).bind(...params).first();
  const rows = await db.prepare(
    `SELECT cf.*, u.display_name AS created_by_name
     FROM client_files cf
     LEFT JOIN users u ON u.id = cf.created_by
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
    `SELECT cf.*, u.display_name AS created_by_name
     FROM client_files cf LEFT JOIN users u ON u.id = cf.created_by
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

  return c.json({
    byStatus: byStatus.results,
    byLocation: byLocation.results,
    totalMovements: totalMovements.cnt,
    todayMovements: todayMovements.cnt,
  });
});
