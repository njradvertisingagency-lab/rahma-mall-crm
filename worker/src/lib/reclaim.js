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
import { getWorkHoursStatus, getCairoDayBoundsUtc, getCairoNow } from './workhours.js';
import { getEmployeePresenceMap } from './presence.js';

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

// ---------------------------------------------------------------------------
// 3 PM REDISTRIBUTION — طلب صاحب الشركة: كل يوم الساعة 3 العصر، أي عميل
// اتوزّع النهاردة ولسه الموظف ما عملش فيه أي إجراء (مش فتح و خلاص — لازم
// يكون غيّر حالة أو عمل محاولة اتصال أو كتب ملاحظة) — يتسحب تلقائيًا من
// الموظف ويتوزّع بالتساوي على زمايله الأونلاين وقتها.
//
// Scope:
//   - Only customers ASSIGNED TODAY (assigned_at within the current Cairo day)
//   - "Untouched" = no customer_status_history change, no call_attempts, AND
//     no customer_notes since assignment — customer_seen (just viewing) does
//     NOT count as an action
//   - Redistributed to employees who are currently ONLINE (employee_presence
//     online = 1), excluding the original assignee
//   - Runs once per Cairo calendar day at/after 15:00, deduped via settings key
// ---------------------------------------------------------------------------
const REDISTRIBUTE_HOUR = 15; // 3 PM Cairo

