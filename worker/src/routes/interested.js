import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { isMeaningfulNote } from '../lib/notequality.js';

export const interestedRoutes = new Hono();
interestedRoutes.use('*', requireAuth);

// "عملاء تم الاتفاق": العملاء اللي حالتهم "INTERESTED" وعليهم ملاحظة حقيقية
// اتكتبت بعد ما العميل اتوزّع للموظف. الموظف بيشوف عملاءه بس؛ قائد الفريق بيشوف الكل.
interestedRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const isEmp = user.role === 'employee';
  const empFilter = isEmp ? 'AND c.assigned_employee_id = ?' : '';
  const binds = isEmp ? [user.employeeId] : [];

  const custs = (await db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.normalized_phone, c.priority, c.assigned_at, c.updated_at,
              c.assigned_employee_id, e.name AS employee_name
       FROM customers c LEFT JOIN employees e ON e.id = c.assigned_employee_id
       WHERE c.status = 'INTERESTED' AND c.archived = 0 ${empFilter}
       ORDER BY c.updated_at DESC LIMIT 500`
    )
    .bind(...binds)
    .all()).results;
  if (custs.length === 0) return c.json({ customers: [], needNote: [] });

  const notes = (await db
    .prepare(
      `SELECT n.customer_id, n.note, n.created_at
       FROM customer_notes n JOIN customers c ON c.id = n.customer_id
       WHERE c.status = 'INTERESTED' AND c.archived = 0 ${empFilter}
         AND (c.assigned_at IS NULL OR n.created_at >= c.assigned_at)
       ORDER BY n.created_at DESC`
    )
    .bind(...binds)
    .all()).results;

  const goodByCustomer = new Map();
  for (const n of notes) {
    if (!goodByCustomer.has(n.customer_id) && isMeaningfulNote(n.note)) goodByCustomer.set(n.customer_id, n);
  }
  const mapRow = (r, n) => ({
    id: r.id, name: r.name, phone: r.phone, normalizedPhone: r.normalized_phone, priority: r.priority,
    employeeId: r.assigned_employee_id, employeeName: r.employee_name,
    updatedAt: r.updated_at, note: n ? n.note : null, noteAt: n ? n.created_at : null,
  });
  const customers = [];
  const needNote = [];
  for (const r of custs) {
    const n = goodByCustomer.get(r.id);
    if (n) customers.push(mapRow(r, n)); else needNote.push(mapRow(r, null));
  }
  return c.json({ customers, needNote });
});
