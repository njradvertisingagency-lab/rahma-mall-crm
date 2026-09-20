import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomToken } from './passwords.js';
import { nowIso, jsonError } from './db.js';

export const SESSION_COOKIE = 'rm_session';
const SHORT_SESSION_HOURS = 12;
const REMEMBER_SESSION_DAYS = 30;

export async function createSession(db, user, { remember = false, userAgent = '' } = {}) {
  const token = randomToken(32);
  const ms = remember ? REMEMBER_SESSION_DAYS * 24 * 3600 * 1000 : SHORT_SESSION_HOURS * 3600 * 1000;
  const expiresAt = new Date(Date.now() + ms).toISOString();
  await db
    .prepare(`INSERT INTO sessions (token, user_id, role, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`)
    .bind(token, user.id, user.role, expiresAt, userAgent.slice(0, 200))
    .run();
  return { token, expiresAt };
}

export function setSessionCookie(c, token, remember) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    // 'None' is required because the production frontend (Cloudflare Pages)
    // and this API (Workers) are on different registrable domains — a
    // cross-site fetch would silently drop a Lax/Strict cookie. CSRF risk is
    // mitigated by strict CORS (exact-origin allowlist in index.js) plus the
    // required x-rahma-client header, which forces a preflight that only the
    // allowed origin can pass.
    sameSite: 'None',
    path: '/',
    maxAge: remember ? REMEMBER_SESSION_DAYS * 24 * 3600 : SHORT_SESSION_HOURS * 3600,
  });
}

export function clearSessionCookie(c) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Attaches c.set('user', {...}) for a valid, unexpired, active session. */
export async function requireAuth(c, next) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return jsonError(c, 401, 'لم يتم تسجيل الدخول', 'NO_SESSION');
  const db = c.env.DB;
  const session = await db
    .prepare(
      `SELECT s.token, s.user_id, s.expires_at, u.username, u.role AS user_role, u.display_name, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .bind(token)
    .first();
  if (!session) {
    clearSessionCookie(c);
    return jsonError(c, 401, 'الجلسة غير صالحة', 'INVALID_SESSION');
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    c.executionCtx.waitUntil(db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run());
    clearSessionCookie(c);
    return jsonError(c, 401, 'انتهت صلاحية الجلسة', 'SESSION_EXPIRED');
  }
  if (!session.active) return jsonError(c, 403, 'الحساب مُعطَّل', 'ACCOUNT_DISABLED');

  c.executionCtx.waitUntil(
    db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token = ?`).bind(nowIso(), token).run()
  );

  let employeeId = null;
  if (session.user_role === 'employee') {
    const emp = await db.prepare(`SELECT id FROM employees WHERE user_id = ?`).bind(session.user_id).first();
    employeeId = emp?.id ?? null;
  }
  c.set('user', {
    id: session.user_id,
    username: session.username,
    role: session.user_role,
    displayName: session.display_name,
    employeeId,
    token,
  });
  await next();
}

export function requireRole(...roles) {
  return async (c, next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) return jsonError(c, 403, 'غير مصرح لهذا الدور', 'FORBIDDEN_ROLE');
    await next();
  };
}

/** Lightweight CSRF defense-in-depth for a same-origin JSON API behind SameSite=Lax cookies. */
export async function requireAppHeader(c, next) {
  if (c.req.header('x-rahma-client') !== 'web') {
    return jsonError(c, 403, 'ترويسة العميل مفقودة', 'MISSING_CLIENT_HEADER');
  }
  await next();
}
