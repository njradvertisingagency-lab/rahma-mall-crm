import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomToken } from './passwords.js';
import { nowIso, jsonError, backgroundWrite } from './db.js';
import { sessGet, sessPut, sessDelete } from './sessionStore.js';
import { getShiftGate } from './workhours.js';

export const SESSION_COOKIE = 'rm_session';
const SHORT_SESSION_HOURS = 12;
const REMEMBER_SESSION_DAYS = 30;

// Session storage lives in the SessionStore Durable Object, NOT a D1 table —
// see durable-objects/session-store.js for why (D1's free-tier daily
// row-read quota was being exhausted partly BY this exact query running on
// every single authenticated request app-wide; a DO is a separate resource,
// unaffected by it). The session record below deliberately carries a
// snapshot of the fields requireAuth used to JOIN from the `users` table
// (role, displayName, isOwner, employeeId) so that after login, validating
// a session never touches D1 again for the rest of its lifetime. The
// trade-off: if an account is disabled or its role changes, that only takes
// effect on their NEXT login, not instantly — routes/employees.js's
// password-reset flow already force-revokes sessions for a user, which
// covers the one place in the app that needed instant effect.
export async function createSession(env, user, { remember = false, userAgent = '', employeeId = null, isHr = false } = {}) {
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

/** Attaches c.set('user', {...}) for a valid, unexpired, active session. Reads NO D1 at all. */
export async function requireAuth(c, next) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return jsonError(c, 401, 'لم يتم تسجيل الدخول', 'NO_SESSION');

  let session;
  try {
    session = await sessGet(c.env, token);
  } catch (err) {
    console.error('requireAuth: session store unreachable', err);
    return jsonError(c, 503, 'الخدمة غير متاحة مؤقتًا، برجاء المحاولة بعد لحظات', 'SERVICE_UNAVAILABLE');
  }

  if (!session) {
    clearSessionCookie(c);
    return jsonError(c, 401, 'الجلسة غير صالحة', 'INVALID_SESSION');
  }
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    backgroundWrite(c, () => sessDelete(c.env, token), 'requireAuth expired-session cleanup');
    clearSessionCookie(c);
    return jsonError(c, 401, 'انتهت صلاحية الجلسة', 'SESSION_EXPIRED');
  }
  if (!session.active) return jsonError(c, 403, 'الحساب مُعطَّل', 'ACCOUNT_DISABLED');

  // Outside the shift the system is closed to employees. The Team Leader and
  // the owner account are exempt — they run the business at any hour.
  //
  // Refused here, before any query runs, so a closed system costs nothing at
  // all against the daily database quota. Check-in/check-out get a wider
  // window so arriving a few minutes early is still recordable.
  if (session.role === 'employee' && !session.isOwner) {
    const isAttendance = c.req.path.startsWith('/api/attendance');
    const gate = getShiftGate({ wide: isAttendance });
    if (!gate.open) {
      return c.json(
        {
          error: {
            message: gate.isOffDay
              ? `النظام مغلق اليوم (${gate.weekdayAr}) — مواعيد العمل ${gate.shiftText}. يفتح بعد ${gate.opensInText}.`
              : `النظام خارج مواعيد العمل الآن — مواعيد العمل ${gate.shiftText}. يفتح بعد ${gate.opensInText}.`,
            code: 'OUTSIDE_WORK_HOURS',
            shiftText: gate.shiftText,
            opensInText: gate.opensInText,
            minutesUntilOpen: gate.minutesUntilOpen,
            isOffDay: !!gate.isOffDay,
          },
        },
        403
      );
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

// حساب HR منفصل تمامًا عن قائد الفريق (المبيعات): نفس role='team_leader' في
// قاعدة البيانات (لتجنّب تعديل CHECK constraint على العمود، وهو ممنوع)، لكن
// مفصول عمليًا عبر علم isHr المأخوذ من جدول user_role_flags وقت تسجيل
// الدخول. هذا الحارس يفتح مسارات HR (الإجازات، التقييم، المخالفات، التدريب،
// المستندات، المزايا، الإعلانات، وملفات HR للموظفين) لحساب HR فقط — قائد
// الفريق العادي (المبيعات) لم يعد له وصول لها، وحساب المالك (isOwner) يبقى
// مستثنى لأنه يملك رؤية كاملة على أي حال.
export function requireHR(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'team_leader' || (!user.isHr && !user.isOwner)) {
    return jsonError(c, 403, 'هذا الإجراء مخصص لحساب الموارد البشرية', 'FORBIDDEN_HR_ONLY');
  }
  return next();
}

// عكس requireHR: مسارات المبيعات/CRM (العملاء، التوزيع، المبيعات، الشكاوى،
// مركز التحكم، التحليلات، التقارير، الإعدادات...) مفتوحة لقائد الفريق
// الفعلي فقط، ومحجوبة عن حساب HR تحديدًا. حساب المالك يبقى مستثنى أيضًا.
export function requireSalesLead(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'team_leader' || (user.isHr && !user.isOwner)) {
    return jsonError(c, 403, 'هذا الإجراء مخصص لقائد الفريق', 'FORBIDDEN_SALES_LEAD_ONLY');
  }
  return next();
}

/** Lightweight CSRF defense-in-depth for a same-origin JSON API behind SameSite=Lax cookies. */
export async function requireAppHeader(c, next) {
  if (c.req.header('x-rahma-client') !== 'web') {
    return jsonError(c, 403, 'ترويسة العميل مفقودة', 'MISSING_CLIENT_HEADER');
  }
  await next();
}
