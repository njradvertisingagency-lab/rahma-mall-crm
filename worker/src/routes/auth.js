import { Hono } from 'hono';
import { verifyPassword, hashPassword, randomSaltHex } from '../lib/passwords.js';
import { createSession, setSessionCookie, clearSessionCookie, requireAuth } from '../lib/auth.js';
import { logActivity, jsonError, nowIso } from '../lib/db.js';
import { recordLogin, recordLogout } from '../lib/presence.js';
import { sessDelete } from '../lib/sessionStore.js';

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

// Desktop-only login is enforced mainly client-side (app.js: feature
// detection before the login form even renders, plus a continuous
// touch/orientation guard for the rest of the session — see the user's
// picked options). This is a baseline COMPLEMENT, not a replacement: it
// only catches the case of someone skipping the browser entirely and
// hitting this endpoint directly (curl/Postman/a script) with a real
// mobile-device User-Agent. It cannot catch a spoofed or stripped
// User-Agent — that is exactly what the client-side feature detection is
// for — so this check is deliberately narrow and never the only line of
// defense.
const MOBILE_UA_PATTERN = /Android|iPhone|iPad|iPod|Mobile|BlackBerry|IEMobile|Opera Mini|Windows Phone/i;

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const remember = !!body.remember;

  if (!username || !password) return jsonError(c, 400, 'اسم المستخدم وكلمة المرور مطلوبان', 'MISSING_FIELDS');

  const uaHeader = c.req.header('user-agent') || '';
  if (MOBILE_UA_PATTERN.test(uaHeader)) {
    return jsonError(c, 403, 'هذا النظام يعمل من جهاز كمبيوتر فقط', 'DESKTOP_ONLY');
  }

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

  const userAgent = uaHeader;

  let employeeId = null;
  let availability = null;
  let avatarUrl = null;
  if (user.role === 'employee') {
    const emp = await db.prepare(`SELECT id, availability, avatar_data_url FROM employees WHERE user_id = ?`).bind(user.id).first();
    employeeId = emp?.id ?? null;
    availability = emp?.availability ?? null;
    avatarUrl = emp?.avatar_data_url ?? null;
  }

  const { token } = await createSession(c.env, user, { remember, userAgent, employeeId });
  setSessionCookie(c, token, remember);

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
      isOwner: !!user.is_owner,
      mustChangePassword: !!user.must_change_password,
    },
  });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  await recordLogout(db, c.env, { employeeId: user.employeeId, token: user.token });
  await sessDelete(c.env, user.token).catch((err) => console.error('logout: could not delete session record (non-fatal)', err));
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
    // Best-effort: this is now the ONLY D1 read on the app's most-called
    // endpoint (fired on every page load) — never let it turn a valid,
    // already-verified session into a failed page load if D1 hiccups.
    try {
      const emp = await db.prepare(`SELECT availability, avatar_data_url FROM employees WHERE id = ?`).bind(user.employeeId).first();
      availability = emp?.availability ?? null;
      avatarUrl = emp?.avatar_data_url ?? null;
    } catch (err) {
      console.error('/auth/me: could not load availability/avatar (non-fatal)', err);
    }
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
