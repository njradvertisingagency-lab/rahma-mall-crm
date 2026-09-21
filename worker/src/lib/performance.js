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

// ---------------------------------------------------------------------------
// PERFORMANCE-OVER-TIME — one row per employee per calendar day. The cron
// (every minute — see index.js) upserts *today's* row every tick so it
// always reflects live numbers; once the day rolls over, that row is never
// touched again and becomes frozen history. This never replaces the live
// /employees endpoint (still the source of truth for "right now") — it only
// adds a historical trail so a trend chart is possible at all.
// ---------------------------------------------------------------------------
export async function recordDailySnapshots(db) {
  const weights = await getPerformanceWeights(db);
  const today = new Date().toISOString().slice(0, 10);
  const employees = (await db.prepare(`SELECT id FROM employees WHERE active = 1`).all()).results;
  for (const emp of employees) {
    const counters = await computeEmployeeCounters(db, emp.id);
    const { score } = computeScore(counters, weights);
    await db
      .prepare(
        `INSERT INTO performance_snapshots (employee_id, snapshot_date, score, completion_rate, closed, assigned, followups_completed, followups_overdue, avg_response_minutes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(employee_id, snapshot_date) DO UPDATE SET
           score = excluded.score, completion_rate = excluded.completion_rate, closed = excluded.closed,
           assigned = excluded.assigned, followups_completed = excluded.followups_completed,
           followups_overdue = excluded.followups_overdue, avg_response_minutes = excluded.avg_response_minutes,
           updated_at = excluded.updated_at`
      )
      .bind(emp.id, today, score, counters.completionRate, counters.closed, counters.assigned, counters.followupsCompleted, counters.followupsOverdue, counters.avgResponseMinutes)
      .run();
  }
  return { snapshotted: employees.length, date: today };
}

/** History for the trend chart — oldest first, capped to `days` calendar days including today. */
export async function getPerformanceHistory(db, employeeId, days) {
  const rows = await db
    .prepare(
      `SELECT snapshot_date, score, completion_rate, closed, assigned, followups_completed, followups_overdue, avg_response_minutes
       FROM performance_snapshots WHERE employee_id = ? ORDER BY snapshot_date DESC LIMIT ?`
    )
    .bind(employeeId, days)
    .all();
  return rows.results.reverse().map((r) => ({
    date: r.snapshot_date,
    score: r.score,
    completionRate: r.completion_rate,
    closed: r.closed,
    assigned: r.assigned,
    followupsCompleted: r.followups_completed,
    followupsOverdue: r.followups_overdue,
    avgResponseMinutes: r.avg_response_minutes,
  }));
}

// ---------------------------------------------------------------------------
// ACHIEVEMENTS / BADGES — computed live, never stored (same "transparent,
// DB-derived" principle as the score itself). Weekly badges look at the
// last 7 days; monthly badges look at the current calendar month so far.
// ---------------------------------------------------------------------------
const BADGE_DEFS = [
  { key: 'FASTEST_RESPONSE_WEEK', icon: '⚡', label: 'أسرع استجابة الأسبوع', period: 'week' },
  { key: 'TOP_CLOSER_MONTH', icon: '🥇', label: 'أعلى إغلاق الشهر', period: 'month' },
  { key: 'FOLLOWUP_CHAMPION_WEEK', icon: '🎯', label: 'الأكثر التزامًا بالمتابعات هذا الأسبوع', period: 'week' },
  { key: 'ZERO_COMPLAINTS_MONTH', icon: '🌟', label: 'صفر شكاوى هذا الشهر', period: 'month' },
];

