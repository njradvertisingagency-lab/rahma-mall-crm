// Employee presence / session tracking.
//
// employees.availability stays the employee's own MANUAL self-declared status
// (AVAILABLE/BUSY/ON_BREAK/UNAVAILABLE), used for distribution routing — it is
// unchanged by anything in this file.
//
// employee_presence is a SEPARATE, automatic, activity-derived signal:
// ONLINE+ACTIVE / ONLINE+IDLE / OFFLINE. It is only ever set by real signals —
// login, logout, an explicit client heartbeat, and a periodic idle/offline
// sweep — never by a user picking a value, and never fabricated.
//
// Accounting model: total_active_seconds / total_idle_seconds accumulate the
// elapsed wall-clock time each time activity_state actually transitions,
// anchored by last_state_change_at, so time is never double-counted or lost
// between transitions. Reads that need an up-to-the-second total (dashboards)
// add the "still accruing" delta since last_state_change_at on the fly,
// without needing a write on every read.
import { nowIso, broadcast } from './db.js';

export function parseUserAgent(ua) {
  ua = ua || '';
  let device = 'Desktop';
  if (/iPad|Tablet/i.test(ua)) device = 'Tablet';
  else if (/Mobi|Android|iPhone/i.test(ua)) device = 'Mobile';
  let browser = 'Unknown';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome|Chromium/i.test(ua)) browser = 'Safari';
  else if (/Chromium\//i.test(ua)) browser = 'Chromium';
  return { device, browser };
}

const DEFAULT_THRESHOLDS = { idleAfterMinutes: 5, offlineAfterMinutesNoHeartbeat: 15 };

export async function getPresenceThresholds(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'presence_thresholds'`).first();
  if (!row) return { ...DEFAULT_THRESHOLDS };
  try { return { ...DEFAULT_THRESHOLDS, ...JSON.parse(row.value) }; } catch { return { ...DEFAULT_THRESHOLDS }; }
}

async function setPresenceState(db, employeeId, newState, at) {
  const now = at || nowIso();
  const row = await db.prepare(`SELECT activity_state, last_state_change_at FROM employee_presence WHERE employee_id = ?`).bind(employeeId).first();
  if (!row) return null;
  const prevState = row.activity_state;
  const prevChangeAt = row.last_state_change_at || now;
  const deltaSeconds = Math.max(0, Math.round((new Date(now).getTime() - new Date(prevChangeAt).getTime()) / 1000));
  const activeDelta = prevState === 'ACTIVE' ? deltaSeconds : 0;
  const idleDelta = prevState === 'IDLE' ? deltaSeconds : 0;
  await db
    .prepare(
      `UPDATE employee_presence SET online = ?, activity_state = ?, total_active_seconds = total_active_seconds + ?,
       total_idle_seconds = total_idle_seconds + ?, last_state_change_at = ?, updated_at = ? WHERE employee_id = ?`
    )
    .bind(newState === 'OFFLINE' ? 0 : 1, newState, activeDelta, idleDelta, now, now, employeeId)
    .run();
  return { prevState, changed: prevState !== newState };
}

export async function recordLogin(db, env, { userId, employeeId, token, userAgent }) {
  const now = nowIso();
  const { device, browser } = parseUserAgent(userAgent);
  await db
    .prepare(`INSERT INTO employee_sessions (user_id, employee_id, session_token, device, browser, login_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, employeeId, token, device, browser, now, now)
    .run();
  if (!employeeId) return; // Team Leader account: session history only, no live presence row.
  await db
    .prepare(
      `INSERT INTO employee_presence (employee_id, online, activity_state, last_login_at, last_activity_at, current_session_token, current_session_started_at, last_state_change_at, updated_at)
       VALUES (?, 1, 'ACTIVE', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(employee_id) DO UPDATE SET
         online = 1, activity_state = 'ACTIVE', last_login_at = excluded.last_login_at, last_activity_at = excluded.last_activity_at,
         current_session_token = excluded.current_session_token, current_session_started_at = excluded.current_session_started_at,
         last_state_change_at = excluded.last_state_change_at, updated_at = excluded.updated_at`
    )
    .bind(employeeId, now, now, token, now, now, now)
    .run();
  await broadcast(env, 'EMPLOYEE_LOGIN', { employeeId }, { scope: 'role', role: 'team_leader' });
  await broadcast(env, 'EMPLOYEE_ONLINE', { employeeId, activityState: 'ACTIVE' }, { scope: 'role', role: 'team_leader' });
}

