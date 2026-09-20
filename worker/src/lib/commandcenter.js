// Live Team Command Center — every number here comes from a real query
// against the same tables the rest of the app uses; nothing is cached,
// randomized, or hand-set. Needs Attention is ranked by a fixed severity
// order (never by "opinion" — spec explicitly forbids that).
import { getEmployeePresenceMap, getPresenceThresholds } from './presence.js';
import { getSlaRules, findSeenSlaCandidates, findContactSlaCandidates, findInterestedFollowupSlaCandidates } from './sla.js';
import { computeFunnel } from './funnel.js';

function round2(n) {
  return Math.round(n * 100) / 100;
}
function todayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function getTeamPresenceSummary(db) {
  const map = await getEmployeePresenceMap(db);
  const values = Object.values(map);
  return {
    total: values.length,
    online: values.filter((v) => v.online && v.activityState === 'ACTIVE').length,
    idle: values.filter((v) => v.online && v.activityState === 'IDLE').length,
    offline: values.filter((v) => !v.online).length,
  };
}

export async function getSalesToday(db) {
  const today = todayStartIso();
  const [deals, visits, sales] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM purchase_transactions WHERE purchase_at >= ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`).bind(today).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customer_branch_visits WHERE visit_at >= ?`).bind(today).first(),
    db
      .prepare(
        `SELECT COALESCE(SUM(total_amount),0) AS gross, COALESCE(SUM(refunded_amount),0) AS refunds, COUNT(*) AS n
         FROM purchase_transactions WHERE purchase_at >= ? AND status != 'CANCELLED'`
      )
      .bind(today)
      .first(),
  ]);
  const gross = sales.gross || 0;
  const refunds = sales.refunds || 0;
  const net = round2(gross - refunds);
  return {
    dealsToday: deals.n,
    branchVisitsToday: visits.n,
    grossRevenueToday: round2(gross),
    refundsToday: round2(refunds),
    netRevenueToday: net,
    averageOrderValueToday: sales.n > 0 ? round2(net / sales.n) : 0,
    conversionRate: visits.n > 0 ? round2((deals.n / visits.n) * 100) : 0,
  };
}

export async function getNeedsAttentionQueue(db) {
  const [rules, thresholds, seenCandidates, contactCandidates, interestedCandidates, overdueFollowups, idleEmployees, multiFailCustomers] = await Promise.all([
    getSlaRules(db),
    getPresenceThresholds(db),
    findSeenSlaCandidates(db),
    findContactSlaCandidates(db),
    findInterestedFollowupSlaCandidates(db),
    db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now'))`).first(),
    getEmployeePresenceMap(db),
    db
      .prepare(
        `SELECT c.id FROM customers c WHERE c.archived = 0 AND c.status NOT IN ('CLOSED','NOT_INTERESTED')
         AND (SELECT COUNT(*) FROM call_attempts ca WHERE ca.customer_id = c.id AND ca.outcome != 'ANSWERED') >= 3
         AND NOT EXISTS (SELECT 1 FROM call_attempts ca2 WHERE ca2.customer_id = c.id AND ca2.outcome = 'ANSWERED')`
      )
      .all(),
  ]);

  const now = Date.now();
  const breachedSla = [...seenCandidates, ...contactCandidates].filter((r) => (now - new Date(r.anchor_at).getTime()) / 60000 >= rules.seenWithinMinutes).length
    + interestedCandidates.filter((r) => (now - new Date(r.anchor_at).getTime()) / 60000 >= rules.followupWithinMinutesAfterInterested).length;
  const notSeenCount = seenCandidates.length;
  const interestedNoFollowupCount = interestedCandidates.length;
  const idleTooLong = Object.values(idleEmployees).filter((e) => e.activityState === 'IDLE' && e.idleForSeconds > thresholds.idleAfterMinutes * 60 * 2).length;

  const items = [
    { severity: 'CRITICAL', type: 'SLA_BREACHED', count: breachedSla, label: `${breachedSla} تجاوز لموعد الخدمة`, filter: { sla: 'breached' } },
    { severity: 'CRITICAL', type: 'INTERESTED_NO_FOLLOWUP', count: interestedNoFollowupCount, label: `${interestedNoFollowupCount} عميل مهتم بدون متابعة مجدولة`, filter: { status: 'INTERESTED', followup: 'none' } },
    { severity: 'CRITICAL', type: 'OVERDUE_FOLLOWUP', count: overdueFollowups.n, label: `${overdueFollowups.n} متابعة متأخرة`, filter: { followup: 'overdue' } },
    { severity: 'WARNING', type: 'NOT_SEEN', count: notSeenCount, label: `${notSeenCount} عميل لم تتم رؤيته بعد`, filter: { seen: 'not_seen' } },
    { severity: 'WARNING', type: 'EMPLOYEE_IDLE', count: idleTooLong, label: `${idleTooLong} موظف خامل لفترة طويلة`, filter: null },
    { severity: 'WARNING', type: 'MULTI_FAIL_CALLS', count: multiFailCustomers.results.length, label: `${multiFailCustomers.results.length} عميل بـ ٣ محاولات اتصال فاشلة أو أكثر`, filter: { callAttempts: 'multiFail' } },
  ].filter((i) => i.count > 0);

  const severityOrder = { CRITICAL: 0, WARNING: 1 };
  items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.count - a.count);
  return items;
}

export async function getCommandCenterSnapshot(db) {
  const [presence, sales, funnelToday, needsAttention] = await Promise.all([
    getTeamPresenceSummary(db),
    getSalesToday(db),
    computeFunnel(db, { from: todayStartIso(), to: new Date().toISOString() }),
    getNeedsAttentionQueue(db),
  ]);
  return { presence, sales, funnelToday, needsAttention };
}
