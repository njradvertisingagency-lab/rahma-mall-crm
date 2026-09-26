import { Hono } from 'hono';
import { verifyPassword, hashPassword, randomSaltHex } from '../lib/passwords.js';
import { createSession, setSessionCookie, clearSessionCookie, requireAuth } from '../lib/auth.js';
import { logActivity, jsonError, nowIso, backgroundWrite } from '../lib/db.js';
import { recordLogin, recordLogout } from '../lib/presence.js';
import { sessDelete, sessGet, sessPut } from '../lib/sessionStore.js';
import { getShiftGate } from '../lib/workhours.js';

export const authRoutes = new Hono();

// Public: the employee-picker screen needs names/avatars before any password
// is entered. Only non-sensitive identity fields are exposed.
//
// This is the very FIRST request anyone makes — every visitor hits it on
// page load, before logging in, often repeatedly if they keep retrying a
// failed page. That made it one of the heaviest, most repetitive D1 reads
// in the whole app (a JOIN, on every single page view). It now has two
// layers of protection, reusing the SessionStore Durable Object (already
// deployed, no new binding needed) purely as a small key/value cache here —
// unrelated to sessions, just a convenient existing KV store:
//   1. A 60-second cache: most page views in any given minute cost zero D1
//      reads.
//   2. A "last known good" fallback with no expiry: if D1 is ever
//      unreachable (quota, outage), the picker screen still shows the
//      employee list from the last successful read instead of an error —
//      the data is close to static (names/avatars), so a stale copy is far
//      better than a blank screen.
const EMPLOYEES_PUBLIC_CACHE_KEY = 'cache:employees_public';
const EMPLOYEES_PUBLIC_CACHE_TTL_MS = 60 * 1000;

