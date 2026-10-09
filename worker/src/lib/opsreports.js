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
import { getNeedsAttentionQueue, getSalesToday } from './commandcenter.js';
import { getEmployeePresenceMap } from './presence.js';
import { nowIso } from './db.js';

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
