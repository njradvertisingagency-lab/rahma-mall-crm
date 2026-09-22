// Dedicated check-in/check-out attendance system — SEPARATE from
// login/logout (worker/src/lib/presence.js) and separate from the manual
// "availability" status. Visible to and usable by EVERYONE, including the
// Team Leader account itself. Mr. Hany's big dashboard (getAttendanceDashboard
// below) reads this data for every team_leader/employee account, so the
// regular Team Leader's own attendance is visible to him too, per his
// explicit request.
//
// Storage: the AttendanceStore Durable Object (lib/attendanceStore.js), NOT
// a D1 table — see durable-objects/attendance-store.js for why. Every
// notification/activity-log call below (which DOES still use D1, since
// those tables already exist) is wrapped best-effort: if D1 happens to be
// unavailable at that instant, the check-in/check-out/penalty itself still
// succeeds and is durably recorded — only the notification might be missed
// — matching the same "the real mutation must never fail because a
// side-effect hiccupped" philosophy as broadcast() in lib/db.js.
import { nowIso, createNotification, broadcast, logActivity } from './db.js';
import { getWorkHoursStatus } from './workhours.js';
import { asGet, asPut, asList } from './attendanceStore.js';

export const MONTHLY_LATE_ALLOWANCE = 3;

function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function recordKey(workDate, userId) {
  return `att:${workDate}:${userId}`;
}

function monthRecordPrefix(month) {
  return `att:${month}-`; // workDate is always YYYY-MM-DD, so "att:2026-09-" only ever matches September
}

function penaltyPrefix(month) {
  return `pen:${month}:`;
}

function penaltyKey(month, userId, ts) {
  return `pen:${month}:${userId}:${ts}`;
}

async function safeNotify(db, args) {
  try {
    await createNotification(db, args);
  } catch (err) {
    console.error('attendance: notification failed (best-effort, non-fatal)', err);
  }
}

async function safeLog(db, args) {
  try {
    await logActivity(db, args);
  } catch (err) {
    console.error('attendance: activity log failed (best-effort, non-fatal)', err);
  }
}

async function countLateThisMonth(env, userId, month) {
  const entries = await asList(env, monthRecordPrefix(month));
  return entries.filter((e) => e.value?.userId === userId && e.value?.isLate).length;
}

/** The logged-in user's own today status + this month's late tally, for the topbar widget. */
export async function getMyAttendanceStatus(env, userId) {
  const status = await getWorkHoursStatus(env.DB);
  const record = await asGet(env, recordKey(status.dateStr, userId));
  const lateCount = await countLateThisMonth(env, userId, monthOf(status.dateStr));
  return {
    dateStr: status.dateStr,
    isHolidayToday: status.isHolidayToday,
    checkedInAt: record?.checkInAt || null,
    checkedOutAt: record?.checkOutAt || null,
    isLate: !!record?.isLate,
    lateMinutes: record?.lateMinutes ?? null,
    lateCountThisMonth: lateCount,
    remainingLateAllowance: Math.max(0, MONTHLY_LATE_ALLOWANCE - lateCount),
  };
}

