// Internal chat — one thread per employee, between that employee and the
// Team Leader (there is only ever one Team Leader in this system, so a
// thread is fully identified by employee_id). Built on the same
// TeamRoom/WebSocket real-time infrastructure already used for every other
// live event in the app — no new transport, just a new event type.
import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';

export const chatRoutes = new Hono();
chatRoutes.use('*', requireAuth);

function assertThreadAccess(user, employeeId) {
  if (user.role === 'employee' && user.employeeId !== employeeId) return false;
  return true;
}

// Team Leader only — one row per employee, with last message + unread count, to build the thread list.
chatRoutes.get('/threads', requireRole('team_leader'), async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const employees = await db.prepare(`SELECT id, name, name_ar, avatar_data_url FROM employees WHERE active = 1 ORDER BY name`).all();
  const threads = [];
  for (const emp of employees.results) {
    const last = await db.prepare(`SELECT message, sender_role, created_at FROM chat_messages WHERE employee_id = ? ORDER BY created_at DESC LIMIT 1`).bind(emp.id).first();
    const read = await db.prepare(`SELECT last_read_at FROM chat_reads WHERE user_id = ? AND employee_id = ?`).bind(user.id, emp.id).first();
    const unread = await db
      .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE employee_id = ? AND sender_role = 'employee' AND created_at > ?`)
      .bind(emp.id, read?.last_read_at || '1970-01-01T00:00:00.000Z')
      .first();
    threads.push({
      employeeId: emp.id, employeeName: emp.name, employeeNameAr: emp.name_ar, avatarUrl: emp.avatar_data_url,
      lastMessage: last?.message || null, lastMessageAt: last?.created_at || null, lastSenderRole: last?.sender_role || null,
      unreadCount: unread.n,
    });
  }
  threads.sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
  return c.json({ threads });
});

// Unread total — for the employee's own thread (their nav badge), or across all threads for the Team Leader.
chatRoutes.get('/unread-count', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  if (user.role === 'employee') {
    const read = await db.prepare(`SELECT last_read_at FROM chat_reads WHERE user_id = ? AND employee_id = ?`).bind(user.id, user.employeeId).first();
    const unread = await db
      .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE employee_id = ? AND sender_role = 'team_leader' AND created_at > ?`)
      .bind(user.employeeId, read?.last_read_at || '1970-01-01T00:00:00.000Z')
      .first();
    return c.json({ unread: unread.n });
  }
  const employees = await db.prepare(`SELECT id FROM employees WHERE active = 1`).all();
  let total = 0;
  for (const emp of employees.results) {
    const read = await db.prepare(`SELECT last_read_at FROM chat_reads WHERE user_id = ? AND employee_id = ?`).bind(user.id, emp.id).first();
    const unread = await db
      .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE employee_id = ? AND sender_role = 'employee' AND created_at > ?`)
      .bind(emp.id, read?.last_read_at || '1970-01-01T00:00:00.000Z')
      .first();
    total += unread.n;
  }
  return c.json({ unread: total });
});

chatRoutes.get('/:employeeId/messages', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const employeeId = Number(c.req.param('employeeId'));
  if (!assertThreadAccess(user, employeeId)) return jsonError(c, 403, 'ليس لديك صلاحية عرض هذه المحادثة', 'FORBIDDEN_OWNERSHIP');

  const rows = await db.prepare(`SELECT * FROM chat_messages WHERE employee_id = ? ORDER BY created_at ASC LIMIT 500`).bind(employeeId).all();
  const now = nowIso();
  await db
    .prepare(`INSERT INTO chat_reads (user_id, employee_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, employee_id) DO UPDATE SET last_read_at = excluded.last_read_at`)
    .bind(user.id, employeeId, now)
    .run();

  return c.json({
    messages: rows.results.map((m) => ({ id: m.id, senderRole: m.sender_role, senderName: m.sender_name, message: m.message, createdAt: m.created_at })),
  });
});

chatRoutes.post('/:employeeId/messages', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const employeeId = Number(c.req.param('employeeId'));
  if (!assertThreadAccess(user, employeeId)) return jsonError(c, 403, 'ليس لديك صلاحية إرسال رسالة هنا', 'FORBIDDEN_OWNERSHIP');
  const emp = await db.prepare(`SELECT id, user_id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const body = await c.req.json().catch(() => ({}));
  const message = String(body.message || '').trim();
  if (!message) return jsonError(c, 400, 'نص الرسالة مطلوب', 'EMPTY_MESSAGE');

  const res = await db
    .prepare(`INSERT INTO chat_messages (employee_id, sender_role, sender_user_id, sender_name, message) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`)
    .bind(employeeId, user.role, user.id, user.displayName, message)
    .first();

  // Sender's own read marker moves forward too, so they don't see their own message as unread.
  await db
    .prepare(`INSERT INTO chat_reads (user_id, employee_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, employee_id) DO UPDATE SET last_read_at = excluded.last_read_at`)
    .bind(user.id, employeeId, res.created_at)
    .run();

  const payload = { employeeId, message, senderRole: user.role, senderName: user.displayName, createdAt: res.created_at };
  if (user.role === 'employee') {
    await broadcast(c.env, 'CHAT_MESSAGE', payload, { scope: 'role', role: 'team_leader' });
  } else {
    await broadcast(c.env, 'CHAT_MESSAGE', payload, { scope: 'user', userId: emp.user_id });
  }
  await logActivity(db, { actor: user, action: 'CHAT_MESSAGE_SENT', entityType: 'employee', entityId: String(employeeId) });

  return c.json({ message: { id: res.id, ...payload } }, 201);
});
