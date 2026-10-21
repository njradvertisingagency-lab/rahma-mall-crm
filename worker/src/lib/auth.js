import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomToken } from './passwords.js';
import { nowIso, jsonError, backgroundWrite } from './db.js';
import { sessGet, sessPut, sessDelete } from './sessionStore.js';

export const SESSION_COOKIE = 'rm_session';
const SHORT_SESSION_HOURS = 12;
const REMEMBER_SESSION_DAYS = 30;

// Session storage lives in the SessionStore Durable Object, NOT a D1 table â
// see durable-objects/session-store.js for why (D1's free-tier daily
// row-read quota was being exhausted partly BY this exact query running on
// every single authenticated request app-wide; a DO is a separate resource,
// unaffected by it). The session record below deliberately carries a
// snapshot of the fields requireAuth used to JOIN from the `users` table
// (role, displayName, isOwner, employeeId) so that after login, validating
// a session never touches D1 again for the rest of its lifetime. The
// trade-off: if an account is disabled or its role changes, that only takes
// effect on their NEXT login, not instantly â routes/employees.js's
// password-reset flow already force-revokes sessions for a user, which
// covers the one place in the app that needed instant effect.
export async function createSession(env, user, { remember = false, userAgent = '', employeeId = null, isHr = false, isLegal = false, department = 'customer_service' } = {}) {
  const token = randomToken(32);
  const ms = remember ? REMEMBER_SESSION_DAYS * 24 * 3600 * 1000 : SHORT_SESSION_HOURS * 3600 * 1000;
  const expiresAt = new Date(Date.now() + ms).toISOString();
  const now = nowIso();
  await sessPut(env, token, {
    token,
    userId: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    isOwner: !!user.is_owner,
    isHr: !!isHr,
    isLegal: !!isLegal,
    department,
    active: !!user.active,
    employeeId,
    userAgent: String(userAgent).slice(0, 200),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  return { token, expiresAt };
}

export function setSessionCookie(c, token, remember) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    // 'None' is required because the production frontend (Cloudflare Pages)
    // and this API (Workers) are on different registrable domains â a
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

/** Attaches c.set('user', {...}) for a valid, unexpired, active session. Reads NO D1 at all. */
export async function requireAuth(c, next) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return jsonError(c, 401, 'ÙÙ ÙØªÙ ØªØ³Ø¬ÙÙ Ø§ÙØ¯Ø®ÙÙ', 'NO_SESSION');

  let session;
  try {
    session = await sessGet(c.env, token);
  } catch (err) {
    console.error('requireAuth: session store unreachable', err);
    return jsonError(c, 503, 'Ø§ÙØ®Ø¯ÙØ© ØºÙØ± ÙØªØ§Ø­Ø© ÙØ¤ÙØªÙØ§Ø Ø¨Ø±Ø¬Ø§Ø¡ Ø§ÙÙØ­Ø§ÙÙØ© Ø¨Ø¹Ø¯ ÙØ­Ø¸Ø§Øª', 'SERVICE_UNAVAILABLE');
  }

  if (!session) {
    clearSessionCookie(c);
    return jsonError(c, 401, 'Ø§ÙØ¬ÙØ³Ø© ØºÙØ± ØµØ§ÙØ­Ø©', 'INVALID_SESSION');
  }
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    backgroundWrite(c, () => sessDelete(c.env, token), 'requireAuth expired-session cleanup');
    clearSessionCookie(c);
    return jsonError(c, 401, 'Ø§ÙØªÙØª ØµÙØ§Ø­ÙØ© Ø§ÙØ¬ÙØ³Ø©', 'SESSION_EXPIRED');
  }
  if (!session.active) return jsonError(c, 403, 'Ø§ÙØ­Ø³Ø§Ø¨ ÙÙØ¹Ø·ÙÙÙ', 'ACCOUNT_DISABLED');

  // Ø§ÙÙØ¸Ø§Ù Ø´ØºØ§Ù Ù¢Ù¤ Ø³Ø§Ø¹Ø© Ø¨Ø§ÙÙ default ÙÙÙ Ø§ÙØ­Ø³Ø§Ø¨Ø§Øª â Ø¥ÙØ§ ÙÙ Ø§ÙÙÙØ¸Ù Ø¹ÙØ¯Ù
  // systemStartHour / systemEndHour ÙÙ shift_config: Ø¯ÙÙ Ø¨ÙØ­Ø¯Ø¯Ù Ø³Ø§Ø¹Ø§Øª ÙØªØ­
  // ÙÙÙÙ Ø§ÙÙØ¸Ø§Ù ÙÙØ°Ø§ Ø§ÙÙÙØ¸Ù Ø¨Ø§ÙØ°Ø§Øª (ÙØ´ Ø§ÙØ¨ØµÙØ© â Ø§ÙØ¨ØµÙØ© ÙÙÙØ§ ÙÙØ·Ù ÙÙÙØµÙ ÙÙ
  // lib/attendance.js). ÙØ«Ø§Ù: ÙÙØ¸Ù Ø¨Ø´ÙÙØª ØµØ¨Ø­ + ÙØ³Ø§ ÙØ­ØªØ§Ø¬ Ø§ÙÙØ¸Ø§Ù ÙÙØªØ­ÙÙ ÙÙ
  // Ù¡Ù  ØµØ¨Ø§Ø­ÙØ§ ÙÙÙÙÙ Ù¡Ù¡ ÙØ³Ø§Ø¡Ù Ø¨Ø¯Ù Ù¢Ù¤ Ø³Ø§Ø¹Ø©.
  if (session.employeeId) {
    try {
      const emp = await c.env.DB.prepare(`SELECT shift_config FROM employees WHERE id = ? AND active = 1`).bind(session.employeeId).first();
      if (emp?.shift_config) {
        const sc = JSON.parse(emp.shift_config);
        if (sc.systemEndHour != null) {
          const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
          const h = Number(parts.find(p => p.type === 'hour')?.value) % 24;
          const nowMin = h * 60 + Number(parts.find(p => p.type === 'minute')?.value);
          const sysStart = (sc.systemStartHour ?? 10) * 60 + (sc.systemStartMinute ?? 0);
          const sysEnd = sc.systemEndHour * 60 + (sc.systemEndMinute ?? 0);
          // ÙÙ Ø§ÙØ´ÙÙØª Ø¨ÙØ¹Ø¯ÙÙ ÙØµ Ø§ÙÙÙÙ (ÙØ«ÙØ§Ù Ù¡Ù ØµâÙ¡Øµ) â sysEnd < sysStart
          const outsideWindow = sysEnd > sysStart
            ? (nowMin < sysStart || nowMin >= sysEnd)
            : (nowMin < sysStart && nowMin >= sysEnd);
          if (outsideWindow) {
            return jsonError(c, 403, 'Ø§ÙÙØ¸Ø§Ù ÙØºÙÙ Ø­Ø§ÙÙÙØ§ â ÙØ¹ÙÙ ÙÙ Ù¡Ù  ØµØ¨Ø§Ø­ÙØ§ ÙØ­Ø¯ Ù¡Ù¡ ÙØ³Ø§Ø¡Ù', 'OUTSIDE_WORK_HOURS');
          }
        }
      }
    } catch (err) {
      // D1 read failure â degrade to 24h access (non-fatal)
      console.error('requireAuth: shift_config system-hours check failed (non-fatal)', err);
    }
  }

  // Touching lastSeenAt is bookkeeping. It runs on EVERY authenticated
  // request, so if it could throw it would take the whole app down with it.
  backgroundWrite(c, () => sessPut(c.env, token, { ...session, lastSeenAt: nowIso() }), 'requireAuth lastSeenAt');

  c.set('user', {
    id: session.userId,
    username: session.username,
    role: session.role,
    displayName: session.displayName,
    employeeId: session.employeeId ?? null,
    isOwner: !!session.isOwner,
    isHr: !!session.isHr,
    isLegal: !!session.isLegal,
    department: session.department || 'customer_service',
    token,
  });
  await next();
}

