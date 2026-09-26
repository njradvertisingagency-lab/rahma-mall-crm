import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';

export const benefitRoutes = new Hono();
benefitRoutes.use('*', requireAuth);

const TYPES = ['BONUS', 'ALLOWANCE', 'DEDUCTION', 'ADVANCE', 'OTHER'];

function rowToBenefit(r) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    employeeNameAr: r.employee_name_ar,
    benefitType: r.benefit_type,
    amount: r.amount,
    description: r.description,
    effectiveDate: r.effective_date,
    status: r.status,
    notes: r.notes,
    approvedAt: r.approved_at,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };
}

// قائمة المزايا/المكافآت المالية — قائد الفريق يرى الكل، الموظف يرى بياناته فقط.
// كل المبالغ يدخلها قائد الفريق يدويًا دائمًا — النظام لا يقترح أو يحسب أي
// رقم مالي تلقائيًا.
benefitRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const conds = [];
  const binds = [];
  if (user.role === 'employee') {
    conds.push('b.employee_id = ?');
    binds.push(user.employeeId);
  } else if (c.req.query('employeeId')) {
    conds.push('b.employee_id = ?');
    binds.push(Number(c.req.query('employeeId')));
  }
  if (c.req.query('status')) {
    conds.push('b.status = ?');
    binds.push(c.req.query('status'));
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(
      `SELECT b.*, e.name AS employee_name, e.name_ar AS employee_name_ar
       FROM employee_benefits b JOIN employees e ON e.id = b.employee_id
       ${where} ORDER BY b.effective_date DESC, b.created_at DESC LIMIT 200`
    )
    .bind(...binds)
    .all();
  return c.json({ benefits: rows.results.map(rowToBenefit) });
});

// تسجيل مكافأة/خصم/سلفة جديدة — قائد الفريق فقط. المبلغ يُدخل يدويًا من
// قائد الفريق نفسه ولا يُحسب أو يُقترح تلقائيًا.
benefitRoutes.post('/', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  const employeeId = Number(body.employeeId);
  if (!employeeId) return jsonError(c, 400, 'الموظف غير محدد', 'MISSING_EMPLOYEE');
  const benefitType = String(body.benefitType || '');
  if (!TYPES.includes(benefitType)) return jsonError(c, 400, 'نوع الحركة غير صالح', 'INVALID_TYPE');
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return jsonError(c, 400, 'المبلغ غير صالح', 'INVALID_AMOUNT');
  const effectiveDate = String(body.effectiveDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return jsonError(c, 400, 'التاريخ غير صالح', 'INVALID_DATE');

  const emp = await db.prepare(`SELECT id, user_id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const inserted = await db
    .prepare(
      `INSERT INTO employee_benefits (employee_id, benefit_type, amount, description, effective_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .bind(employeeId, benefitType, amount, body.description ? String(body.description).trim() : null, effectiveDate, body.notes ? String(body.notes).trim() : null, user.id)
    .first();

  await logActivity(db, { actor: user, action: 'BENEFIT_LOGGED', entityType: 'employee', entityId: String(employeeId), metadata: { benefitType, amount } });
  if (emp.user_id) await broadcast(c.env, 'BENEFIT_LOGGED', { employeeId, benefitId: inserted.id }, { scope: 'user', userId: emp.user_id });
  return c.json({ ok: true, benefitId: inserted.id });
});

// اعتماد الحركة — قائد الفريق فقط.
benefitRoutes.post('/:id/approve', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db.prepare(`SELECT * FROM employee_benefits WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'الحركة غير موجودة', 'NOT_FOUND');
  if (row.status !== 'PENDING') return jsonError(c, 400, 'تم البت في هذه الحركة من قبل', 'ALREADY_DECIDED');
  await db.prepare(`UPDATE employee_benefits SET status='APPROVED', approved_by=?, approved_at=?, updated_at=? WHERE id=?`).bind(user.id, nowIso(), nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'BENEFIT_APPROVED', entityType: 'employee', entityId: String(row.employee_id), metadata: { benefitId: id } });
  return c.json({ ok: true });
});

benefitRoutes.post('/:id/reject', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db.prepare(`SELECT * FROM employee_benefits WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'الحركة غير موجودة', 'NOT_FOUND');
  if (row.status !== 'PENDING') return jsonError(c, 400, 'تم البت في هذه الحركة من قبل', 'ALREADY_DECIDED');
  await db.prepare(`UPDATE employee_benefits SET status='REJECTED', approved_by=?, approved_at=?, updated_at=? WHERE id=?`).bind(user.id, nowIso(), nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'BENEFIT_REJECTED', entityType: 'employee', entityId: String(row.employee_id), metadata: { benefitId: id } });
  return c.json({ ok: true });
});

// تسجيل الصرف الفعلي — قائد الفريق فقط، بعد الاعتماد.
benefitRoutes.post('/:id/mark-paid', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db.prepare(`SELECT * FROM employee_benefits WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'الحركة غير موجودة', 'NOT_FOUND');
  if (row.status !== 'APPROVED') return jsonError(c, 400, 'لازم اعتماد الحركة أولاً', 'NOT_APPROVED');
  await db.prepare(`UPDATE employee_benefits SET status='PAID', paid_at=?, updated_at=? WHERE id=?`).bind(nowIso(), nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'BENEFIT_PAID', entityType: 'employee', entityId: String(row.employee_id), metadata: { benefitId: id, amount: row.amount } });
  return c.json({ ok: true });
});
