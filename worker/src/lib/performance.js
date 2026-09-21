// Transparent, DB-derived performance scoring. The exact formula (and its
// weights) is surfaced to the Team Leader in Settings — nothing here is a
// "mystery score": every contribution is a real, explainable ratio.

const DEFAULT_WEIGHTS = {
  completionRate: 0.35,
  closedCustomers: 0.3,
  followupCompletion: 0.2,
  responseSpeed: 0.15,
  overduePenaltyPerItem: 2,
};

export async function getPerformanceWeights(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'performance_weights'`).first();
  if (!row) return DEFAULT_WEIGHTS;
  try {
    return { ...DEFAULT_WEIGHTS, ...JSON.parse(row.value) };
  } catch {
    return DEFAULT_WEIGHTS;
  }
}

/** Raw counters for one employee — every number here is a plain COUNT() from D1. */
export async function computeEmployeeCounters(db, employeeId) {
  const [assignedRow, statusRows, followupRows, avgResponseRow] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id = ? AND archived = 0`).bind(employeeId).first(),
    db.prepare(`SELECT status, COUNT(*) AS n FROM customers WHERE assigned_employee_id = ? AND archived = 0 GROUP BY status`).bind(employeeId).all(),
    db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now')) THEN 1 ELSE 0 END) AS overdue
         FROM followups WHERE employee_id = ?`
      )
      .bind(employeeId)
      .first(),
    db
      .prepare(
        `SELECT AVG((julianday(h.changed_at) - julianday(c.assigned_at)) * 24 * 60) AS avg_minutes
         FROM customer_status_history h
         JOIN customers c ON c.id = h.customer_id
         WHERE c.assigned_employee_id = ? AND h.from_status = 'NEW' AND c.assigned_at IS NOT NULL`
      )
      .bind(employeeId)
      .first(),
  ]);

  const byStatus = Object.fromEntries(statusRows.results.map((r) => [r.status, r.n]));
  const assigned = assignedRow.n;
  const closed = byStatus.CLOSED || 0;
  const interested = byStatus.INTERESTED || 0;
  const followUp = byStatus.FOLLOW_UP || 0;
  const noAnswer = byStatus.NO_ANSWER || 0;
  const notInterested = byStatus.NOT_INTERESTED || 0;
  const newCount = byStatus.NEW || 0;
  const calling = byStatus.CALLING || 0;

  return {
    assigned,
    byStatus: { NEW: newCount, CALLING: calling, NO_ANSWER: noAnswer, BUSY: byStatus.BUSY || 0, FOLLOW_UP: followUp, INTERESTED: interested, NOT_INTERESTED: notInterested, CLOSED: closed },
    closed,
    interested,
    followupsTotal: followupRows.total || 0,
    followupsCompleted: followupRows.completed || 0,
    followupsOverdue: followupRows.overdue || 0,
    completionRate: assigned > 0 ? closed / assigned : 0,
    followupCompletionRate: followupRows.total > 0 ? followupRows.completed / followupRows.total : 0,
    avgResponseMinutes: avgResponseRow.avg_minutes ?? null,
  };
}

export function computeScore(counters, weights) {
  const completionContribution = counters.completionRate * 100 * weights.completionRate;
  const closureContribution = (Math.min(counters.closed, 50) / 50) * 100 * weights.closedCustomers;
  const followupContribution = counters.followupCompletionRate * 100 * weights.followupCompletion;
  const responseSpeedRatio = counters.avgResponseMinutes == null ? 0.5 : Math.max(0, 1 - Math.min(counters.avgResponseMinutes, 240) / 240);
  const responseContribution = responseSpeedRatio * 100 * weights.responseSpeed;
  const overduePenalty = counters.followupsOverdue * weights.overduePenaltyPerItem;
  const raw = completionContribution + closureContribution + followupContribution + responseContribution - overduePenalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return {
    score,
    breakdown: {
      completionContribution: round1(completionContribution),
      closureContribution: round1(closureContribution),
      followupContribution: round1(followupContribution),
      responseContribution: round1(responseContribution),
      overduePenalty: round1(overduePenalty),
    },
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export async function computeAllEmployeeStats(db) {
  const weights = await getPerformanceWeights(db);
  const employees = (await db.prepare(`SELECT * FROM employees WHERE active = 1`).all()).results;
  const stats = [];
  for (const emp of employees) {
    const counters = await computeEmployeeCounters(db, emp.id);
    const { score, breakdown } = computeScore(counters, weights);
    stats.push({ employee: { id: emp.id, name: emp.name, nameAr: emp.name_ar, availability: emp.availability, avatarUrl: emp.avatar_data_url }, ...counters, performanceScore: score, scoreBreakdown: breakdown });
  }
  return { weights, stats };
}