export function requireRole(...roles) {
  return async (c, next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) return jsonError(c, 403, 'ØºÙØ± ÙØµØ±Ø­ ÙÙØ°Ø§ Ø§ÙØ¯ÙØ±', 'FORBIDDEN_ROLE');
    await next();
  };
}

// Ø­Ø³Ø§Ø¨ HR ÙÙÙØµÙ ØªÙØ§ÙÙØ§ Ø¹Ù ÙØ§Ø¦Ø¯ Ø§ÙÙØ±ÙÙ (Ø§ÙÙØ¨ÙØ¹Ø§Øª): ÙÙØ³ role='team_leader' ÙÙ
// ÙØ§Ø¹Ø¯Ø© Ø§ÙØ¨ÙØ§ÙØ§Øª (ÙØªØ¬ÙÙØ¨ ØªØ¹Ø¯ÙÙ CHECK constraint Ø¹ÙÙ Ø§ÙØ¹ÙÙØ¯ ÙÙÙ ÙÙÙÙØ¹)Ø ÙÙÙ
// ÙÙØµÙÙ Ø¹ÙÙÙÙØ§ Ø¹Ø¨Ø± Ø¹ÙÙ isHr Ø§ÙÙØ£Ø®ÙØ° ÙÙ Ø¬Ø¯ÙÙ user_role_flags ÙÙØª ØªØ³Ø¬ÙÙ
// Ø§ÙØ¯Ø®ÙÙ. ÙØ°Ø§ Ø§ÙØ­Ø§Ø±Ø³ ÙÙØªØ­ ÙØ³Ø§Ø±Ø§Øª HR (Ø§ÙØ¥Ø¬Ø§Ø²Ø§ØªØ Ø§ÙØªÙÙÙÙØ Ø§ÙÙØ®Ø§ÙÙØ§ØªØ Ø§ÙØªØ¯Ø±ÙØ¨Ø
// Ø§ÙÙØ³ØªÙØ¯Ø§ØªØ Ø§ÙÙØ²Ø§ÙØ§Ø Ø§ÙØ¥Ø¹ÙØ§ÙØ§ØªØ ÙÙÙÙØ§Øª HR ÙÙÙÙØ¸ÙÙÙ) ÙØ­Ø³Ø§Ø¨ HR ÙÙØ· â ÙØ§Ø¦Ø¯
// Ø§ÙÙØ±ÙÙ Ø§ÙØ¹Ø§Ø¯Ù (Ø§ÙÙØ¨ÙØ¹Ø§Øª) ÙÙ ÙØ¹Ø¯ ÙÙ ÙØµÙÙ ÙÙØ§Ø ÙØ­Ø³Ø§Ø¨ Ø§ÙÙØ§ÙÙ (isOwner) ÙØ¨ÙÙ
// ÙØ³ØªØ«ÙÙ ÙØ£ÙÙ ÙÙÙÙ Ø±Ø¤ÙØ© ÙØ§ÙÙØ© Ø¹ÙÙ Ø£Ù Ø­Ø§Ù.
export function requireHR(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'team_leader' || (!user.isHr && !user.isOwner)) {
    return jsonError(c, 403, 'ÙØ°Ø§ Ø§ÙØ¥Ø¬Ø±Ø§Ø¡ ÙØ®ØµØµ ÙØ­Ø³Ø§Ø¨ Ø§ÙÙÙØ§Ø±Ø¯ Ø§ÙØ¨Ø´Ø±ÙØ©', 'FORBIDDEN_HR_ONLY');
  }
  return next();
}

