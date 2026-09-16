// Daily employee goals — set explicitly by the Team Leader, never auto-generated.
// Progress is always computed live against real activity for that date.
export async function setDailyGoal(db, { employeeId, goalDate, targetCustomers, targetSeen, targetContacted, targetFollowups, createdBy }) {
  await db
    .prepare(
      `INSERT INTO daily_goals (employee_id, goal_date, target_customers, target_seen, target_contacted, target_followups, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(employee_id, goal_date) DO UPDATE SET
         target_customers = excluded.target_customers, target_seen = excluded.target_seen,
         target_contacted = excluded.target_contacted, target_followups = excluded.target_followups, created_by = excluded.created_by`
    )
    .bind(employeeId, goalDate, targetCustomers || 0, targetSeen || 0, targetContacted || 0, targetFollowups || 0, createdBy)
    .run();
  return getDailyGoalProgress(db, employeeId, goalDate);
}

export async function getDailyGoalProgress(db, employeeId, goalDate) {
  const goal = await db.prepare(`SELECT * FROM daily_goals WHERE employee_id = ? AND goal_date = ?`).bind(employeeId, goalDate).first();
  const dayStart = goalDate + 'T00:00:00.000Z';
  const dayEnd = goalDate + 'T23:59:59.999Z';

  const [customersHandled, seenToday, contactedToday, followupsToday] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(DISTINCT entity_id) AS n FROM activity_logs
         WHERE entity_type = 'customer' AND actor_id = (SELECT user_id FROM employees WHERE id = ?) AND created_at BETWEEN ? AND ?`
      )
      .bind(employeeId, dayStart, dayEnd)
      .first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customer_seen WHERE employee_id = ? AND seen_at BETWEEN ? AND ?`).bind(employeeId, dayStart, dayEnd).first(),
    db.prepare(`SELECT COUNT(DISTINCT customer_id) AS n FROM call_attempts WHERE employee_id = ? AND created_at BETWEEN ? AND ?`).bind(employeeId, dayStart, dayEnd).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE employee_id = ? AND status = 'COMPLETED' AND completed_at BETWEEN ? AND ?`).bind(employeeId, dayStart, dayEnd).first(),
  ]);

  const targets = goal || { target_customers: 0, target_seen: 0, target_contacted: 0, target_followups: 0 };
  const stages = {
    customers: { done: customersHandled.n, target: targets.target_customers },
    seen: { done: seenToday.n, target: targets.target_seen },
    contacted: { done: contactedToday.n, target: targets.target_contacted },
    followups: { done: followupsToday.n, target: targets.target_followups },
  };
  const totalTarget = Object.values(stages).reduce((s, v) => s + v.target, 0);
  const totalDone = Object.values(stages).reduce((s, v) => s + Math.min(v.done, v.target), 0);
  return { goalDate, hasGoal: !!goal, ...stages, overallPercent: totalTarget > 0 ? Math.round((totalDone / totalTarget) * 100) : 0 };
}
