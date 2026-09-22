// Two admin-only operational reports for the business owner (Mr. Hany's
// admin account — users.is_owner = 1) — the regular Team Leader account
// never sees these, only the late-attendance alert in lib/workhours.js is
// shared with them. Both reports are computed live from the exact same real
// queries the rest of the app already uses (Command Center's Needs-Attention
// queue, today's sales, call attempts, and the CLOSED status-history trail),
// so there is nothing new to keep in sync and nothing invented.
//
// Available two ways: on demand (GET /api/ops-reports/..., used by the
// topbar button that only renders for an owner account), and automatically
// once a day as an in-app notification (the cron sweep below), sent ONLY to
// is_owner accounts.
import { nowIso, createNotification, broadcast } from './db.js';
import { getNeedsAttentionQueue, getSalesToday } from './commandcenter.js';
import { getEmployeePresenceMap } from './presence.js';
import { getWorkHoursStatus } from './workhours.js';

function todayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function getStartOfDayReport(db) {
  const [attentionItems, overdueFollowups, presenceMap] = await Promise.all([
    getNeedsAttentionQueue(db),
    db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now'))`).first(),
    getEmployeePresenceMap(db),
  ]);
  const presenceValues = Object.values(presenceMap);
  return {
    generatedAt: nowIso(),
    overdueFollowupsCount: overdueFollowups.n,
    attentionItems,
    onlineNow: presenceValues.filter((p) => p.online).length,
    totalEmployees: presenceValues.length,
  };
}

export function formatStartOfDayMessage(report) {
  const parts = [`🟢 ${report.onlineNow}/${report.totalEmployees} موظف أونلاين الآن`];
  if (report.overdueFollowupsCount > 0) parts.push(`⏰ ${report.overdueFollowupsCount} متابعة متأخرة`);
  if (report.attentionItems.length > 0) parts.push(...report.attentionItems.slice(0, 3).map((i) => i.label));
  else parts.push('لا يوجد ما يحتاج انتباه فوري');
  return parts.join(' — ');
}

export async function getEndOfShiftReport(db) {
  const todayStart = todayStartIso();
  const [sales, employees, callsRows, closedRows] = await Promise.all([
    getSalesToday(db),
    db.prepare(`SELECT id, name, name_ar FROM employees WHERE active = 1`).all(),
    db.prepare(`SELECT employee_id, COUNT(*) AS n FROM call_attempts WHERE created_at >= ? GROUP BY employee_id`).bind(todayStart).all(),
    db
      .prepare(
        `SELECT c.assigned_employee_id AS employee_id, COUNT(*) AS n
         FROM customer_status_history h JOIN customers c ON c.id = h.customer_id
         WHERE h.to_status = 'CLOSED' AND h.changed_at >= ? GROUP BY c.assigned_employee_id`
      )
      .bind(todayStart)
      .all(),
  ]);

  const callsByEmp = Object.fromEntries(callsRows.results.map((r) => [r.employee_id, r.n]));
  const closedByEmp = Object.fromEntries(closedRows.results.map((r) => [r.employee_id, r.n]));

  const perEmployee = employees.results.map((e) => ({
    employeeId: e.id,
    name: e.name_ar ? `${e.name} (${e.name_ar})` : e.name,
    callsToday: callsByEmp[e.id] || 0,
    closedToday: closedByEmp[e.id] || 0,
  }));

  const totalCallsToday = perEmployee.reduce((s, e) => s + e.callsToday, 0);
  const totalClosedToday = perEmployee.reduce((s, e) => s + e.closedToday, 0);
  const topPerformer = perEmployee.reduce((best, e) => {
    if (e.closedToday === 0 && e.callsToday === 0) return best;
    if (!best || e.closedToday > best.closedToday || (e.closedToday === best.closedToday && e.callsToday > best.callsToday)) return e;
    return best;
  }, null);

  return {
    generatedAt: nowIso(),
    dealsToday: sales.dealsToday,
    netRevenueToday: sales.netRevenueToday,
    totalCallsToday,
    totalClosedToday,
    perEmployee,
    topPerformer,
  };
}

export function formatEndOfShiftMessage(report) {
  const parts = [`📞 ${report.totalCallsToday} مكالمة`, `✅ ${report.totalClosedToday} عميل مغلق`, `💰 ${report.netRevenueToday.toLocaleString()} ج.م`];
  if (report.topPerformer) parts.push(`🏆 الأفضل اليوم: ${report.topPerformer.name} (${report.topPerformer.closedToday} مغلق)`);
  return parts.join(' — ');
}

async function notifyOwners(db, env, { type, title, message }) {
  const owners = await db.prepare(`SELECT id FROM users WHERE is_owner = 1 AND active = 1`).all();
  for (const o of owners.results) {
    await createNotification(db, { userId: o.id, type, title, message });
  }
  if (owners.results.length > 0) {
    await broadcast(env, type, { title, message }, { scope: 'users', userIds: owners.results.map((o) => o.id) });
  }
}

// ---------------------------------------------------------------------------
// Cron sweep — fires each report once per Cairo calendar day, on the first
// tick at/after its trigger time (work_hours.start / work_hours.end), and
// ONLY to is_owner accounts (Mr. Hany's admin — never the regular Team
// Leader). Dedup state lives in the generic `settings` table so a missed or
// delayed cron tick still catches up correctly instead of double-firing.
// ---------------------------------------------------------------------------
export async function sweepOpsReports(db, env) {
  const status = await getWorkHoursStatus(db);
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'ops_reports_sent'`).first();
  let sent = {};
  try {
    sent = row ? JSON.parse(row.value) : {};
  } catch {
    sent = {};
  }
  let changed = false;

  if (status.minutesSinceMidnight >= status.startMin && sent.startOfDay !== status.dateStr) {
    const report = await getStartOfDayReport(db);
    await notifyOwners(db, env, { type: 'START_OF_DAY_REPORT', title: '🌅 تقرير بداية اليوم', message: formatStartOfDayMessage(report) });
    sent.startOfDay = status.dateStr;
    changed = true;
  }
  if (status.minutesSinceMidnight >= status.endMin && sent.endOfShift !== status.dateStr) {
    const report = await getEndOfShiftReport(db);
    await notifyOwners(db, env, { type: 'END_OF_SHIFT_REPORT', title: '🌙 تقرير نهاية الشيفت', message: formatEndOfShiftMessage(report) });
    sent.endOfShift = status.dateStr;
    changed = true;
  }
  if (changed) {
    await db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('ops_reports_sent', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(JSON.stringify(sent), nowIso())
      .run();
  }
  return sent;
}
