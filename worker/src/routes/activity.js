import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';

export const activityRoutes = new Hono();
activityRoutes.use('*', requireAuth);

// Team Leader sees everything. An employee may only see activity tied to
// their own customers or their own account actions (never other employees').
activityRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const q = c.req.query();
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  let where = '1=1';
  const binds = [];
  if (user.role === 'employee') {
    where = `(actor_id = ? OR entity_id IN (SELECT id FROM customers WHERE assigned_employee_id = ?))`;
    binds.push(user.id, user.employeeId);
  } else if (q.actorId) {
    where = 'actor_id = ?';
    binds.push(Number(q.actorId));
  }
  if (q.entityType) {
    where += ' AND entity_type = ?';
    binds.push(q.entityType);
  }
  if (q.entityId) {
    where += ' AND entity_id = ?';
    binds.push(q.entityId);
  }

  const rows = await db
    .prepare(`SELECT * FROM activity_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, offset)
    .all();
  return c.json({
    activity: rows.results.map((r) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null })),
    pagination: { page, pageSize },
  });
});
