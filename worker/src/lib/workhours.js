// Business-hours automation: a single shared "work_hours" config (used by
// the late-attendance alert, the automatic outside-hours Do-Not-Disturb, and
// both admin ops reports in lib/opsreports.js) plus the two sweeps that only
// need the config itself. Kept separate from lib/dnd.js (the *manual*,
// employee-chosen temporary DND with its own short-lived dnd_until revert)
// and from lib/presence.js (the online/idle/offline signal) — this file only
// ever touches employees.availability for the OFF-HOURS case, and only ever
// touches employees.last_late_alert_date, never anything presence-related.
import { nowIso, broadcast, createNotification } from './db.js';

const DEFAULT_WORK_HOURS = { startHour: 10, startMinute: 0, endHour: 18, endMinute: 0, lateAfterMinutes: 15, holidayWeekdays: ['Thursday', 'Friday'] };
const TIMEZONE = 'Africa/Cairo';

/** Full English weekday name for Cairo "now" (e.g. "Thursday") — used only to compare against settings.holidayWeekdays. */
export function getCairoWeekday() {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long' }).format(new Date());
}

export async function getWorkHoursSettings(db) {
  // Wrapped end-to-end (not just the JSON.parse) so a D1 hiccup — the free
  // tier's daily read quota has been unpredictable, even for tiny reads on
  // an existing table — degrades to sane defaults instead of throwing and
  // taking down every caller (attendance, off-hours DND, ops reports,
  // auto-reclaim all start from this).
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key = 'work_hours'`).first();
    if (!row) return { ...DEFAULT_WORK_HOURS };
    return { ...DEFAULT_WORK_HOURS, ...JSON.parse(row.value) };
  } catch (err) {
    console.error('getWorkHoursSettings: D1 unavailable, using defaults', err);
    return { ...DEFAULT_WORK_HOURS };
  }
}

/**
 * Egypt-local "now" as a comparable minute-of-day plus a YYYY-MM-DD date
 * string — read straight from Intl's Africa/Cairo timezone data rather than
 * a hardcoded UTC offset, so Cairo's own DST rules (whatever they are in a
 * given year) are always right without needing a code change.
 */
export function getCairoNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour')) % 24; // some engines report midnight as "24"
  const minute = Number(get('minute'));
  return { dateStr, minutesSinceMidnight: hour * 60 + minute };
}

function toMinutes(h, m) {
  return h * 60 + m;
}

/**
 * Tick-throttling gate for cron sweeps that don't need to run on every
 * invocation — e.g. a sweep that only needs hourly freshness still fires on
 * every-5-minute or every-1-minute cron trigger, so without this it re-runs
 * (and re-reads D1) far more often than the data actually needs, which is
 * exactly what was exhausting the free-tier daily row-read quota mid-morning.
 * `tickSpacingMinutes` must match the cron's own interval (1 for the
 * once-a-minute trigger, 5 for the every-5-minutes trigger) so exactly one
 * tick per `intervalMinutes` window passes the gate — e.g. isDueEvery(60, 5)
 * fires once per hour on the 5-minute cron, isDueEvery(3, 1) fires once
 * every 3 minutes on the 1-minute cron.
 */
export function isDueEvery(intervalMinutes, tickSpacingMinutes = 5) {
  const { minutesSinceMidnight } = getCairoNow();
  return minutesSinceMidnight % intervalMinutes < tickSpacingMinutes;
}

/**
 * The UTC instant range covering one Cairo calendar day (e.g. "2026-09-22"
 * 00:00:00 through 23:59:59.999, Cairo-local) — computed from Cairo's actual
 * current UTC offset via Intl rather than a hardcoded +2/+3, so it stays
 * correct whichever DST rule is in effect for that date. Used anywhere a
 * report needs to scope a query to "that Cairo business day" precisely
 * (attendance dashboard, per-day call/closed counts) instead of drifting by
 * a couple of hours the way a naive `dateStr + 'T00:00:00Z'` would.
 */
export function getCairoDayBoundsUtc(dateStr) {
  const naiveUtc = new Date(`${dateStr}T00:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(naiveUtc);
  const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  const dayStartUtcMs = naiveUtc.getTime() - (h * 60 + m) * 60000;
  const dayEndUtcMs = dayStartUtcMs + 24 * 3600 * 1000 - 1;
  return { dayStartIso: new Date(dayStartUtcMs).toISOString(), dayEndIso: new Date(dayEndUtcMs).toISOString() };
}