export async function recordLogout(db, env, { employeeId, token }) {
  const now = nowIso();
  const sess = await db.prepare(`SELECT id, login_at FROM employee_sessions WHERE session_token = ? AND logout_at IS NULL`).bind(token).first();
  if (sess) {
    const duration = Math.max(0, Math.round((new Date(now).getTime() - new Date(sess.login_at).getTime()) / 1000));
    await db.prepare(`UPDATE employee_sessions SET logout_at = ?, duration_seconds = ?, last_activity_at = ? WHERE id = ?`).bind(now, duration, now, sess.id).run();
  }
  if (!employeeId) return;
  await setPresenceState(db, employeeId, 'OFFLINE', now);
  await db
    .prepare(`UPDATE employee_presence SET last_logout_at = ?, current_session_token = NULL, current_session_started_at = NULL WHERE employee_id = ?`)
    .bind(now, employeeId)
    .run();
  await broadcast(env, 'EMPLOYEE_LOGOUT', { employeeId }, { scope: 'role', role: 'team_leader' });
  await broadcast(env, 'EMPLOYEE_OFFLINE', { employeeId, reason: 'LOGOUT' }, { scope: 'role', role: 'team_leader' });
}

/** Called by the client heartbeat (and any authenticated employee API hit) to prove real activity. */
export async function recordHeartbeat(db, env, employeeId) {
  const now = nowIso();
  const row = await db.prepare(`SELECT activity_state, online FROM employee_presence WHERE employee_id = ?`).bind(employeeId).first();
  if (!row) return { activityState: 'OFFLINE' };
  const wasIdleOrOffline = row.activity_state !== 'ACTIVE' || !row.online;
  if (wasIdleOrOffline) await setPresenceState(db, employeeId, 'ACTIVE', now);
  await db.prepare(`UPDATE employee_presence SET online = 1, last_activity_at = ?, updated_at = ? WHERE employee_id = ?`).bind(now, now, employeeId).run();
  await db.prepare(`UPDATE employee_sessions SET last_activity_at = ? WHERE employee_id = ? AND logout_at IS NULL`).bind(now, employeeId).run();
  if (wasIdleOrOffline) await broadcast(env, 'EMPLOYEE_ACTIVE', { employeeId }, { scope: 'role', role: 'team_leader' });
  return { activityState: 'ACTIVE' };
}

/**
 * Cron sweep: ACTIVE employees who haven't sent a heartbeat within
 * idleAfterMinutes become IDLE; anyone (ACTIVE or IDLE) silent for
 * offlineAfterMinutesNoHeartbeat is force-marked OFFLINE (covers a closed tab
 * / crashed browser / dead laptop battery that never called /logout) and
 * their still-open session row is closed out with a real duration.
 */
export async function sweepPresence(db, env) {
  const thresholds = await getPresenceThresholds(db);
  const now = nowIso();
  const idleCutoff = new Date(Date.now() - thresholds.idleAfterMinutes * 60000).toISOString();
  const offlineCutoff = new Date(Date.now() - thresholds.offlineAfterMinutesNoHeartbeat * 60000).toISOString();

  const toIdle = await db
    .prepare(`SELECT employee_id FROM employee_presence WHERE online = 1 AND activity_state = 'ACTIVE' AND last_activity_at < ?`)
    .bind(idleCutoff)
    .all();
  for (const row of toIdle.results) {
    await setPresenceState(db, row.employee_id, 'IDLE', now);
    await broadcast(env, 'EMPLOYEE_IDLE', { employeeId: row.employee_id }, { scope: 'role', role: 'team_leader' });
  }

  const toOffline = await db
    .prepare(`SELECT employee_id, current_session_token FROM employee_presence WHERE online = 1 AND last_activity_at < ?`)
    .bind(offlineCutoff)
    .all();
  for (const row of toOffline.results) {
    await setPresenceState(db, row.employee_id, 'OFFLINE', now);
    await db
      .prepare(`UPDATE employee_presence SET last_logout_at = ?, current_session_token = NULL, current_session_started_at = NULL WHERE employee_id = ?`)
      .bind(now, row.employee_id)
      .run();
    if (row.current_session_token) {
      const sess = await db.prepare(`SELECT id, login_at FROM employee_sessions WHERE session_token = ? AND logout_at IS NULL`).bind(row.current_session_token).first();
      if (sess) {
        const duration = Math.max(0, Math.round((new Date(now).getTime() - new Date(sess.login_at).getTime()) / 1000));
        await db.prepare(`UPDATE employee_sessions SET logout_at = ?, duration_seconds = ? WHERE id = ?`).bind(now, duration, sess.id).run();
      }
    }
    await broadcast(env, 'EMPLOYEE_OFFLINE', { employeeId: row.employee_id, reason: 'TIMEOUT' }, { scope: 'role', role: 'team_leader' });
  }
  return { idled: toIdle.results.length, offlined: toOffline.results.length };
}

