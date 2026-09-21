// "My Favorites" — a per-user shortlist of customers to jump back to
// quickly, without digging through the full filtered list. Every user
// (Team Leader or employee) keeps their own list.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { jsonError, nowIso } from '../lib/db.js';

export const favoriteRoutes = new Hono();
favoriteRoutes.use('*', requireAuth);

favoriteRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT f.customer_id, f.created_at, c.name, c.phone, c.status, c.priority, c.assigned_employee_id, e.name AS employee_name
       FROM favorites f JOIN customers c ON c.id = f.customer_id LEFT JOIN employees e ON e.id = c.assigned_employee_id
       WHERE f.user_id = ? ORDER BY f.created_at DESC`
    )
    .bind(user.id)
    .all();
  return c.json({
    favorites: rows.results.map((r) => ({
      customerId: r.customer_id, name: r.name, phone: r.phone, status: r.status, priority: r.priority,
      assignedEmployeeName: r.employee_name, addedAt: r.created_at,
    })),
  });
});

favoriteRoutes.get('/:customerId/check', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const row = await db.prepare(`SELECT 1 AS x FROM favorites WHERE user_id = ? AND customer_id = ?`).bind(user.id, c.req.param('customerId')).first();
  return c.json({ isFavorite: !!row });
});

favoriteRoutes.post('/:customerId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const customerId = c.req.param('customerId');
  const customer = await db.prepare(`SELECT id, assigned_employee_id FROM customers WHERE id = ?`).bind(customerId).first();
  if (!customer) return jsonError(c, 404, 'العميل غير موجود', 'NOT_FOUND');
  if (user.role === 'employee' && customer.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'هذا ليس عميلك', 'FORBIDDEN_OWNERSHIP');
  }
  await db.prepare(`INSERT OR IGNORE INTO favorites (user_id, customer_id) VALUES (?, ?)`).bind(user.id, customerId).run();
  return c.json({ ok: true }, 201);
});

favoriteRoutes.delete('/:customerId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  await db.prepare(`DELETE FROM favorites WHERE user_id = ? AND customer_id = ?`).bind(user.id, c.req.param('customerId')).run();
  return c.json({ ok: true });
});