export async function recordCheckIn(env, user) {
  const status = await getWorkHoursStatus(env.DB);
  const key = recordKey(status.dateStr, user.id);
  const existing = await asGet(env, key);
  if (existing?.checkInAt) {
    return { error: 'ALREADY_CHECKED_IN', message: 'تم تسجيل حضورك بالفعل اليوم' };
  }

  const now = nowIso();
  const isLate = !status.isHolidayToday && status.minutesSinceMidnight > status.startMin;
  const lateMinutes = isLate ? status.minutesSinceMidnight - status.startMin : 0;

  await asPut(env, key, {
    userId: user.id,
    workDate: status.dateStr,
    checkInAt: now,
    checkOutAt: existing?.checkOutAt || null,
    isLate,
    lateMinutes,
    updatedAt: now,
  });

  await broadcast(env, 'ATTENDANCE_CHECKED_IN', { userId: user.id, checkedInAt: now, isLate }, { scope: 'role', role: 'team_leader' });
  await safeLog(env.DB, { actor: user, action: 'ATTENDANCE_CHECK_IN', entityType: 'user', entityId: String(user.id), metadata: { isLate, lateMinutes } });

  let penalty = null;
  if (isLate) {
    const month = monthOf(status.dateStr);
    const lateCount = await countLateThisMonth(env, user.id, month);
    const label = user.displayName || user.username;

    let leaders = [];
    try {
      leaders = (await env.DB.prepare(`SELECT id FROM users WHERE role = 'team_leader' AND active = 1`).all()).results;
    } catch (err) {
      console.error('attendance: could not load team_leader accounts to notify (best-effort, non-fatal)', err);
    }
    for (const tl of leaders) {
      await safeNotify(env.DB, {
        userId: tl.id,
        type: 'LATE_CHECKIN',
        title: '⏰ حضور متأخر',
        message: `${label} سجّل حضوره متأخرًا بـ ${lateMinutes} دقيقة اليوم (${pad(status.settings.startHour)}:${pad(status.settings.startMinute)} بداية الدوام).`,
        entityType: 'user',
        entityId: String(user.id),
      });
    }

    if (lateCount > MONTHLY_LATE_ALLOWANCE) {
      const ts = Date.now();
      await asPut(env, penaltyKey(month, user.id, ts), { userId: user.id, month, lateCountAtPenalty: lateCount, createdAt: now });

      let owners = [];
      try {
        owners = (await env.DB.prepare(`SELECT id FROM users WHERE is_owner = 1 AND active = 1`).all()).results;
      } catch (err) {
        console.error('attendance: could not load owner accounts to notify (best-effort, non-fatal)', err);
      }
      const penaltyMessage = `${label} تجاوز الحد المسموح (${MONTHLY_LATE_ALLOWANCE} مرات تأخير شهريًا) — هذا التأخير رقم ${lateCount} هذا الشهر.`;
      for (const o of owners) {
        await safeNotify(env.DB, { userId: o.id, type: 'ATTENDANCE_PENALTY', title: '🚫 مخالفة تأخير', message: penaltyMessage, entityType: 'user', entityId: String(user.id) });
      }
      if (owners.length > 0) {
        await broadcast(env, 'ATTENDANCE_PENALTY', { userId: user.id, lateCount, month }, { scope: 'users', userIds: owners.map((o) => o.id) });
      }
      penalty = { lateCount, month };
    }
  }

  return { checkedInAt: now, isLate, lateMinutes, penalty };
}

export async function recordCheckOut(env, user) {
  const status = await getWorkHoursStatus(env.DB);
  const key = recordKey(status.dateStr, user.id);
  const existing = await asGet(env, key);
  if (!existing?.checkInAt) {
    return { error: 'NOT_CHECKED_IN', message: 'لم تسجّل حضورك اليوم بعد' };
  }
  if (existing.checkOutAt) {
    return { error: 'ALREADY_CHECKED_OUT', message: 'تم تسجيل انصرافك بالفعل اليوم' };
  }

  const now = nowIso();
  await asPut(env, key, { ...existing, checkOutAt: now, updatedAt: now });
  await broadcast(env, 'ATTENDANCE_CHECKED_OUT', { userId: user.id, checkedOutAt: now }, { scope: 'role', role: 'team_leader' });
  await safeLog(env.DB, { actor: user, action: 'ATTENDANCE_CHECK_OUT', entityType: 'user', entityId: String(user.id) });
  return { checkedOutAt: now };
}

/** Fewest late check-ins this month for a user — used by lib/reclaim.js's "best teammate" ranking. */
export async function getLateCountThisMonth(env, userId, month) {
  return countLateThisMonth(env, userId, month);
}

/**
 * Mr. Hany's big single-page dashboard: every team_leader/employee account's
 * arrival time, departure time, a same-day activity summary (calls made,
 * customers closed — reusing the exact real queries lib/opsreports.js
 * already uses for the end-of-shift report, nothing invented), hours worked
 * that day, and this month's lateness/penalty tally — all for one chosen
 * Cairo calendar day (defaults to today).
 */