/** Live presence snapshot for every employee, with "still accruing" time added on read (never written). */
export async function getEmployeePresenceMap(db) {
  const rows = await db.prepare(`SELECT * FROM employee_presence`).all();
  const now = Date.now();
  const map = {};
  for (const r of rows.results) {
    const accruing = r.online && r.last_state_change_at ? Math.max(0, Math.round((now - new Date(r.last_state_change_at).getTime()) / 1000)) : 0;
    map[r.employee_id] = {
      online: !!r.online,
      activityState: r.activity_state,
      lastLoginAt: r.last_login_at,
      lastLogoutAt: r.last_logout_at,
      lastActivityAt: r.last_activity_at,
      currentSessionStartedAt: r.current_session_started_at,
      currentSessionDurationSeconds: r.online && r.current_session_started_at ? Math.max(0, Math.round((now - new Date(r.current_session_started_at).getTime()) / 1000)) : 0,
      idleForSeconds: r.online && r.activity_state === 'IDLE' ? accruing : 0,
      totalActiveSeconds: r.total_active_seconds + (r.online && r.activity_state === 'ACTIVE' ? accruing : 0),
      totalIdleSeconds: r.total_idle_seconds + (r.online && r.activity_state === 'IDLE' ? accruing : 0),
    };
  }
  return map;
}

export async function getEmployeePresence(db, employeeId) {
  const map = await getEmployeePresenceMap(db);
  return map[employeeId] || { online: false, activityState: 'OFFLINE', totalActiveSeconds: 0, totalIdleSeconds: 0 };
}

/**
 * "How much time has this employee actually spent online" — for the
 * employee's own "أدائي" page, not a team-leader oversight view.
 *
 * todaySeconds/weekSeconds are built from employee_sessions (real login→logout
 * spans, or login→now for a still-open session), keyed off each session's
 * login_at. A session that happens to straddle midnight is counted entirely
 * under the day it started — sessions are auto-closed after
 * offlineAfterMinutesNoHeartbeat (see sweepPresence) whenever a tab is left
 * open overnight, so in practice this never spans more than a few minutes
 * past midnight and is never worth the extra complexity of splitting it.
 *
 * allTimeSeconds instead comes straight from employee_presence's running
 * total_active_seconds + total_idle_seconds (with "still accruing" time
 * added live) — a lifetime counter that never resets and can't drift from
 * the session log, so it stays the source of truth for "all time".
 */
export async function getEmployeeOnlineTimeSummary(db, employeeId) {
  const now = Date.now();
  const todayStartIso = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
  const weekStartIso = new Date(now - 7 * 86400000).toISOString();

  const [sessionsThisWeek, totalSessionsRow, presence] = await Promise.all([
    db.prepare(`SELECT login_at, logout_at, duration_seconds FROM employee_sessions WHERE employee_id = ? AND login_at >= ? ORDER BY login_at ASC`).bind(employeeId, weekStartIso).all(),
    db.prepare(`SELECT COUNT(*) AS n FROM employee_sessions WHERE employee_id = ?`).bind(employeeId).first(),
    getEmployeePresence(db, employeeId),
  ]);

  let todaySeconds = 0;
  let weekSeconds = 0;
  for (const s of sessionsThisWeek.results) {
    const loginMs = new Date(s.login_at).getTime();
    const dur = s.logout_at != null && s.duration_seconds != null
      ? s.duration_seconds
      : Math.max(0, Math.round((now - loginMs) / 1000)); // still-open session — count up to right now
    weekSeconds += dur;
    if (loginMs >= new Date(todayStartIso).getTime()) todaySeconds += dur;
  }

  return {
    todaySeconds,
    weekSeconds,
    allTimeSeconds: presence.totalActiveSeconds + presence.totalIdleSeconds,
    totalSessions: totalSessionsRow?.n ?? 0,
    online: presence.online,
    activityState: presence.activityState,
    currentSessionDurationSeconds: presence.currentSessionDurationSeconds,
    lastLoginAt: presence.lastLoginAt,
    lastLogoutAt: presence.lastLogoutAt,
  };
}
