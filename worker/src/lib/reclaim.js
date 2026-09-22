// Auto-reclaim idle same-day distributions.
//
// User's request: "بعد الساعة 6، لو الموظف محطش حالة/ملاحظة للعميل، الرقم
// يتسحب منه تلقائيًا لأفضل شخص منتظم في الفريق." Confirmed scope (asked and
// answered explicitly before building this):
//   - Only customers ASSIGNED TO the employee TODAY (customers.assigned_at
//     within the current Cairo calendar day) — never older/stale
//     assignments, so nobody is punished for a slow-moving lead from last
//     week.
//   - "لسه محطش حالة/ملاحظة" = truly untouched since the assignment moment:
//     no customer_status_history row AND no customer_notes row for that
//     customer with a timestamp >= the assignment time.
//   - "أفضل شخص منتظم" = fewest late check-ins THIS MONTH first (via the
//     attendance system's Durable Object store — lib/attendance.js — with a
//     graceful fallback to "everyone tied at zero" if it's ever
//     unreachable, so this sweep is never blocked on the attendance
//     system), then highest performance score as the tiebreaker.
//   - Execution = automatic immediately, plus a notification to the
//     employee it was pulled from, the employee who received it, AND every
//     owner account (Mr. Hany) — never silent.
//
// Runs once per Cairo calendar day, at/after end-of-shift (work_hours.end),
// never on a holiday — same dedup pattern as the two ops reports
// (lib/opsreports.js) via a key in the shared `settings` table.
import { nowIso, createNotification, broadcast, logActivity, nextDistributionLabel } from './db.js';
import { getWorkHoursStatus, getCairoDayBoundsUtc } from './workhours.js';
import { computeAllEmployeeStats } from './performance.js';
import { getLateCountThisMonth } from './attendance.js';

function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

async function pickBestTeammate(db, env, excludeEmployeeId, month) {
  const employees = (
    await db.prepare(`SELECT e.id, e.user_id, e.name, e.name_ar FROM employees e WHERE e.active = 1 AND e.id != ?`).bind(excludeEmployeeId).all()
  ).results;
  if (employees.length === 0) return null;

  let lateCounts = {};
  try {
    for (const e of employees) {
      lateCounts[e.user_id] = await getLateCountThisMonth(env, e.user_id, month);
    }
  } catch (err) {
    // The attendance store should always be reachable (it's a Durable Object,
    // unrelated to D1) — but fall back to performance score alone rather
    // than fail the whole handoff if something's ever wrong with it.
    console.error('pickBestTeammate: attendance ranking unavailable, using performance only', err);
  }

  const { stats } = await computeAllEmployeeStats(db);
  const scoreByEmployee = Object.fromEntries(stats.map((s) => [s.employee.id, s.performanceScore]));

  const ranked = employees
    .map((e) => ({ ...e, lateCount: lateCounts[e.user_id] || 0, score: scoreByEmployee[e.id] ?? 0 }))
    .sort((a, b) => a.lateCount - b.lateCount || b.score - a.score);

  return ranked[0] || null;
}