export async function getWorkHoursStatus(db) {
  const settings = await getWorkHoursSettings(db);
  const { dateStr, minutesSinceMidnight } = getCairoNow();
  const startMin = toMinutes(settings.startHour, settings.startMinute);
  const endMin = toMinutes(settings.endHour, settings.endMinute);
  const lateCutoff = startMin + settings.lateAfterMinutes;
  const holidayWeekdays = Array.isArray(settings.holidayWeekdays) ? settings.holidayWeekdays : DEFAULT_WORK_HOURS.holidayWeekdays;
  const isHolidayToday = holidayWeekdays.includes(getCairoWeekday());
  return {
    settings,
    dateStr,
    minutesSinceMidnight,
    startMin,
    endMin,
    lateCutoff,
    isHolidayToday,
    // A holiday is never "work hours", whatever the clock says — Thursday/
    // Friday (by default) count as a full day off for everyone.
    isWorkHoursNow: !isHolidayToday && minutesSinceMidnight >= startMin && minutesSinceMidnight < endMin,
    isPastLateCutoff: !isHolidayToday && minutesSinceMidnight >= lateCutoff,
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// 1) LATE ATTENDANCE — once per employee per Cairo calendar day, and never
// on a holiday. Fires on the first cron tick after the cutoff (start +
// lateAfterMinutes) that finds the employee hasn't logged in yet today, and
// stops re-checking them once alerted (last_late_alert_date = today) —
// whether they log in five minutes later or never show up at all. Reaches
// every team_leader-role account: the real Team Leader AND Mr. Hany's admin
// account both carry that role, so both are meant to see this one (unlike
// the two ops reports below and the monthly penalty alert, which are
// owner-only).
//
// NOTE: this is a login-based check (employee_sessions), same signal used
// before the dedicated check-in/check-out attendance system existed. Once
// lib/attendance.js's attendance_records table is live, this should switch
// to reading real check-in times from there instead — more accurate, since
// an employee can be logged in without having tapped "check in" yet. Left
// as login-based for now purely because the attendance table doesn't exist
// in the live database yet; nothing here is blocked on that.
// ---------------------------------------------------------------------------
export async function sweepLateAttendance(db, env) {
  const status = await getWorkHoursStatus(db);
  // Only worth checking during the work day itself — never in the evening/
  // night for a day that's already over, and never on a holiday.
  if (!status.isPastLateCutoff || status.minutesSinceMidnight >= status.endMin) return { alerted: 0 };

  const { dayStartIso } = getCairoDayBoundsUtc(status.dateStr);
  const employees = await db
    .prepare(
      `SELECT e.id, e.name, e.name_ar,
              (SELECT 1 FROM employee_sessions es WHERE es.employee_id = e.id AND es.login_at >= ? LIMIT 1) AS logged_in_today
       FROM employees e
       WHERE e.active = 1 AND (e.last_late_alert_date IS NULL OR e.last_late_alert_date != ?)`
    )
    .bind(dayStartIso, status.dateStr)
    .all();
  if (employees.results.length === 0) return { alerted: 0 };

  const leaders = await db.prepare(`SELECT id FROM users WHERE role = 'team_leader' AND active = 1`).all();
  let alerted = 0;
  for (const emp of employees.results) {
    if (emp.logged_in_today) continue; // already logged in today — nothing to alert about
    const label = emp.name_ar ? `${emp.name} (${emp.name_ar})` : emp.name;
    const title = '⏰ تأخر عن الحضور';
    const message = `${label} لم يسجّل حضوره بعد رغم مرور ${status.settings.lateAfterMinutes} دقيقة على بدء الدوام (${pad(status.settings.startHour)}:${pad(status.settings.startMinute)} صباحًا).`;
    for (const tl of leaders.results) {
      await createNotification(db, { userId: tl.id, type: 'LATE_ATTENDANCE', title, message, entityType: 'employee', entityId: String(emp.id) });
    }
    await broadcast(env, 'LATE_ATTENDANCE', { employeeId: emp.id }, { scope: 'role', role: 'team_leader' });
    await db.prepare(`UPDATE employees SET last_late_alert_date = ? WHERE id = ?`).bind(status.dateStr, emp.id).run();
    alerted++;
  }
  return { alerted };
}

// ---------------------------------------------------------------------------
// 2) AUTO OFF-HOURS AVAILABILITY — outside the work-hours window, any
// employee still showing AVAILABLE/BUSY/ON_BREAK is automatically switched
// to UNAVAILABLE, with their prior value remembered (pre_off_hours_availability)
// so it can be restored exactly once work hours start again — never just
// reset to AVAILABLE. Skips anyone already in a manual temporary DND
// (dnd_until IS NOT NULL — that has its own shorter-lived revert in
// lib/dnd.js) and anyone already switched by this sweep (off_hours_auto=1).
// The morning restore only ever touches employees THIS sweep switched — any
// manual availability/DND change during the night clears the flag (see
// routes/employees.js), so a manual choice always wins and is never
// silently overwritten the next morning.
// ---------------------------------------------------------------------------
export async function sweepOffHoursAvailability(db, env) {
  const status = await getWorkHoursStatus(db);
  const now = nowIso();

  if (!status.isWorkHoursNow) {
    const toSwitch = await db
      .prepare(`SELECT id, availability FROM employees WHERE active = 1 AND off_hours_auto = 0 AND dnd_until IS NULL AND availability != 'UNAVAILABLE'`)
      .all();
    for (const emp of toSwitch.results) {
      await db
        .prepare(`UPDATE employees SET availability = 'UNAVAILABLE', off_hours_auto = 1, pre_off_hours_availability = ?, updated_at = ? WHERE id = ?`)
        .bind(emp.availability, now, emp.id)
        .run();
      await broadcast(env, 'EMPLOYEE_AVAILABILITY_CHANGED', { employeeId: emp.id, availability: 'UNAVAILABLE', offHoursAuto: true }, { scope: 'role', role: 'team_leader' });
    }
    return { switchedOff: toSwitch.results.length, restored: 0 };
  }

  const toRestore = await db.prepare(`SELECT id, pre_off_hours_availability FROM employees WHERE active = 1 AND off_hours_auto = 1`).all();
  for (const emp of toRestore.results) {
    const restoreTo = ['AVAILABLE', 'BUSY', 'ON_BREAK', 'UNAVAILABLE'].includes(emp.pre_off_hours_availability) ? emp.pre_off_hours_availability : 'AVAILABLE';
    await db
      .prepare(`UPDATE employees SET availability = ?, off_hours_auto = 0, pre_off_hours_availability = NULL, updated_at = ? WHERE id = ?`)
      .bind(restoreTo, now, emp.id)
      .run();
    await broadcast(env, 'EMPLOYEE_AVAILABILITY_CHANGED', { employeeId: emp.id, availability: restoreTo, offHoursAuto: false }, { scope: 'role', role: 'team_leader' });
  }
  return { switchedOff: 0, restored: toRestore.results.length };
}

// ---------------------------------------------------------------------------
// Shift gate — employees may only use the system during the shift.
//
// The Team Leader and the owner account are exempt and work around the clock.
// For everyone else the system simply closes outside the shift: the request is
// refused before it touches the database, which is a large part of why the
// daily read quota used to run out overnight.
//
// Hardcoded and D1-free on purpose: this runs on EVERY request, so reading the
// configurable work_hours row here would cost exactly the reads the gate
// exists to save. If the shift moves, change it here.
// ---------------------------------------------------------------------------
const SHIFT_START_MIN = 10 * 60;      // 10:00
const SHIFT_END_MIN = 18 * 60;        // 18:00
// Checking in and out must stay possible a little either side of the shift,
// otherwise someone arriving at 09:58 is locked out of recording it.
const ATTENDANCE_START_MIN = 9 * 60;  // 09:00
const ATTENDANCE_END_MIN = 20 * 60;   // 20:00
const SHIFT_OFF_WEEKDAYS = ['Thursday', 'Friday'];
const WEEK_ORDER = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const WEEKDAY_AR = {
  Saturday: 'السبت', Sunday: 'الأحد', Monday: 'الاثنين', Tuesday: 'الثلاثاء',
  Wednesday: 'الأربعاء', Thursday: 'الخميس', Friday: 'الجمعة',
};

function formatDelay(minutes) {
  if (minutes <= 0) return 'الآن';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return `${h} ساعة`;
  return `${h} ساعة و ${m} دقيقة`;
}

/**
 * Is the system open for an employee right now?
 * `wide` widens the window, for check-in/check-out only.
 */
export function getShiftGate({ wide = false } = {}) {
  const startMin = wide ? ATTENDANCE_START_MIN : SHIFT_START_MIN;
  const endMin = wide ? ATTENDANCE_END_MIN : SHIFT_END_MIN;

  let weekday;
  let minutesSinceMidnight;
  try {
    weekday = getCairoWeekday();
    ({ minutesSinceMidnight } = getCairoNow());
  } catch (err) {
    // If the clock lookup ever fails, stay OPEN — locking the whole team out
    // over a timezone hiccup is far worse than a few extra queries.
    console.error('shift gate: clock lookup failed, staying open', err);
    return { open: true };
  }

  const isOffDay = SHIFT_OFF_WEEKDAYS.includes(weekday);
  if (!isOffDay && minutesSinceMidnight >= startMin && minutesSinceMidnight < endMin) {
    return { open: true };
  }

  // Work out when it opens again, so the message can say how long is left.
  let minutesUntilOpen;
  if (!isOffDay && minutesSinceMidnight < startMin) {
    minutesUntilOpen = startMin - minutesSinceMidnight;
  } else {
    // Today is done (or is an off day) — find the next working day.
    let days = 1;
    let next = WEEK_ORDER[(WEEK_ORDER.indexOf(weekday) + 1) % 7];
    while (SHIFT_OFF_WEEKDAYS.includes(next)) {
      days += 1;
      next = WEEK_ORDER[(WEEK_ORDER.indexOf(next) + 1) % 7];
    }
    minutesUntilOpen = days * 24 * 60 - minutesSinceMidnight + startMin;
  }

  return {
    open: false,
    isOffDay,
    weekdayAr: WEEKDAY_AR[weekday] || weekday,
    minutesUntilOpen,
    opensInText: formatDelay(minutesUntilOpen),
    shiftText: 'من ١٠:٠٠ صباحًا إلى ٦:٠٠ مساءً — عدا الخميس والجمعة',
  };
}
