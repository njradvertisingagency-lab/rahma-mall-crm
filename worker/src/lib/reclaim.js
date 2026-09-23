// Auto-reclaim idle same-day distributions.
//
// User's request (latest revision): any customer with no note, never opened
// at all, or no action taken on it whatsoever must be pulled back from that
// employee, reported to Mr. Hany, and returned to the "توزيع العملاء" pool —
// NOT silently auto-reassigned to another employee. Decisions about who
// gets a customer next are the Team Leader's job, made by hand from the
// distribution screen, never automatic.
//
// Scope (unchanged from the original, explicitly-confirmed design):
//   - Only customers ASSIGNED TO the employee TODAY (customers.assigned_at
//     within the current Cairo calendar day) — never older/stale
//     assignments, so nobody is punished for a slow-moving lead from last
//     week.
//   - "لسه محطش حالة/ملاحظة" = truly untouched since the assignment moment:
//     no customer_status_history row AND no customer_notes row for that
//     customer with a timestamp >= the assignment time. This also covers a
//     customer the employee never opened at all (customer_seen never
//     written) and one they opened but took no further action on — both
//     produce zero status-history and zero note rows, so both match here.
//   - Execution = automatic immediately: unassign back to the pool
//     (assigned_employee_id = NULL, same state as a freshly imported,
//     not-yet-distributed customer), plus a notification to the employee
//     it was pulled from AND every owner account (Mr. Hany) — never silent.
//
// Runs once per Cairo calendar day, at/after end-of-shift (work_hours.end),
// never on a holiday — same dedup pattern as the two ops reports
// (lib/opsreports.js) via a key in the shared `settings` table.
import { nowIso, createNotification, broadcast, logActivity } from './db.js';
import { getWorkHoursStatus, getCairoDayBoundsUtc } from './workhours.js';

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
    const byEmployee = {};
    for (const c of candidates.results) {
      (byEmployee[c.assigned_employee_id] ||= []).push(c);
    }
    const now = nowIso();
    const owners = await db.prepare(`SELECT id FROM users WHERE is_owner = 1 AND active = 1`).all();

    for (const [employeeIdStr, custs] of Object.entries(byEmployee)) {
      const employeeId = Number(employeeIdStr);
      const fromEmp = await db.prepare(`SELECT name, name_ar, user_id FROM employees WHERE id = ?`).bind(employeeId).first();

      for (const c of custs) {
        // يرجع "غير موزّع" بالظبط زي عميل مستورد جديد لسه ما وزّعش — يظهر
        // من تاني في صفحة "توزيع العملاء" عشان قائد الفريق يوزّعه بنفسه.
        // القرار مين ياخده مش أوتوماتيكي أبدًا.
        await db
          .prepare(`UPDATE customers SET assigned_employee_id = NULL, updated_at = ?, version = version + 1 WHERE id = ?`)
          .bind(now, c.id)
          .run();
        // 'reason' is a CHECK-constrained column (DISTRIBUTION/MANUAL/
        // REASSIGNMENT/IMPORT_UNASSIGNED only) — this is a reassignment
        // event even though the destination is "nobody" (the pool).
        await db
          .prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, assigned_at, reason) VALUES (?, NULL, NULL, ?, 'REASSIGNMENT')`)
          .bind(c.id, now)
          .run();
        reclaimed++;
      }

      const fromLabel = fromEmp?.name_ar ? `${fromEmp.name} (${fromEmp.name_ar})` : fromEmp?.name || 'موظف';

      if (fromEmp?.user_id) {
        await createNotification(db, {
          userId: fromEmp.user_id,
          type: 'CUSTOMERS_AUTO_RECLAIMED',
          title: '⚠️ تم سحب عملاء منك تلقائيًا',
          message: `تم سحب ${custs.length} عميل لم تُسجَّل لهم حالة أو ملاحظة اليوم، ورجعوا لقائمة توزيع العملاء.`,
        });
        await broadcast(env, 'CUSTOMER_REASSIGNED', { customerIds: custs.map((c) => c.id) }, { scope: 'user', userId: fromEmp.user_id });
      }

      for (const o of owners.results) {
        await createNotification(db, {
          userId: o.id,
          type: 'CUSTOMERS_AUTO_RECLAIMED_OWNER',
          title: '🔁 عملاء بلا ملاحظة رجعوا لقائمة التوزيع',
          message: `تم سحب ${custs.length} عميل من ${fromLabel} (بدون حالة/ملاحظة حتى نهاية الشيفت) ورجعوا لقائمة توزيع العملاء لإعادة توزيعهم.`,
        });
      }
      if (owners.results.length > 0) {
        await broadcast(env, 'CUSTOMERS_AUTO_RECLAIMED_OWNER', { fromEmployeeId: employeeId, count: custs.length }, { scope: 'users', userIds: owners.results.map((o) => o.id) });
      }
      await broadcast(env, 'CUSTOMERS_AUTO_RECLAIMED', { fromEmployeeId: employeeId, count: custs.length }, { scope: 'role', role: 'team_leader' });
      await logActivity(db, {
        actor: null,
        action: 'AUTO_RECLAIM',
        entityType: 'customer',
        entityId: String(employeeId),
        metadata: { fromEmployeeId: employeeId, unassigned: true, customerIds: custs.map((c) => c.id) },
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
