import { Hono } from 'hono';
import { requireAuth, requireHR } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';
import { getCairoNow } from '../lib/workhours.js';

export const leaveRoutes = new Hono();
leaveRoutes.use('*', requireAuth);

const LEAVE_TYPES = ['ANNUAL', 'SICK', 'EMERGENCY', 'UNPAID'];

function inclusiveDayCount(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return !(aEnd < bStart || aStart > bEnd);
}

async function computeAnnualBalance(db, employeeId, year) {
  const balRow = await db.prepare(`SELECT annual_allocation, carried_over FROM leave_balances WHERE employee_id = ?`).bind(employeeId).first();
  const allocation = balRow?.annual_allocation ?? 21;
  const carriedOver = balRow?.carried_over ?? 0;
  const used = await db
    .prepare(
      `SELECT COALESCE(SUM(days_count), 0) AS n FROM leave_requests
       WHERE employee_id = ? AND leave_type = 'ANNUAL' AND status = 'APPROVED' AND substr(start_date, 1, 4) = ?`
    )
    .bind(employeeId, String(year))
    .first();
  const total = allocation + carriedOver;
  return { allocation, carriedOver, total, used: used.n, remaining: total - used.n };
}

// قائمة طلبات الإجازة — قائد الفريق يرى الكل (مع فلترة اختيارية بالحالة/الموظف)،
// والموظف يرى طلباته فقط دائمًا بغض النظر عمّا يُرسله في الاستعلام.
leaveRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const status = c.req.query('status');
  const conds = [];
  const binds = [];
  if (user.role === 'employee') {
    conds.push('lr.employee_id = ?');
    binds.push(user.employeeId);
  } else if (c.req.query('employeeId')) {
    conds.push('lr.employee_id = ?');
    binds.push(Number(c.req.query('employeeId')));
  }
  if (status) {
    conds.push('lr.status = ?');
    binds.push(status);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(
      `SELECT lr.*, e.name AS employee_name, e.name_ar AS employee_name_ar
       FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
       ${where} ORDER BY lr.created_at DESC LIMIT 200`
    )
    .bind(...binds)
    .all();
  const requests = rows.results.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    employeeNameAr: r.employee_name_ar,
    leaveType: r.leave_type,
    startDate: r.start_date,
    endDate: r.end_date,
    daysCount: r.days_count,
    reason: r.reason,
    status: r.status,
    decisionNote: r.decision_note,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  }));
  return c.json({ requests });
});

// رصيد الإجازة السنوية لموظف — الموظف يرى رصيده فقط، قائد الفريق يرى أي موظف.
leaveRoutes.get('/balance/:employeeId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const employeeId = Number(c.req.param('employeeId'));
  if (user.role === 'employee' && user.employeeId !== employeeId) {
    return jsonError(c, 403, 'يمكنك فقط عرض رصيدك الخاص', 'FORBIDDEN_OWNERSHIP');
  }
  const year = c.req.query('year') || String(getCairoNow().dateStr.slice(0, 4));
  const balance = await computeAnnualBalance(db, employeeId, year);
  return c.json({ balance: { ...balance, year: Number(year) } });
});

