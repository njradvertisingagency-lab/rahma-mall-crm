import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';

export const violationRoutes = new Hono();
violationRoutes.use('*', requireAuth);

const VIOLATION_TYPES = ['LATE', 'ABSENCE', 'MISCONDUCT', 'POLICY_BREACH', 'PERFORMANCE', 'OTHER'];
const SEVERITIES = ['MINOR', 'MODERATE', 'SEVERE'];
const ACTIONS = ['NONE', 'VERBAL_WARNING', 'WRITTEN_WARNING', 'SUSPENSION', 'FINE', 'TERMINATION_NOTICE'];

function rowToViolation(r) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    employeeNameAr: r.employee_name_ar,
    reportedBy: r.reported_by,
    violationType: r.violation_type,
    severity: r.severity,
    occurredAt: r.occurred_at,
    description: r.description,
    actionTaken: r.action_taken,
    actionNote: r.action_note,
    status: r.status,
    employeeComment: r.employee_comment,
    acknowledgedAt: r.acknowledged_at,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// قائمة المخالفات — قائد الفريق يرى الكل (مع فلترة اختيارية بالموظف/الحالة)،
// والموظف يرى مخالفاته فقط دائمًا بغض النظر عمّا يُرسله في الاستعلام.
violationRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const conds = [];
  const binds = [];
  if (user.role === 'employee') {
    conds.push('v.employee_id = ?');
    binds.push(user.employeeId);
  } else if (c.req.query('employeeId')) {
    conds.push('v.employee_id = ?');
    binds.push(Number(c.req.query('employeeId')));
  }
  if (c.req.query('status')) {
    conds.push('v.status = ?');
    binds.push(c.req.query('status'));
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(
      `SELECT v.*, e.name AS employee_name, e.name_ar AS employee_name_ar
       FROM employee_violations v JOIN employees e ON e.id = v.employee_id
       ${where} ORDER BY v.occurred_at DESC, v.created_at DESC LIMIT 200`
    )
    .bind(...binds)
    .all();
  return c.json({ violations: rows.results.map(rowToViolation) });
});

violationRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db
    .prepare(
      `SELECT v.*, e.name AS employee_name, e.name_ar AS employee_name_ar
       FROM employee_violations v JOIN employees e ON e.id = v.employee_id WHERE v.id = ?`
    )
    .bind(id)
    .first();
  if (!row) return jsonError(c, 404, 'المخالفة غير موجودة', 'NOT_FOUND');
  if (user.role === 'employee' && user.employeeId !== row.employee_id) {
    return jsonError(c, 403, 'يمكنك فقط عرض مخالفاتك الخاصة', 'FORBIDDEN_OWNERSHIP');
  }
  return c.json({ violation: rowToViolation(row) });
});

// تسجيل مخالفة جديدة — قائد الفريق فقط.
violationRoutes.post('/', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  const employeeId = Number(body.employeeId);
  if (!employeeId) return jsonError(c, 400, 'الموظف غير محدد', 'MISSING_EMPLOYEE');
  const violationType = String(body.violationType || '');
  if (!VIOLATION_TYPES.includes(violationType)) return jsonError(c, 400, 'نوع المخالفة غير صالح', 'INVALID_TYPE');
  const severity = String(body.severity || '');
  if (!SEVERITIES.includes(severity)) return jsonError(c, 400, 'درجة الخطورة غير صالحة', 'INVALID_SEVERITY');
  const occurredAt = String(body.occurredAt || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredAt)) return jsonError(c, 400, 'تاريخ الواقعة غير صالح', 'INVALID_DATE');
  const description = String(body.description || '').trim();
  if (!description) return jsonError(c, 400, 'وصف المخالفة مطلوب', 'MISSING_DESCRIPTION');
  const actionTaken = body.actionTaken ? String(body.actionTaken) : 'NONE';
  if (!ACTIONS.includes(actionTaken)) return jsonError(c, 400, 'الإجراء المتخذ غير صالح', 'INVALID_ACTION');

  const emp = await db.prepare(`SELECT id, user_id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const inserted = await db
    .prepare(
      `INSERT INTO employee_violations (employee_id, reported_by, violation_type, severity, occurred_at, description, action_taken, action_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .bind(employeeId, user.id, violationType, severity, occurredAt, description, actionTaken, body.actionNote ? String(body.actionNote).trim() : null)
    .first();

  await logActivity(db, { actor: user, action: 'VIOLATION_LOGGED', entityType: 'employee', entityId: String(employeeId), metadata: { violationType, severity, actionTaken } });
  if (emp.user_id) await broadcast(c.env, 'VIOLATION_LOGGED', { employeeId, violationId: inserted.id }, { scope: 'user', userId: emp.user_id });

  return c.json({ ok: true, violationId: inserted.id });
});