export async function sweepRedistribute3pm(db, env) {
  const status = await getWorkHoursStatus(db);
  if (status.isHolidayToday) return { redistributed: 0 };

  // Only fire at or after 3 PM Cairo
  const targetMinute = REDISTRIBUTE_HOUR * 60;
  if (status.minutesSinceMidnight < targetMinute) return { redistributed: 0 };

  // Dedup: once per Cairo calendar day
  const dedupRow = await db.prepare(`SELECT value FROM settings WHERE key = 'redistribute_3pm_sent'`).first();
  let sentDate = null;
  try {
    sentDate = dedupRow ? JSON.parse(dedupRow.value).date : null;
  } catch {
    sentDate = null;
  }
  if (sentDate === status.dateStr) return { redistributed: 0 };

  const { dayStartIso, dayEndIso } = getCairoDayBoundsUtc(status.dateStr);

  // Find today's assigned customers with NO action taken since assignment:
  // no status change, no call attempt, no note written.
  const candidates = await db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.assigned_employee_id, c.assigned_at
       FROM customers c
       WHERE c.archived = 0 AND c.assigned_employee_id IS NOT NULL
         AND c.assigned_at >= ? AND c.assigned_at <= ?
         AND NOT EXISTS (SELECT 1 FROM customer_status_history h WHERE h.customer_id = c.id AND h.changed_at >= c.assigned_at)
         AND NOT EXISTS (SELECT 1 FROM call_attempts ca WHERE ca.customer_id = c.id AND ca.created_at >= c.assigned_at)
         AND NOT EXISTS (SELECT 1 FROM customer_notes n WHERE n.customer_id = c.id AND n.created_at >= c.assigned_at)`
    )
    .bind(dayStartIso, dayEndIso)
    .all();

  let redistributed = 0;

  if (candidates.results.length > 0) {
    // Get currently online employees (read-time corrected presence map)
    const presenceMap = await getEmployeePresenceMap(db);
    const onlineEmployeeIds = Object.entries(presenceMap)
      .filter(([, p]) => p.online)
      .map(([id]) => Number(id));

    if (onlineEmployeeIds.length === 0) {
      // Nobody online — skip, mark as done so it doesn't retry all afternoon
      await db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('redistribute_3pm_sent', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(JSON.stringify({ date: status.dateStr, redistributed: 0, reason: 'no_online_employees' }), nowIso())
        .run();
      return { redistributed: 0 };
    }

    // Group untouched leads by their original assignee
    const byEmployee = {};
    for (const c of candidates.results) {
      (byEmployee[c.assigned_employee_id] ||= []).push(c);
    }

    const now = nowIso();
    const owners = await db.prepare(`SELECT id FROM users WHERE is_owner = 1 AND active = 1`).all();

    for (const [employeeIdStr, custs] of Object.entries(byEmployee)) {
      const fromEmployeeId = Number(employeeIdStr);
      const fromEmp = await db.prepare(`SELECT name, name_ar, user_id FROM employees WHERE id = ?`).bind(fromEmployeeId).first();

      // Eligible targets = online employees EXCEPT the original assignee
      const targets = onlineEmployeeIds.filter((id) => id !== fromEmployeeId);
      if (targets.length === 0) continue; // This employee is the only one online — skip their leads

      // Distribute equally (round-robin) among targets
      for (let i = 0; i < custs.length; i++) {
        const c = custs[i];
        const targetEmployeeId = targets[i % targets.length];

        await db
          .prepare(`UPDATE customers SET assigned_employee_id = ?, assigned_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
          .bind(targetEmployeeId, now, now, c.id)
          .run();
        await db
          .prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, assigned_at, reason) VALUES (?, ?, NULL, ?, 'REASSIGNMENT')`)
          .bind(c.id, targetEmployeeId, now)
          .run();
        redistributed++;
      }

      const fromLabel = fromEmp?.name_ar ? `${fromEmp.name} (${fromEmp.name_ar})` : fromEmp?.name || 'موظف';

      // Notify the employee their leads were taken
      if (fromEmp?.user_id) {
        await createNotification(db, {
          userId: fromEmp.user_id,
          type: 'CUSTOMERS_AUTO_RECLAIMED',
          title: '⚠️ تم إعادة توزيع عملاء منك تلقائيًا',
          message: `تم سحب ${custs.length} عميل لم تُتخذ عليهم أي إجراء وإعادة توزيعهم على زملائك الأونلاين.`,
        });
        await broadcast(env, 'CUSTOMER_REASSIGNED', { customerIds: custs.map((c) => c.id) }, { scope: 'user', userId: fromEmp.user_id });
      }

      // Notify each target employee about their new leads
      const targetCounts = {};
      for (let i = 0; i < custs.length; i++) {
        const tid = targets[i % targets.length];
        targetCounts[tid] = (targetCounts[tid] || 0) + 1;
      }
      for (const [targetIdStr, count] of Object.entries(targetCounts)) {
        const targetEmp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(Number(targetIdStr)).first();
        if (targetEmp?.user_id) {
          await createNotification(db, {
            userId: targetEmp.user_id,
            type: 'CUSTOMERS_REDISTRIBUTED_TO_YOU',
            title: '📥 تم توزيع عملاء جدد عليك',
            message: `تم توزيع ${count} عميل جديد عليك تلقائيًا (كانوا مع ${fromLabel} ولم يُتخذ عليهم أي إجراء).`,
          });
          await broadcast(env, 'CUSTOMER_REASSIGNED', { count }, { scope: 'user', userId: targetEmp.user_id });
        }
      }

      // Notify owners (Mr. Hany)
      for (const o of owners.results) {
        await createNotification(db, {
          userId: o.id,
          type: 'CUSTOMERS_REDISTRIBUTED_OWNER',
          title: '🔄 إعادة توزيع تلقائية الساعة 3',
          message: `تم سحب ${custs.length} عميل بلا إجراء من ${fromLabel} وإعادة توزيعهم على ${targets.length} زملاء أونلاين.`,
        });
      }
      if (owners.results.length > 0) {
        await broadcast(env, 'CUSTOMERS_REDISTRIBUTED', { fromEmployeeId, count: custs.length }, { scope: 'users', userIds: owners.results.map((o) => o.id) });
      }
      await broadcast(env, 'CUSTOMERS_REDISTRIBUTED', { fromEmployeeId, count: custs.length }, { scope: 'role', role: 'team_leader' });
      await logActivity(db, {
        actor: null,
        action: 'AUTO_REDISTRIBUTE_3PM',
        entityType: 'customer',
        entityId: String(fromEmployeeId),
        metadata: { fromEmployeeId, targetEmployeeIds: targets, customerIds: custs.map((c) => c.id) },
      });
    }
  }

  // Mark today as done
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('redistribute_3pm_sent', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(JSON.stringify({ date: status.dateStr, redistributed }), nowIso())
    .run();

  return { redistributed };
}