// تعديل الرصيد السنوي المخصص/المرحّل لموظف — قائد الفريق فقط.
leaveRoutes.patch('/balance/:employeeId', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const employeeId = Number(c.req.param('employeeId'));
  const body = await c.req.json().catch(() => ({}));
  const allocation = Number(body.annualAllocation);
  const carriedOver = Number(body.carriedOver) || 0;
  if (!Number.isFinite(allocation) || allocation < 0) return jsonError(c, 400, 'الرصيد السنوي غير صالح', 'INVALID_ALLOCATION');

  const emp = await db.prepare(`SELECT id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  await db
    .prepare(
      `INSERT INTO leave_balances (employee_id, annual_allocation, carried_over, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(employee_id) DO UPDATE SET annual_allocation = excluded.annual_allocation, carried_over = excluded.carried_over, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
    .bind(employeeId, allocation, carriedOver, user.id, nowIso())
    .run();
  await logActivity(db, { actor: user, action: 'LEAVE_BALANCE_UPDATED', entityType: 'employee', entityId: String(employeeId), metadata: { allocation, carriedOver } });
  return c.json({ ok: true });
});

// تقديم طلب إجازة — الموظف لنفسه، أو قائد الفريق نيابةً عن أي موظف.
leaveRoutes.post('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  let employeeId = Number(body.employeeId) || user.employeeId;
  if (user.role === 'employee') {
    employeeId = user.employeeId; // موظف عادي لا يقدر يطلب نيابة عن غيره مهما أرسل
  }
  if (!employeeId) return jsonError(c, 400, 'الموظف غير محدد', 'MISSING_EMPLOYEE');

  const leaveType = String(body.leaveType || '');
  if (!LEAVE_TYPES.includes(leaveType)) return jsonError(c, 400, 'نوع الإجازة غير صالح', 'INVALID_LEAVE_TYPE');
  const startDate = String(body.startDate || '');
  const endDate = String(body.endDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return jsonError(c, 400, 'تاريخ غير صالح', 'INVALID_DATE');
  }
  if (endDate < startDate) return jsonError(c, 400, 'تاريخ النهاية قبل تاريخ البداية', 'INVALID_RANGE');

  const daysCount = inclusiveDayCount(startDate, endDate);
  const emp = await db.prepare(`SELECT id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const inserted = await db
    .prepare(
      `INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days_count, reason, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .bind(employeeId, leaveType, startDate, endDate, daysCount, (body.reason ? String(body.reason).trim() : null), user.id)
    .first();

  // تنبيه (مش منع) لو موظف تاني طلب إجازة (معلّقة أو معتمدة) بتتداخل في نفس
  // الفترة — عشان قائد الفريق ياخد بالباله موضوع تغطية الشغل قبل الموافقة.
  const overlapping = await db
    .prepare(
      `SELECT lr.id, lr.employee_id, e.name AS employee_name, lr.start_date, lr.end_date
       FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
       WHERE lr.employee_id != ? AND lr.status IN ('PENDING','APPROVED')
         AND NOT (lr.end_date < ? OR lr.start_date > ?)`
    )
    .bind(employeeId, startDate, endDate)
    .all();

  await logActivity(db, { actor: user, action: 'LEAVE_REQUESTED', entityType: 'employee', entityId: String(employeeId), metadata: { leaveType, startDate, endDate, daysCount } });
  await broadcast(c.env, 'LEAVE_REQUESTED', { employeeId, requestId: inserted.id }, { scope: 'role', role: 'team_leader' });

  return c.json({
    ok: true,
    requestId: inserted.id,
    overlapWarning: overlapping.results.length
      ? overlapping.results.map((r) => ({ employeeName: r.employee_name, startDate: r.start_date, endDate: r.end_date }))
      : null,
  });
});

// الموافقة على طلب — قائد الفريق فقط. لو إجازة سنوية وهتتجاوز الرصيد المتاح
// يرجع خطأ يطلب تأكيد صريح (force=true) بدل ما يوافق تلقائيًا على تجاوز الرصيد.
leaveRoutes.post('/:id/approve', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const reqRow = await db.prepare(`SELECT * FROM leave_requests WHERE id = ?`).bind(id).first();
  if (!reqRow) return jsonError(c, 404, 'الطلب غير موجود', 'NOT_FOUND');
  if (reqRow.status !== 'PENDING') return jsonError(c, 400, 'تم البت في هذا الطلب من قبل', 'ALREADY_DECIDED');

  if (reqRow.leave_type === 'ANNUAL' && !body.force) {
    const year = reqRow.start_date.slice(0, 4);
    const balance = await computeAnnualBalance(db, reqRow.employee_id, year);
    if (reqRow.days_count > balance.remaining) {
      return jsonError(c, 409, `رصيد الموظف المتبقي ${balance.remaining} يوم فقط — أرسل تأكيد صريح للموافقة رغم ذلك`, 'EXCEEDS_BALANCE');
    }
  }

  await db.prepare(`UPDATE leave_requests SET status = 'APPROVED', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`)
    .bind(user.id, nowIso(), body.decisionNote ? String(body.decisionNote).trim() : null, nowIso(), id)
    .run();
  await logActivity(db, { actor: user, action: 'LEAVE_APPROVED', entityType: 'employee', entityId: String(reqRow.employee_id), metadata: { requestId: id } });
  const emp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(reqRow.employee_id).first();
  if (emp?.user_id) await broadcast(c.env, 'LEAVE_DECIDED', { requestId: id, status: 'APPROVED' }, { scope: 'user', userId: emp.user_id });
  return c.json({ ok: true });
});

leaveRoutes.post('/:id/reject', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const decisionNote = body.decisionNote ? String(body.decisionNote).trim() : '';
  if (!decisionNote) return jsonError(c, 400, 'سبب الرفض مطلوب', 'MISSING_REASON');

  const reqRow = await db.prepare(`SELECT * FROM leave_requests WHERE id = ?`).bind(id).first();
  if (!reqRow) return jsonError(c, 404, 'الطلب غير موجود', 'NOT_FOUND');
  if (reqRow.status !== 'PENDING') return jsonError(c, 400, 'تم البت في هذا الطلب من قبل', 'ALREADY_DECIDED');

  await db.prepare(`UPDATE leave_requests SET status = 'REJECTED', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`)
    .bind(user.id, nowIso(), decisionNote, nowIso(), id)
    .run();
  await logActivity(db, { actor: user, action: 'LEAVE_REJECTED', entityType: 'employee', entityId: String(reqRow.employee_id), metadata: { requestId: id, decisionNote } });
  const emp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(reqRow.employee_id).first();
  if (emp?.user_id) await broadcast(c.env, 'LEAVE_DECIDED', { requestId: id, status: 'REJECTED' }, { scope: 'user', userId: emp.user_id });
  return c.json({ ok: true });
});

// إلغاء طلب — الموظف يقدر يلغي طلبه المعلّق فقط، قائد الفريق يقدر يلغي أي طلب.
leaveRoutes.post('/:id/cancel', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const reqRow = await db.prepare(`SELECT * FROM leave_requests WHERE id = ?`).bind(id).first();
  if (!reqRow) return jsonError(c, 404, 'الطلب غير موجود', 'NOT_FOUND');
  if (user.role === 'employee') {
    if (user.employeeId !== reqRow.employee_id) return jsonError(c, 403, 'يمكنك فقط إلغاء طلباتك الخاصة', 'FORBIDDEN_OWNERSHIP');
    if (reqRow.status !== 'PENDING') return jsonError(c, 400, 'لا يمكن إلغاء طلب تم البت فيه بالفعل', 'ALREADY_DECIDED');
  }

  await db.prepare(`UPDATE leave_requests SET status = 'CANCELLED', updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'LEAVE_CANCELLED', entityType: 'employee', entityId: String(reqRow.employee_id), metadata: { requestId: id } });
  await broadcast(c.env, 'LEAVE_DECIDED', { requestId: id, status: 'CANCELLED' }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});
