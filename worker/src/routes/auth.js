import { Hono } from 'hono';
import { verifyPassword, hashPassword, randomSaltHex } from '../lib/passwords.js';
import { createSession, setSessionCookie, clearSessionCookie, requireAuth } from '../lib/auth.js';
import { logActivity, jsonError, nowIso } from '../lib/db.js';
import { recordLogin, recordLogout } from '../lib/presence.js';

export const authRoutes = new Hono();

// Public: the employee-picker screen needs names/avatars before any password
// is entered. Only non-sensitive identity fields are exposed.
authRoutes.get('/employees-public', async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT u.username, e.name, e.name_ar, e.avatar_initial, e.avatar_data_url
       FROM employees e JOIN users u ON u.id = e.user_id
       WHERE e.active = 1 AND u.active = 1
       ORDER BY e.name COLLATE NOCASE`
    )
    .all();
  return c.json({ employees: rows.results });
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const remember = !!body.remember;

  if (!username || !password) return jsonError(c, 400, 'اسم المستخدم وكلمة المرور مطلوبان', 'MISSING_FIELDS');

  const db = c.env.DB;
  const user = await db.prepare(`SELECT * FROM users WHERE username = ?`).bind(username).first();

  // Constant-shape response whether or not the user exists, to avoid
  // leaking which usernames are valid.
  const dummySalt = 'a'.repeat(32);
  const dummyHash = 'b'.repeat(64);
  const ok = user
    ? user.active && (await verifyPassword(password, user.password_salt, user.password_hash))
    : (await verifyPassword(password, dummySalt, dummyHash), false);

  if (!ok) {
    await logActivity(db, { actor: null, action: 'LOGIN_FAILED', entityType: 'user', entityId: username });
    return jsonError(c, 401, 'اسم المستخدم أو كلمة المرور غير صحيحة', 'INVALID_CREDENTIALS');
  }

  const userAgent = c.req.header('user-agent') || '';
  const { token } = await createSession(db, user, { remember, userAgent });
  setSessionCookie(c, token, remember);

  let employeeId = null;
  let availability = null;
  let avatarUrl = null;
  if (user.role === 'employee') {
    const emp = await db.prepare(`SELECT id, availability, avatar_data_url FROM employees WHERE user_id = ?`).bind(user.id).first();
    employeeId = emp?.id ?? null;
    availability = emp?.availability ?? null;
    avatarUrl = emp?.avatar_data_url ?? null;
  }

  await recordLogin(db, c.env, { userId: user.id, employeeId, token, userAgent });

  await logActivity(db, {
    actor: { id: user.id, displayName: user.display_name, role: user.role },
    action: 'LOGIN',
    entityType: 'user',
    entityId: String(user.id),
  });

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      employeeId,
      availability,
      avatarUrl,
      mustChangePassword: !!user.must_change_password,
    },
  });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  await recordLogout(db, c.env, { employeeId: user.employeeId, token: user.token });
  await db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(user.token).run();
  clearSessionCookie(c);
  await logActivity(db, { actor: user, action: 'LOGOUT', entityType: 'user', entityId: String(user.id) });
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  let availability = null;
  let avatarUrl = null;
  if (user.role === 'employee') {
    const emp = await db.prepare(`SELECT availability, avatar_data_url FROM employees WHERE id = ?`).bind(user.employeeId).first();
    availability = emp?.availability ?? null;
    avatarUrl = emp?.avatar_data_url ?? null;
  }
  return c.json({ user: { ...user, token: undefined, availability, avatarUrl } });
});

authRoutes.post('/change-password', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword || String(newPassword).length < 8) {
    return jsonError(c, 400, 'يجب أن تتكون كلمة المرور الجديدة من ٨ أحرف على الأقل', 'WEAK_PASSWORD');
  }
  const db = c.env.DB;
  const row = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(user.id).first();
  const ok = await verifyPassword(currentPassword, row.password_salt, row.password_hash);
  if (!ok) return jsonError(c, 401, 'كلمة المرور الحالية غير صحيحة', 'BAD_CURRENT_PASSWORD');

  const salt = randomSaltHex();
  const hash = await hashPassword(newPassword, salt);
  await db
    .prepare(`UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ? WHERE id = ?`)
    .bind(hash, salt, nowIso(), user.id)
    .run();
  await logActivity(db, { actor: user, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: String(user.id) });
  return c.json({ ok: true });
});