// Ø­Ø§Ø±Ø³ ÙØ³Ù Ø§ÙØ´Ø¦ÙÙ Ø§ÙÙØ§ÙÙÙÙØ© + HR â Ø§ÙÙÙÙØ§Øª Ø§ÙÙØ§ÙÙÙÙØ© ÙØ´ØªØ±ÙØ© Ø¨ÙÙÙÙ ÙÙØ·.
// Ø­Ø³Ø§Ø¨ Ø§ÙØ£Ø¯ÙÙ (isOwner) ÙØ³ØªØ«ÙÙ ÙØ§ÙØ¹Ø§Ø¯Ø© ÙØ£ÙÙ god-view.
export function requireLegalOrHR(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'team_leader' || (!user.isLegal && !user.isHr && !user.isOwner)) {
    return jsonError(c, 403, 'ÙØ°Ø§ Ø§ÙÙØ³Ù ÙØ®ØµØ± ÙÙØ´Ø¦ÙÙ Ø§ÙÙØ§ÙÙÙÙØ© ÙØ§ÙÙÙØ§Ø±Ø¯ Ø§ÙØ¨Ø´Ø±ÙØ© ÙÙØ·', 'FORBIDDEN_LEGAL_HR_ONLY');
  }
  return next();
}

// ÙØ³Ø§Ø±Ø§Øª Ø§ÙÙØ¨ÙØ¹Ø§Øª/CRM (Ø§ÙØ¹ÙÙØ§Ø¡Ø Ø§ÙØªÙØ²ÙØ¹Ø Ø§ÙÙØ¨ÙØ¹Ø§ØªØ Ø§ÙØ´ÙØ§ÙÙØ ÙØ±ÙØ² Ø§ÙØªØ­ÙÙØ
// Ø§ÙØªØ­ÙÙÙØ§ØªØ Ø§ÙØªÙØ§Ø±ÙØ±Ø Ø§ÙØ¥Ø¹Ø¯Ø§Ø¯Ø§Øª...) â ÙÙØªÙØ­Ø© ÙØ£Ù Ø­Ø³Ø§Ø¨ team_leaderØ Ø¨ÙØ§ ÙÙÙ
// Ø­Ø³Ø§Ø¨ HR: Ø§ÙÙ HR ÙÙ ÙØ±Ù Ø§ÙØ´Ø±ÙØ© Ø£Ø¹ÙÙ ÙÙ ÙØ§Ø¦Ø¯ Ø§ÙÙØ±ÙÙØ ÙÙØ´ÙÙ ÙÙ Ø­Ø§Ø¬Ø© (ÙØ¨ÙØ¹Ø§Øª
// + HR)â! Ø¨ÙÙÙØ§ ÙØ§Ø¦Ø¯ Ø§ÙÙØ±ÙÙ Ø§ÙØ¹Ø§Ø¯Ù (Ø§ÙÙØ¨ÙØ¹Ø§Øª) ÙØ´ÙÙ ÙØ¨ÙØ¹Ø§ØªÙ Ø¨Ø³ ÙÙØ§ ÙÙØµÙ
// ÙØµÙØ­Ø§Øª HR Ø¹ÙÙ Ø§ÙØ¥Ø·ÙØ§Ù (Ø§ÙØ¸Ø± requireHR).Ø§ÙØ§Ø³ØªØ«ÙØ§Ø¡ Ø§ÙÙØ­ÙØ¯ Ø§ÙÙØ¹ÙÙ ÙÙØ§ ÙÙ
// Ø­Ø³Ø§Ø¨ Ø§ÙÙÙØ¸Ù (role='employee') ÙÙÙ ÙØ§ ÙÙÙØ¹Ù ÙØ°Ø§ Ø§ÙØ­Ø§Ø±Ø³.
export function requireSalesLead(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'team_leader') {
    return jsonError(c, 403, 'ÙØ°Ø§ Ø§ÙØ¥Ø¬Ø±Ø§Ø¡ ÙØ®ØµØ« ÙÙØ§Ø¦Ø¯ Ø§ÙÙØ±ÙÙ', 'FORBIDDEN_SALES_LEAD_ONLY');
  }
  return next();
}

/** Lightweight CSRF defense-in-depth for a same-origin JSON API behind SameSite=Lax cookies. */
export async function requireAppHeader(c, next) {
  if (c.req.header('x-rahma-client') !== 'web') {
    return jsonError(c, 403, 'ØªØ±ÙÙØ³Ø© Ø§ÙØ¹ÙÙÙ ÙÙÙÙØ¯Ø©', 'MISSING_CLIENT_HEADER');
  }
  await next();
}
