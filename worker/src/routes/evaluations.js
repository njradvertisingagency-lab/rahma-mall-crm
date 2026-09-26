import { Hono } from 'hono';
import { requireAuth, requireHR } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';

export const evaluationRoutes = new Hono();
evaluationRoutes.use('*', requireAuth);

const CRITERIA = ['quality', 'punctuality', 'teamwork', 'communication', 'sales'];

function scoreColumn(key) {
  return `${key}_score`;
}

function computeOverall(scores) {
  const sum = CRITERIA.reduce((acc, k) => acc + scores[k], 0);
  return Math.round((sum / CRITERIA.length) * 100) / 100;
}

function rowToEvaluation(r) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    employeeNameAr: r.employee_name_ar,
    evaluatorId: r.evaluator_id,
    period: r.period,
    scores: {
      quality: r.quality_score,
      punctuality: r.punctuality_score,
      teamwork: r.teamwork_score,
      communication: r.communication_score,
      sales: r.sales_score,
    },
    overallScore: r.overall_score,
    strengths: r.strengths,
    improvements: r.improvements,
    status: r.status,
    employeeComment: r.employee_comment,
    acknowledgedAt: r.acknowledged_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// قائمة التقييمات — قائد الفريق يرى الكل (مع فلترة اختيارية بالموظف/الفترة)،
// والموظف يرى تقييماته فقط دائمًا بغض النظر عمّا يُرسله في الاستعلام.
evaluationRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const conds = [];
  const binds = [];
  if (user.role === 'employee') {
    conds.push('ev.employee_id = ?');
    binds.push(user.employeeId);
  } else if (c.req.query('employeeId')) {
    conds.push('ev.employee_id = ?');
    binds.push(Number(c.req.query('employeeId')));
  }
  if (c.req.query('period')) {
    conds.push('ev.period = ?');
    binds.push(c.req.query('period'));
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(
      `SELECT ev.*, e.name AS employee_name, e.name_ar AS employee_name_ar
       FROM employee_evaluations ev JOIN employees e ON e.id = ev.employee_id
       ${where} ORDER BY ev.created_at DESC LIMIT 200`
    )
    .bind(...binds)
    .all();
  return c.json({ evaluations: rows.results.map(rowToEvaluation) });
});

evaluationRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db
    .prepare(
      `SELECT ev.*, e.name AS employee_name, e.name_ar AS employee_name_ar
       FROM employee_evaluations ev JOIN employees e ON e.id = ev.employee_id WHERE ev.id = ?`
    )
    .bind(id)
    .first();
  if (!row) return jsonError(c, 404, 'التقييم غير موجود', 'NOT_FOUND');
  if (user.role === 'employee' && user.employeeId !== row.employee_id) {
    return jsonError(c, 403, 'يمكنك فقط عرض تقييماتك الخاصة', 'FORBIDDEN_OWNERSHIP');
  }
  return c.json({ evaluation: rowToEvaluation(row) });
});

// إنشاء تقييم دوري جديد لموظف — قائد الفريق فقط.
evaluationRoutes.post('/', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  const employeeId = Number(body.employeeId);
  if (!employeeId) return jsonError(c, 400, 'الموظف غير محدد', 'MISSING_EMPLOYEE');
  const period = String(body.period || '').trim();
  if (!period) return jsonError(c, 400, 'الفترة (مثال: 2026-09) مطلوبة', 'MISSING_PERIOD');

  const scores = {};
  for (const key of CRITERIA) {
    const v = Number(body.scores?.[key]);
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      return jsonError(c, 400, `تقييم "${key}" لازم يكون رقم صحيح من 1 إلى 5`, 'INVALID_SCORE');
    }
    scores[key] = v;
  }

  const emp = await db.prepare(`SELECT id, user_id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const overall = computeOverall(scores);
  const inserted = await db
    .prepare(
      `INSERT INTO employee_evaluations
         (employee_id, evaluator_id, period, quality_score, punctuality_score, teamwork_score, communication_score, sales_score, overall_score, strengths, improvements)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .bind(
      employeeId,
      user.id,
      period,
      scores.quality,
      scores.punctuality,
      scores.teamwork,
      scores.communication,
      scores.sales,
      overall,
      body.strengths ? String(body.strengths).trim() : null,
      body.improvements ? String(body.improvements).trim() : null
    )
    .first();

  await logActivity(db, { actor: user, action: 'EVALUATION_CREATED', entityType: 'employee', entityId: String(employeeId), metadata: { period, overall } });
  if (emp.user_id) await broadcast(c.env, 'EVALUATION_CREATED', { employeeId, evaluationId: inserted.id }, { scope: 'user', userId: emp.user_id });

  return c.json({ ok: true, evaluationId: inserted.id, overallScore: overall });
});