authRoutes.get('/employees-public', async (c) => {
  // Outside the shift, employee accounts are blocked from doing anything
  // anyway (requireAuth's OUTSIDE_WORK_HOURS gate) — so there is no reason
  // to even show their names on the login picker, and every reason not to:
  // it makes the closure visible before anyone wastes a password attempt,
  // and it skips D1/cache entirely (checked before any of that below).
  const gate = getShiftGate({ wide: false });
  if (!gate.open) {
    return c.json({ employees: [], closed: true, shiftText: gate.shiftText, opensInText: gate.opensInText, isOffDay: !!gate.isOffDay });
  }

  const cached = await sessGet(c.env, EMPLOYEES_PUBLIC_CACHE_KEY).catch(() => null);
  if (cached && Date.now() - cached.cachedAt < EMPLOYEES_PUBLIC_CACHE_TTL_MS) {
    return c.json({ employees: cached.employees });
  }

  const db = c.env.DB;
  try {
    const rows = await db
      .prepare(
        `SELECT u.username, e.name, e.name_ar, e.avatar_initial, e.avatar_data_url
         FROM employees e JOIN users u ON u.id = e.user_id
         WHERE e.active = 1 AND u.active = 1
         ORDER BY e.name COLLATE NOCASE`
      )
      .all();
    const employees = rows.results;
    backgroundWrite(c, () => sessPut(c.env, EMPLOYEES_PUBLIC_CACHE_KEY, { employees, cachedAt: Date.now() }), 'employees-public: could not update cache (non-fatal)');
    return c.json({ employees });
  } catch (err) {
    console.error('employees-public: D1 unavailable, falling back to last known list', err);
    if (cached) return c.json({ employees: cached.employees, stale: true });
    return jsonError(c, 503, 'تعذر تحميل قائمة الموظفين مؤقتًا — برجاء المحاولة خلال دقائق', 'DB_TEMPORARILY_UNAVAILABLE');
  }
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
  // A per-username snapshot of the users row, cached in the SessionStore DO
  // (same reused-as-KV trick as employees-public/dashboard). There are only
  // a handful of accounts and they change rarely (password change, activate/
  // deactivate), so this is always refreshed from a fresh D1 read when D1 is
  // up — the cache is ONLY a last-resort fallback for the one D1 read that
  // can never be moved off D1 entirely (credentials must be checked
  // somewhere). This closes the one remaining gap: previously, even a
  // brand-new login was blocked whenever D1's quota was exhausted, while an
  // already-logged-in session was fully unaffected (requireAuth in
  // lib/auth.js never touches D1). Now a login can succeed from the last
  // known-good snapshot too, as long as that account has logged in
  // successfully at least once since D1 was last reachable.
  const userCacheKey = `cache:user:${username}`;
  let user;
  try {
    // ONLY the D1 read belongs in this try. Anything else in here — including
    // refreshing the cache below — would be caught by the handler underneath
    // and reported to the person as a database outage while the database is
    // perfectly healthy, locking them out of their own system.
    user = await db.prepare(`SELECT * FROM users WHERE username = ?`).bind(username).first();
  } catch (err) {
    console.error('login: D1 unavailable while checking credentials, trying last known snapshot', err);
    const cached = await sessGet(c.env, userCacheKey).catch(() => null);
    if (cached) {
      user = cached.user;
    } else {
      // If D1 itself is unreachable/over quota and we have no snapshot for
      // this account, say so plainly instead of the generic "فشل الطلب" a
      // raw 500 produces.
      return jsonError(c, 503, 'تعذر تسجيل الدخول مؤقتًا بسبب ضغط على قاعدة البيانات — برجاء المحاولة خلال دقائق', 'DB_TEMPORARILY_UNAVAILABLE');
    }
  }

  // Refresh the fallback snapshot outside the try above — a failure here must
  // never cost anyone their login.
  backgroundWrite(
    c,
    () => sessPut(c.env, userCacheKey, { user: user ?? null, cachedAt: Date.now() }),
    'login user cache'
  );

  // Constant-shape response whether or not the user exists, to avoid
  // leaking which usernames are valid.
  const dummySalt = 'a'.repeat(32);
  const dummyHash = 'b'.repeat(64);
  const ok = user
    ? user.active && (await verifyPassword(password, user.password_salt, user.password_hash))
    : (await verifyPassword(password, dummySalt, dummyHash), false);

  if (!ok) {
    // Best-effort audit log — a wrong password must still come back as a
    // clean 401 even if D1 can't take this write right now.
    await logActivity(db, { actor: null, action: 'LOGIN_FAILED', entityType: 'user', entityId: username }).catch((err) =>
      console.error('login: could not log LOGIN_FAILED (non-fatal)', err)
    );
    return jsonError(c, 401, 'اسم المستخدم أو كلمة المرور غير صحيحة', 'INVALID_CREDENTIALS');
  }

  const userAgent = uaHeader;

  // From here on, the credential check has already succeeded (from D1 or the
  // cached snapshot) — nothing below should be able to turn that into a
  // failed login. Every remaining D1 touch is either best-effort (presence/
  // activity logging) or degrades to a safe default (availability/avatar).
  let employeeId = null;
  let availability = null;
  let avatarUrl = null;
  if (user.role === 'employee') {
    try {
      const emp = await db.prepare(`SELECT id, availability, avatar_data_url FROM employees WHERE user_id = ?`).bind(user.id).first();
      employeeId = emp?.id ?? null;
      availability = emp?.availability ?? null;
      avatarUrl = emp?.avatar_data_url ?? null;
    } catch (err) {
      console.error('login: could not load employee profile (non-fatal)', err);
    }
  }

  // حساب HR منفصل عن قائد الفريق (المبيعات) لكنه يحمل نفس role='team_leader' في
  // قاعدة البيانات (انظر التعليق في lib/auth.js). العلم مخزّن في جدول منفصل
  // user_role_flags بدل عمود على users نفسها، لتفادي ALTER TABLE الممنوع.
  let isHr = false;
  if (user.role === 'team_leader') {
    try {
      const flagRow = await db.prepare(`SELECT is_hr FROM user_role_flags WHERE user_id = ?`).bind(user.id).first();
      isHr = !!flagRow?.is_hr;
    } catch (err) {
      console.error('login: could not load HR flag (non-fatal)', err);
    }
  }

  const { token } = await createSession(c.env, user, { remember, userAgent, employeeId, isHr });
  setSessionCookie(c, token, remember);

  await recordLogin(db, c.env, { userId: user.id, employeeId, token, userAgent }).catch((err) =>
    console.error('login: could not record presence/session-history row (non-fatal)', err)
  );

  await logActivity(db, {
    actor: { id: user.id, displayName: user.display_name, role: user.role },
    action: 'LOGIN',
    entityType: 'user',
    entityId: String(user.id),
  }).catch((err) => console.error('login: could not log LOGIN activity (non-fatal)', err));

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
      isHr,
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
