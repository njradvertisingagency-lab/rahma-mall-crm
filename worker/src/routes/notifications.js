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
  // Fired on every dashboard load (topbar bell) — if D1 is over quota, fail
  // honestly instead of a raw 500 taking the bell/dashboard down.
  try {
    // سجل الإشعارات يعرض آخر ١٠ فقط بناءً على طلب صاحب الشركة — عداد غير
    // المقروء (unreadCount تحت) يبقى محسوبًا على كل الإشعارات فعليًا، مش
    // مقيّدًا بالعشرة دول، حتى يفضل الجرس دقيقًا حتى لو فيه غير مقروء أقدم.
    const rows = await db
      .prepare(`SELECT * FROM notifications WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 10`)
      .bind(...binds)
      .all();
    const unreadCount = await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0`).bind(user.id).first();
    return c.json({ notifications: rows.results, unreadCount: unreadCount.n });
  } catch (err) {
    console.error('notifications: D1 unavailable', err);
    return jsonError(c, 503, 'تعذر تحميل الإشعارات مؤقتًا — برجاء المحاولة خلال دقائق', 'DB_TEMPORARILY_UNAVAILABLE');
  }
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