// تعديل تقييم — قائد الفريق فقط، وطالما لسه ما اطّلعش عليه الموظف (لم يُقر بعد).
evaluationRoutes.patch('/:id', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const row = await db.prepare(`SELECT * FROM employee_evaluations WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'التقييم غير موجود', 'NOT_FOUND');
  if (row.status === 'ACKNOWLEDGED') return jsonError(c, 400, 'لا يمكن تعديل تقييم تم الاطلاع عليه من الموظف', 'ALREADY_ACKNOWLEDGED');

  const scores = {};
  for (const key of CRITERIA) {
    const raw = body.scores?.[key];
    const v = raw === undefined ? row[scoreColumn(key)] : Number(raw);
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      return jsonError(c, 400, `تقييم "${key}" لازم يكون رقم صحيح من 1 إلى 5`, 'INVALID_SCORE');
    }
    scores[key] = v;
  }
  const overall = computeOverall(scores);
  const strengths = body.strengths !== undefined ? (body.strengths ? String(body.strengths).trim() : null) : row.strengths;
  const improvements = body.improvements !== undefined ? (body.improvements ? String(body.improvements).trim() : null) : row.improvements;

  await db
    .prepare(
      `UPDATE employee_evaluations SET quality_score=?, punctuality_score=?, teamwork_score=?, communication_score=?, sales_score=?, overall_score=?, strengths=?, improvements=?, updated_at=? WHERE id=?`
    )
    .bind(scores.quality, scores.punctuality, scores.teamwork, scores.communication, scores.sales, overall, strengths, improvements, nowIso(), id)
    .run();
  await logActivity(db, { actor: user, action: 'EVALUATION_UPDATED', entityType: 'employee', entityId: String(row.employee_id), metadata: { evaluationId: id } });
  return c.json({ ok: true, overallScore: overall });
});

// اطلاع الموظف على تقييمه (وإضافة تعليق اختياري) — الموظف صاحب التقييم فقط.
evaluationRoutes.post('/:id/acknowledge', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const row = await db.prepare(`SELECT * FROM employee_evaluations WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'التقييم غير موجود', 'NOT_FOUND');
  if (user.role === 'employee' && user.employeeId !== row.employee_id) {
    return jsonError(c, 403, 'يمكنك فقط الاطلاع على تقييماتك الخاصة', 'FORBIDDEN_OWNERSHIP');
  }
  if (row.status === 'ACKNOWLEDGED') return jsonError(c, 400, 'تم الاطلاع على هذا التقييم من قبل', 'ALREADY_ACKNOWLEDGED');

  await db
    .prepare(`UPDATE employee_evaluations SET status='ACKNOWLEDGED', employee_comment=?, acknowledged_at=?, updated_at=? WHERE id=?`)
    .bind(body.comment ? String(body.comment).trim() : null, nowIso(), nowIso(), id)
    .run();
  await logActivity(db, { actor: user, action: 'EVALUATION_ACKNOWLEDGED', entityType: 'employee', entityId: String(row.employee_id), metadata: { evaluationId: id } });
  await broadcast(c.env, 'EVALUATION_ACKNOWLEDGED', { evaluationId: id, employeeId: row.employee_id }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});
