import { Hono } from 'hono';
import { requireAuth, requireHR } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';

export const trainingRoutes = new Hono();
trainingRoutes.use('*', requireAuth);

const TYPES = ['COURSE', 'WORKSHOP', 'CERTIFICATION', 'ONLINE', 'OTHER'];
const STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

function rowToTraining(r) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    employeeNameAr: r.employee_name_ar,
    title: r.title,
    trainingType: r.training_type,
    provider: r.provider,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    certificateNote: r.certificate_note,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// قائمة التدريبات — قائد الفريق يرى الكل، الموظف يرى تدريباته فقط.
trainingRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const conds = [];
  const binds = [];
  if (user.role === 'employee') {
    conds.push('t.employee_id = ?');
    binds.push(user.employeeId);
  } else if (c.req.query('employeeId')) {
    conds.push('t.employee_id = ?');
    binds.push(Number(c.req.query('employeeId')));
  }
  if (c.req.query('status')) {
    conds.push('t.status = ?');
    binds.push(c.req.query('status'));
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(
      `SELECT t.*, e.name AS employee_name, e.name_ar AS employee_name_ar
       FROM employee_trainings t JOIN employees e ON e.id = t.employee_id
       ${where} ORDER BY COALESCE(t.start_date, t.created_at) DESC LIMIT 200`
    )
    .bind(...binds)
    .all();
  return c.json({ trainings: rows.results.map(rowToTraining) });
});

// إضافة تدريب جديد — قائد الفريق فقط.
trainingRoutes.post('/', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  const employeeId = Number(body.employeeId);
  if (!employeeId) return jsonError(c, 400, 'الموظف غير محدد', 'MISSING_EMPLOYEE');
  const title = String(body.title || '').trim();
  if (!title) return jsonError(c, 400, 'عنوان التدريب مطلوب', 'MISSING_TITLE');
  const trainingType = String(body.trainingType || '');
  if (!TYPES.includes(trainingType)) return jsonError(c, 400, 'نوع التدريب غير صالح', 'INVALID_TYPE');

  const emp = await db.prepare(`SELECT id, user_id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const inserted = await db
    .prepare(
      `INSERT INTO employee_trainings (employee_id, title, training_type, provider, start_date, end_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .bind(
      employeeId,
      title,
      trainingType,
      body.provider ? String(body.provider).trim() : null,
      body.startDate || null,
      body.endDate || null,
      body.notes ? String(body.notes).trim() : null,
      user.id
    )
    .first();

  await logActivity(db, { actor: user, action: 'TRAINING_ADDED', entityType: 'employee', entityId: String(employeeId), metadata: { title, trainingType } });
  if (emp.user_id) await broadcast(c.env, 'TRAINING_ADDED', { employeeId, trainingId: inserted.id }, { scope: 'user', userId: emp.user_id });
  return c.json({ ok: true, trainingId: inserted.id });
});

// تعديل حالة/بيانات تدريب — قائد الفريق فقط.
trainingRoutes.patch('/:id', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const row = await db.prepare(`SELECT * FROM employee_trainings WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'التدريب غير موجود', 'NOT_FOUND');

  const status = body.status !== undefined ? String(body.status) : row.status;
  if (!STATUSES.includes(status)) return jsonError(c, 400, 'حالة غير صالحة', 'INVALID_STATUS');
  const title = body.title !== undefined ? String(body.title).trim() : row.title;
  if (!title) return jsonError(c, 400, 'عنوان التدريب مطلوب', 'MISSING_TITLE');

  await db
    .prepare(
      `UPDATE employee_trainings SET title=?, provider=?, start_date=?, end_date=?, status=?, certificate_note=?, notes=?, updated_at=? WHERE id=?`
    )
    .bind(
      title,
      body.provider !== undefined ? (body.provider ? String(body.provider).trim() : null) : row.provider,
      body.startDate !== undefined ? body.startDate : row.start_date,
      body.endDate !== undefined ? body.endDate : row.end_date,
      status,
      body.certificateNote !== undefined ? (body.certificateNote ? String(body.certificateNote).trim() : null) : row.certificate_note,
      body.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : row.notes,
      nowIso(),
      id
    )
    .run();
  await logActivity(db, { actor: user, action: 'TRAINING_UPDATED', entityType: 'employee', entityId: String(row.employee_id), metadata: { trainingId: id, status } });
  return c.json({ ok: true });
});