// تعديل مخالفة — قائد الفريق فقط، وطالما لسه لم يُقر بها الموظف.
violationRoutes.patch('/:id', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const row = await db.prepare(`SELECT * FROM employee_violations WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'المخالفة غير موجودة', 'NOT_FOUND');
  if (row.status !== 'OPEN') return jsonError(c, 400, 'لا يمكن تعديل مخالفة تم الاطلاع عليها أو إغلاقها', 'NOT_EDITABLE');

  const severity = body.severity !== undefined ? String(body.severity) : row.severity;
  if (!SEVERITIES.includes(severity)) return jsonError(c, 400, 'درجة الخطورة غير صالحة', 'INVALID_SEVERITY');
  const actionTaken = body.actionTaken !== undefined ? String(body.actionTaken) : row.action_taken;
  if (!ACTIONS.includes(actionTaken)) return jsonError(c, 400, 'الإجراء المتخذ غير صالح', 'INVALID_ACTION');
  const description = body.description !== undefined ? String(body.description).trim() : row.description;
  if (!description) return jsonError(c, 400, 'وصف المخالفة مطلوب', 'MISSING_DESCRIPTION');
  const actionNote = body.actionNote !== undefined ? (body.actionNote ? String(body.actionNote).trim() : null) : row.action_note;

  await db
    .prepare(`UPDATE employee_violations SET severity=?, action_taken=?, description=?, action_note=?, updated_at=? WHERE id=?`)
    .bind(severity, actionTaken, description, actionNote, nowIso(), id)
    .run();
  await logActivity(db, { actor: user, action: 'VIOLATION_UPDATED', entityType: 'employee', entityId: String(row.employee_id), metadata: { violationId: id } });
  return c.json({ ok: true });
});

// اطلاع الموظف على المخالفة (وإضافة تعليق/رد اختياري) — الموظف صاحب المخالفة فقط.
violationRoutes.post('/:id/acknowledge', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const row = await db.prepare(`SELECT * FROM employee_violations WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'المخالفة غير موجودة', 'NOT_FOUND');
  if (user.role === 'employee' && user.employeeId !== row.employee_id) {
    return jsonError(c, 403, 'يمكنك فقط الاطلاع على مخالفاتك الخاصة', 'FORBIDDEN_OWNERSHIP');
  }
  if (row.status !== 'OPEN') return jsonError(c, 400, 'تم الاطلاع على هذه المخالفة من قبل', 'ALREADY_ACKNOWLEDGED');

  await db
    .prepare(`UPDATE employee_violations SET status='ACKNOWLEDGED', employee_comment=?, acknowledged_at=?, updated_at=? WHERE id=?`)
    .bind(body.comment ? String(body.comment).trim() : null, nowIso(), nowIso(), id)
    .run();
  await logActivity(db, { actor: user, action: 'VIOLATION_ACKNOWLEDGED', entityType: 'employee', entityId: String(row.employee_id), metadata: { violationId: id } });
  await broadcast(c.env, 'VIOLATION_ACKNOWLEDGED', { violationId: id, employeeId: row.employee_id }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});

// إغلاق/حل المخالفة نهائيًا — قائد الفريق فقط.
violationRoutes.post('/:id/resolve', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const row = await db.prepare(`SELECT * FROM employee_violations WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'المخالفة غير موجودة', 'NOT_FOUND');
  if (row.status === 'RESOLVED') return jsonError(c, 400, 'تم إغلاق هذه المخالفة من قبل', 'ALREADY_RESOLVED');

  await db.prepare(`UPDATE employee_violations SET status='RESOLVED', resolved_at=?, updated_at=? WHERE id=?`).bind(nowIso(), nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'VIOLATION_RESOLVED', entityType: 'employee', entityId: String(row.employee_id), metadata: { violationId: id } });
  return c.json({ ok: true });
});