export async function sweepAutoReclaim(db, env) {
  const status = await getWorkHoursStatus(db);
  if (status.isHolidayToday) return { reclaimed: 0 };
  if (status.minutesSinceMidnight < status.endMin) return { reclaimed: 0 };

  const dedupRow = await db.prepare(`SELECT value FROM settings WHERE key = 'reclaim_sweep_sent'`).first();
  let sentDate = null;
  try {
    sentDate = dedupRow ? JSON.parse(dedupRow.value).date : null;
  } catch {
    sentDate = null;
  }
  if (sentDate === status.dateStr) return { reclaimed: 0 };

  const { dayStartIso, dayEndIso } = getCairoDayBoundsUtc(status.dateStr);

  const candidates = await db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.assigned_employee_id, c.assigned_at
       FROM customers c
       WHERE c.archived = 0 AND c.assigned_employee_id IS NOT NULL
         AND c.assigned_at >= ? AND c.assigned_at <= ?
         AND NOT EXISTS (SELECT 1 FROM customer_status_history h WHERE h.customer_id = c.id AND h.changed_at >= c.assigned_at)
         AND NOT EXISTS (SELECT 1 FROM customer_notes n WHERE n.customer_id = c.id AND n.created_at >= c.assigned_at)`
    )
    .bind(dayStartIso, dayEndIso)
    .all();

  let reclaimed = 0;
  if (candidates.results.length > 0) {
    const month = monthOf(status.dateStr);
    const byEmployee = {};
    for (const c of candidates.results) {
      (byEmployee[c.assigned_employee_id] ||= []).push(c);
    }
    const now = nowIso();
    const owners = await db.prepare(`SELECT id FROM users WHERE is_owner = 1 AND active = 1`).all();

    for (const [employeeIdStr, custs] of Object.entries(byEmployee)) {
      const employeeId = Number(employeeIdStr);
      const best = await pickBestTeammate(db, env, employeeId, month);
      if (!best) continue; // no other active employee to hand off to — leave untouched rather than fail loudly

      const fromEmp = await db.prepare(`SELECT name, name_ar, user_id FROM employees WHERE id = ?`).bind(employeeId).first();
      const { label } = await nextDistributionLabel(db);
      const dist = await db
        .prepare(`INSERT INTO distributions (label, method, total_customers, created_by, notes) VALUES (?, 'MANUAL', ?, NULL, ?) RETURNING id`)
        .bind(label, custs.length, 'سحب تلقائي — عملاء بدون حالة/ملاحظة حتى نهاية الشيفت')
        .first();

      for (const c of custs) {
        await db
          .prepare(`UPDATE customers SET assigned_employee_id = ?, assigned_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
          .bind(best.id, now, now, c.id)
          .run();
        await db
          .prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, assigned_at, reason, distribution_id) VALUES (?, ?, NULL, ?, 'REASSIGNMENT', ?)`)
          .bind(c.id, best.id, now, dist.id)
          .run();
        await db.prepare(`INSERT INTO distribution_items (distribution_id, employee_id, customer_id) VALUES (?, ?, ?)`).bind(dist.id, best.id, c.id).run();
        reclaimed++;
      }

      const fromLabel = fromEmp?.name_ar ? `${fromEmp.name} (${fromEmp.name_ar})` : fromEmp?.name || 'موظف';
      const toLabel = best.name_ar ? `${best.name} (${best.name_ar})` : best.name;

      if (fromEmp?.user_id) {
        await createNotification(db, {
          userId: fromEmp.user_id,
          type: 'CUSTOMERS_AUTO_RECLAIMED',
          title: '⚠️ تم سحب عملاء منك تلقائيًا',
          message: `تم سحب ${custs.length} عميل لم تُسجَّل لهم حالة أو ملاحظة اليوم، وتحويلهم إلى ${toLabel}.`,
        });
        await broadcast(env, 'CUSTOMER_REASSIGNED', { customerIds: custs.map((c) => c.id), toEmployeeId: best.id }, { scope: 'user', userId: fromEmp.user_id });
      }
      await createNotification(db, {
        userId: best.user_id,
        type: 'CUSTOMERS_AUTO_ASSIGNED',
        title: '📥 عملاء جدد بالتحويل التلقائي',
        message: `تم تحويل ${custs.length} عميل إليك تلقائيًا من ${fromLabel} (بدون حالة/ملاحظة مسجّلة).`,
      });
      await broadcast(env, 'CUSTOMER_REASSIGNED', { customerIds: custs.map((c) => c.id), toEmployeeId: best.id }, { scope: 'user', userId: best.user_id });

      for (const o of owners.results) {
        await createNotification(db, {
          userId: o.id,
          type: 'CUSTOMERS_AUTO_RECLAIMED_OWNER',
          title: '🔁 سحب تلقائي للعملاء',
          message: `تم سحب ${custs.length} عميل من ${fromLabel} وتحويلهم إلى ${toLabel} (بدون حالة/ملاحظة حتى نهاية الشيفت).`,
        });
      }
      if (owners.results.length > 0) {
        await broadcast(env, 'CUSTOMERS_AUTO_RECLAIMED_OWNER', { fromEmployeeId: employeeId, toEmployeeId: best.id, count: custs.length }, { scope: 'users', userIds: owners.results.map((o) => o.id) });
      }
      await broadcast(env, 'CUSTOMERS_AUTO_RECLAIMED', { fromEmployeeId: employeeId, toEmployeeId: best.id, count: custs.length }, { scope: 'role', role: 'team_leader' });
      await logActivity(db, {
        actor: null,
        action: 'AUTO_RECLAIM',
        entityType: 'distribution',
        entityId: String(dist.id),
        metadata: { fromEmployeeId: employeeId, toEmployeeId: best.id, customerIds: custs.map((c) => c.id) },
      });
    }
  }

  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('reclaim_sweep_sent', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(JSON.stringify({ date: status.dateStr, reclaimed }), nowIso())
    .run();

  return { reclaimed };
}