export async function getAttendanceDashboard(env, { date } = {}) {
  const status = await getWorkHoursStatus(env.DB);
  const dateStr = date || status.dateStr;
  const month = monthOf(dateStr);

  const people = (
    await env.DB
      .prepare(
        `SELECT u.id AS user_id, u.display_name, u.role, u.is_owner, e.id AS employee_id, e.name, e.name_ar
         FROM users u LEFT JOIN employees e ON e.user_id = u.id
         WHERE u.active = 1 AND u.role IN ('team_leader', 'employee')
         ORDER BY u.role DESC, e.name COLLATE NOCASE`
      )
      .all()
  ).results;

  let callsByEmp = {};
  let closedByEmp = {};
  try {
    const dayStart = dateStr + 'T00:00:00.000Z';
    const dayEnd = dateStr + 'T23:59:59.999Z';
    const [callsRows, closedRows] = await Promise.all([
      env.DB.prepare(`SELECT employee_id, COUNT(*) AS n FROM call_attempts WHERE created_at >= ? AND created_at <= ? GROUP BY employee_id`).bind(dayStart, dayEnd).all(),
      env.DB
        .prepare(
          `SELECT c.assigned_employee_id AS employee_id, COUNT(*) AS n
           FROM customer_status_history h JOIN customers c ON c.id = h.customer_id
           WHERE h.to_status = 'CLOSED' AND h.changed_at >= ? AND h.changed_at <= ? GROUP BY c.assigned_employee_id`
        )
        .bind(dayStart, dayEnd)
        .all(),
    ]);
    callsByEmp = Object.fromEntries(callsRows.results.map((r) => [r.employee_id, r.n]));
    closedByEmp = Object.fromEntries(closedRows.results.map((r) => [r.employee_id, r.n]));
  } catch (err) {
    console.error('attendance dashboard: calls/closed-today unavailable (D1), showing zeros', err);
  }

  const monthEntries = await asList(env, monthRecordPrefix(month));
  const dayRecordByUser = {};
  const lateCountByUser = {};
  for (const { value: rec } of monthEntries) {
    if (!rec) continue;
    lateCountByUser[rec.userId] = (lateCountByUser[rec.userId] || 0) + (rec.isLate ? 1 : 0);
    if (rec.workDate === dateStr) dayRecordByUser[rec.userId] = rec;
  }
  const penaltyEntries = await asList(env, penaltyPrefix(month));
  const penaltyCountByUser = {};
  for (const { value: p } of penaltyEntries) {
    if (!p) continue;
    penaltyCountByUser[p.userId] = (penaltyCountByUser[p.userId] || 0) + 1;
  }

  const now = Date.now();
  const rows = people.map((p) => {
    const record = dayRecordByUser[p.user_id];
    let hoursSeconds = 0;
    if (record?.checkInAt) {
      const endMs = record.checkOutAt ? new Date(record.checkOutAt).getTime() : (dateStr === status.dateStr ? now : new Date(record.checkInAt).getTime());
      hoursSeconds = Math.max(0, Math.round((endMs - new Date(record.checkInAt).getTime()) / 1000));
    }
    return {
      userId: p.user_id,
      employeeId: p.employee_id,
      name: p.name_ar ? `${p.name} (${p.name_ar})` : p.name || p.display_name,
      role: p.role,
      isOwner: !!p.is_owner,
      checkInAt: record?.checkInAt || null,
      checkOutAt: record?.checkOutAt || null,
      isLate: !!record?.isLate,
      lateMinutes: record?.lateMinutes ?? null,
      hoursWorkedSeconds: hoursSeconds,
      callsToday: (p.employee_id != null ? callsByEmp[p.employee_id] : null) || 0,
      closedToday: (p.employee_id != null ? closedByEmp[p.employee_id] : null) || 0,
      lateCountThisMonth: lateCountByUser[p.user_id] || 0,
      penaltyCountThisMonth: penaltyCountByUser[p.user_id] || 0,
    };
  });

  return { dateStr, isHolidayToday: status.isHolidayToday, people: rows };
}
