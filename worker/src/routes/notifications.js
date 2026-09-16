import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { jsonError, nowIso } from '../lib/db.js';

export const notificationRoutes = new Hono();
notificationRoutes.use('*', requireAuth);

notificationRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const q = c.req.query();
  const conds = ['user_id = ?'];
  const binds = [user.id];
  if (q.unread === 'true') conds.push('read = 0');
  const rows = await db
    .prepare(`SELECT * FROM notifications WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 100`)
    .bind(...binds)
    .all();
  const unreadCount = await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0`).bind(user.id).first();
  return c.json({ notifications: rows.results, unreadCount: unreadCount.n });
});

notificationRoutes.patch('/:id/read', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  await db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`).bind(id, user.id).run();
  return c.json({ ok: true });
});

notificationRoutes.post('/mark-all-read', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  await db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0`).bind(user.id).run();
  return c.json({ ok: true });
});
