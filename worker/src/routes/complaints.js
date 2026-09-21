// Complaints log — deliberately separate from customer_notes so a real
// complaint can be tracked and rated on its own (rate per employee), rather
// than being buried among ordinary notes.
import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';

export const complaintRoutes = new Hono();
complaintRoutes.use('*', requireAuth);

complaintRoutes.post('/customers/:customerId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const customerId = c.req.param('customerId');
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text) return jsonError(c, 400, 'نص الشكوى مطلوب', 'EMPTY_COMPLAINT');

  const customer = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(customerId).first();
  if (!customer) return jsonError(c, 404, 'العميل غير موجود', 'NOT_FOUND');
  if (user.role === 'employee' && customer.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'هذا ليس عميلك', 'FORBIDDEN_OWNERSHIP');
  }

  const res = await db
    .prepare(`INSERT INTO complaints (customer_id, employee_id, created_by, text) VALUES (?, ?, ?, ?) RETURNING id, created_at`)
    .bind(customerId, customer.assigned_employee_id, user.id, text)
    .first();
  await logActivity(db, { actor: user, action: 'COMPLAINT_LOGGED', entityType: 'customer', entityId: customerId, metadata: { complaintId: res.id } });
  await broadcast(c.env, 'COMPLAINT_LOGGED', { customerId, employeeId: customer.assigned_employee_id }, { scope: 'role', role: 'team_leader' });

  return c.json({ complaint: { id: res.id, customerId, text, createdAt: res.created_at } }, 201);
});

complaintRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const q = c.req.query();
  const conds = [];
  const binds = [];
  if (user.role === 'employee') {
    conds.push('co.employee_id = ?');
    binds.push(user.employeeId);
  } else if (q.employeeId) {
    conds.push('co.employee_id = ?');
    binds.push(Number(q.employeeId));
  }
  if (q.customerId) {
    conds.push('co.customer_id = ?');
    binds.push(q.customerId);
  }
  if (q.dateFrom) {
    conds.push('co.created_at >= ?');
    binds.push(q.dateFrom);
  }
  if (q.dateTo) {
    conds.push('co.created_at <= ?');
    binds.push(q.dateTo);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(
      `SELECT co.*, e.name AS employee_name, c.name AS customer_name, c.phone AS customer_phone, u.display_name AS created_by_name
       FROM complaints co
       LEFT JOIN employees e ON e.id = co.employee_id
       LEFT JOIN customers c ON c.id = co.customer_id
       LEFT JOIN users u ON u.id = co.created_by
       ${where} ORDER BY co.created_at DESC LIMIT 300`
    )
    .bind(...binds)
    .all();
  return c.json({
    complaints: rows.results.map((r) => ({
      id: r.id, customerId: r.customer_id, customerName: r.customer_name, customerPhone: r.customer_phone,
      employeeId: r.employee_id, employeeName: r.employee_name, text: r.text, createdAt: r.created_at, createdByName: r.created_by_name,
    })),
  });
});

// Complaint rate per employee — complaints ÷ assigned customers, Team Leader view only.
complaintRoutes.get('/stats', requireRole('team_leader'), async (c) => {
  const db = c.env.DB;
  const employees = await db.prepare(`SELECT id, name FROM employees WHERE active = 1`).all();
  const stats = [];
  for (const emp of employees.results) {
    const [assignedRow, complaintsRow] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id = ? AND archived = 0`).bind(emp.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM complaints WHERE employee_id = ?`).bind(emp.id).first(),
    ]);
    stats.push({
      employeeId: emp.id,
      employeeName: emp.name,
      assigned: assignedRow.n,
      complaints: complaintsRow.n,
      rate: assignedRow.n > 0 ? Math.round((complaintsRow.n / assignedRow.n) * 1000) / 10 : 0,
    });
  }
  stats.sort((a, b) => b.complaints - a.complaints);
  return c.json({ stats });
});

complaintRoutes.delete('/:id', requireRole('team_leader'), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const existing = await db.prepare(`SELECT id FROM complaints WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'الشكوى غير موجودة', 'NOT_FOUND');
  await db.prepare(`DELETE FROM complaints WHERE id = ?`).bind(id).run();
  await logActivity(c.env.DB, { actor: c.get('user'), action: 'COMPLAINT_DELETED', entityType: 'complaint', entityId: String(id) });
  return c.json({ ok: true });
});