export async function computeBadges(db) {
  const employees = (await db.prepare(`SELECT id, name, name_ar FROM employees WHERE active = 1`).all()).results;
  if (employees.length === 0) return { weekly: [], monthly: [] };

  const weekStart = new Date(Date.now() - 7 * 86400000).toISOString();
  const monthStart = new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z';

  // أسرع استجابة الأسبوع — أقل متوسط زمن استجابة (من NEW إلى أول تغيير حالة) خلال آخر ٧ أيام.
  let fastestResponse = null;
  for (const emp of employees) {
    const row = await db
      .prepare(
        `SELECT AVG((julianday(h.changed_at) - julianday(c.assigned_at)) * 24 * 60) AS avg_minutes, COUNT(*) AS n
         FROM customer_status_history h JOIN customers c ON c.id = h.customer_id
         WHERE c.assigned_employee_id = ? AND h.from_status = 'NEW' AND c.assigned_at IS NOT NULL AND h.changed_at >= ?`
      )
      .bind(emp.id, weekStart)
      .first();
    if (row.n > 0 && row.avg_minutes != null) {
      if (!fastestResponse || row.avg_minutes < fastestResponse.avgMinutes) fastestResponse = { emp, avgMinutes: row.avg_minutes };
    }
  }

  // أعلى إغلاق الشهر — أكثر عدد عملاء تم إغلاقهم (حالة CLOSED) هذا الشهر.
  let topCloser = null;
  for (const emp of employees) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM customer_status_history h JOIN customers c ON c.id = h.customer_id WHERE c.assigned_employee_id = ? AND h.to_status = 'CLOSED' AND h.changed_at >= ?`)
      .bind(emp.id, monthStart)
      .first();
    if (row.n > 0 && (!topCloser || row.n > topCloser.count)) topCloser = { emp, count: row.n };
  }

  // الأكثر التزامًا بالمتابعات — أعلى نسبة إنجاز متابعات مجدولة هذا الأسبوع (بحد أدنى ٣ متابعات).
  let followupChampion = null;
  for (const emp of employees) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS done FROM followups WHERE employee_id = ? AND created_at >= ?`)
      .bind(emp.id, weekStart)
      .first();
    if (row.total >= 3) {
      const rate = row.done / row.total;
      if (!followupChampion || rate > followupChampion.rate) followupChampion = { emp, rate, total: row.total, done: row.done };
    }
  }

  // صفر شكاوى الشهر — موظف لديه عملاء موزّعون هذا الشهر لكن بدون أي شكوى مسجّلة.
  const zeroComplaints = [];
  for (const emp of employees) {
    const [assignedRow, complaintsRow] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id = ? AND archived = 0`).bind(emp.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM complaints WHERE employee_id = ? AND created_at >= ?`).bind(emp.id, monthStart).first(),
    ]);
    if (assignedRow.n > 0 && complaintsRow.n === 0) zeroComplaints.push(emp);
  }

  const weekly = [];
  const monthly = [];
  if (fastestResponse) weekly.push({ key: 'FASTEST_RESPONSE_WEEK', icon: '⚡', label: 'أسرع استجابة الأسبوع', employeeId: fastestResponse.emp.id, employeeName: fastestResponse.emp.name, detail: `${Math.round(fastestResponse.avgMinutes)} دقيقة في المتوسط` });
  if (followupChampion) weekly.push({ key: 'FOLLOWUP_CHAMPION_WEEK', icon: '🎯', label: 'الأكثر التزامًا بالمتابعات', employeeId: followupChampion.emp.id, employeeName: followupChampion.emp.name, detail: `${followupChampion.done}/${followupChampion.total} هذا الأسبوع` });
  if (topCloser) monthly.push({ key: 'TOP_CLOSER_MONTH', icon: '🥇', label: 'أعلى إغلاق الشهر', employeeId: topCloser.emp.id, employeeName: topCloser.emp.name, detail: `${topCloser.count} عميل مغلق` });
  zeroComplaints.forEach((emp) => monthly.push({ key: 'ZERO_COMPLAINTS_MONTH', icon: '🌟', label: 'صفر شكاوى هذا الشهر', employeeId: emp.id, employeeName: emp.name, detail: 'سجل نظيف هذا الشهر' }));

  return { weekly, monthly };
}

export async function computeAllEmployeeStats(db) {
  const weights = await getPerformanceWeights(db);
  const employees = (
    await db.prepare(`SELECT e.*, u.username FROM employees e JOIN users u ON u.id = e.user_id WHERE e.active = 1`).all()
  ).results;
  const stats = [];
  for (const emp of employees) {
    const counters = await computeEmployeeCounters(db, emp.id);
    const { score, breakdown } = computeScore(counters, weights);
    stats.push({ employee: { id: emp.id, name: emp.name, nameAr: emp.name_ar, username: emp.username, availability: emp.availability, avatarUrl: emp.avatar_data_url }, ...counters, performanceScore: score, scoreBreakdown: breakdown });
  }
  return { weights, stats };
}
