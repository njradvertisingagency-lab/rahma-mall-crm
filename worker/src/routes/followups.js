import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logActivity, createNotification, broadcast, jsonError, nowIso } from '../lib/db.js';

export const followupRoutes = new Hono();
followupRoutes.use('*', requireAuth);

function followupRowToJson(row) {
  const now = Date.now();
  const scheduled = new Date(row.scheduled_for).getTime();
  let computedStatus = row.status;
  if (row.status === 'UPCOMING') {
    const isToday = new Date(row.scheduled_for).toDateString() === new Date().toDateString();
    if (scheduled < now) computedStatus = 'OVERDUE';
    else if (isToday) computedStatus = 'DUE';
  }
  return {
    id: row.id,
    customerId: row.customer_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name ?? null,
    scheduledFor: row.scheduled_for,
    reason: row.reason,
    notes: row.notes,
    status: computedStatus,
    storedStatus: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    cancelledAt: row.cancelled_at,
  };
}

// Create a follow-up for a given customer.
followupRoutes.post('/customers/:customerId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const customerId = c.req.param('customerId');
  const body = await c.req.json().catch(() => ({}));
  if (!body.scheduledFor) return jsonError(c, 400, 'scheduledFor (ISO date-time) is required', 'MISSING_SCHEDULE');

  const customer = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(customerId).first();
  if (!customer) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && customer.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }

  const employeeId = customer.assigned_employee_id;
  const res = await db
    .prepare(`INSERT INTO followups (customer_id, employee_id, scheduled_for, reason, notes, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at`)
    .bind(customerId, employeeId, body.scheduledFor, body.reason || null, body.notes || null, user.id)
    .first();
  await db.prepare(`UPDATE customers SET next_follow_up_at = ?, status = CASE WHEN status IN ('NEW','CALLING','NO_ANSWER','BUSY') THEN 'FOLLOW_UP' ELSE status END, updated_at = ? WHERE id = ?`).bind(body.scheduledFor, nowIso(), customerId).run();
  await logActivity(db, { actor: user, action: 'FOLLOWUP_CREATED', entityType: 'customer', entityId: customerId, metadata: { followupId: res.id, scheduledFor: body.scheduledFor } });
  await broadcast(c.env, 'FOLLOWUP_CREATED', { customerId, followupId: res.id, scheduledFor: body.scheduledFor }, { scope: 'role', role: 'team_leader' });

  return c.json({ followup: { id: res.id, customerId, scheduledFor: body.scheduledFor, createdAt: res.created_at } }, 201);
});

followupRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const q = c.req.query();
  const conds = [];
  const binds = [];

  if (user.role === 'employee') {
    conds.push('f.employee_id = ?');
    binds.push(user.employeeId);
  } else if (q.employeeId) {
    conds.push('f.employee_id = ?');
    binds.push(Number(q.employeeId));
  }
  if (q.status === 'COMPLETED' || q.status === 'CANCELLED') {
    conds.push('f.status = ?');
    binds.push(q.status);
  } else if (q.status === 'OPEN') {
    conds.push(`f.status = 'UPCOMING'`);
  }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(`SELECT f.*, e.name AS employee_name, c.name AS customer_name, c.phone AS customer_phone FROM followups f LEFT JOIN employees e ON e.id = f.employee_id LEFT JOIN customers c ON c.id = f.customer_id ${where} ORDER BY f.scheduled_for ASC LIMIT 500`)
    .bind(...binds)
    .all();

  let results = rows.results.map((r) => ({ ...followupRowToJson(r), customerName: r.customer_name, customerPhone: r.customer_phone }));
  if (q.overdue === 'true') results = results.filter((f) => f.status === 'OVERDUE');
  if (q.due === 'true') results = results.filter((f) => f.status === 'DUE');
  return c.json({ followups: results });
});

followupRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const existing = await db.prepare(`SELECT * FROM followups WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Follow-up not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.employee_id !== user.employeeId) return jsonError(c, 403, 'Not your follow-up', 'FORBIDDEN_OWNERSHIP');
  if (existing.status !== 'UPCOMING') return jsonError(c, 400, 'Only open follow-ups can be edited', 'NOT_EDITABLE');

  const fields = [];
  const binds = [];
  if (body.scheduledFor) {
    fields.push('scheduled_for = ?');
    binds.push(body.scheduledFor);
  }
  if ('reason' in body) {
    fields.push('reason = ?');
    binds.push(body.reason);
  }
  if ('notes' in body) {
    fields.push('notes = ?');
    binds.push(body.notes);
  }
  if (fields.length === 0) return jsonError(c, 400, 'No fields to update', 'NO_FIELDS');
  binds.push(id);
  await db.prepare(`UPDATE followups SET ${fields.join(', ')} WHERE id = ?`).bind(...binds).run();
  if (body.scheduledFor) {
    await db.prepare(`UPDATE customers SET next_follow_up_at = ?, updated_at = ? WHERE id = ?`).bind(body.scheduledFor, nowIso(), existing.customer_id).run();
  }
  await logActivity(db, { actor: user, action: 'FOLLOWUP_UPDATED', entityType: 'customer', entityId: existing.customer_id, metadata: { followupId: id } });
  await broadcast(c.env, 'FOLLOWUP_UPDATED', { customerId: existing.customer_id, followupId: id }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});

followupRoutes.post('/:id/complete', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare(`SELECT * FROM followups WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Follow-up not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.employee_id !== user.employeeId) return jsonError(c, 403, 'Not your follow-up', 'FORBIDDEN_OWNERSHIP');

  await db.prepare(`UPDATE followups SET status = 'COMPLETED', completed_at = ?, completed_by = ? WHERE id = ?`).bind(nowIso(), user.id, id).run();
  const stillOpen = await db.prepare(`SELECT MIN(scheduled_for) AS next FROM followups WHERE customer_id = ? AND status = 'UPCOMING'`).bind(existing.customer_id).first();
  await db.prepare(`UPDATE customers SET next_follow_up_at = ?, updated_at = ? WHERE id = ?`).bind(stillOpen?.next ?? null, nowIso(), existing.customer_id).run();
  await logActivity(db, { actor: user, action: 'FOLLOWUP_COMPLETED', entityType: 'customer', entityId: existing.customer_id, metadata: { followupId: id } });
  await broadcast(c.env, 'FOLLOWUP_COMPLETED', { customerId: existing.customer_id, followupId: id }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});

followupRoutes.post('/:id/cancel', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare(`SELECT * FROM followups WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Follow-up not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.employee_id !== user.employeeId) return jsonError(c, 403, 'Not your follow-up', 'FORBIDDEN_OWNERSHIP');
  await db.prepare(`UPDATE followups SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'FOLLOWUP_CANCELLED', entityType: 'customer', entityId: existing.customer_id, metadata: { followupId: id } });
  return c.json({ ok: true });
});

/** Called from the Worker's scheduled() handler (cron trigger). */
export async function sweepOverdueFollowups(env) {
  const db = env.DB;
  const nowStr = nowIso();
  const overdue = await db.prepare(`SELECT * FROM followups WHERE status = 'UPCOMING' AND scheduled_for < ?`).bind(nowStr).all();
  if (overdue.results.length === 0) return { swept: 0 };
  const statements = overdue.results.map((f) => db.prepare(`UPDATE followups SET status = 'OVERDUE' WHERE id = ?`).bind(f.id));
  await db.batch(statements);
  for (const f of overdue.results) {
    const emp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(f.employee_id).first();
    if (emp) {
      await createNotification(db, {
        userId: emp.user_id,
        type: 'FOLLOWUP_OVERDUE',
        title: 'Follow-up overdue',
        message: `A scheduled follow-up for customer ${f.customer_id} is now overdue.`,
        entityType: 'customer',
        entityId: f.customer_id,
      });
      await broadcast(env, 'FOLLOWUP_OVERDUE', { customerId: f.customer_id, followupId: f.id }, { scope: 'user', userId: emp.user_id });
    }
    await broadcast(env, 'FOLLOWUP_OVERDUE', { customerId: f.customer_id, followupId: f.id }, { scope: 'role', role: 'team_leader' });
  }
  return { swept: overdue.results.length };
}
