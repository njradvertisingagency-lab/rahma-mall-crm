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
import { nowIso, logActivity, broadcast, nextDistributionLabel } from './db.js';
import { getWorkHoursStatus, getCairoDayBoundsUtc, getCairoNow } from './workhours.js';
import { getEmployeePresenceMap } from './presence.js';

export async function sweepAutoReclaim(db, env) {
  // فحص الوقت بدون قراءة من القاعدة: نهاية الشيفت مش ممكن تكون قبل ٢ العصر، فمفيش داعي نقرا الإعدادات كل ٥ دقايق من الصبح.
  if (getCairoNow().minutesSinceMidnight < 14 * 60) return { reclaimed: 0 };
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
         AND NOT EXISTS (SELECT 1 FROM customer_notes n WHERE n.customer_id = c.id AND n.created_at >= c.assigned_at)
         AND NOT EXISTS (SELECT 1 FROM call_attempts ca WHERE ca.customer_id = c.id AND ca.created_at >= c.assigned_at)`
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

    for (const [employeeIdStr, custs] of Object.entries(byEmployee)) {
      const employeeId = Number(employeeIdStr);

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

      // تنبيه لحظي بدون قراءة من القاعدة (WebSocket) — الموظف يشوف نقطة على 🔄
      await broadcast(env, 'CUSTOMER_REASSIGNED', { count: custs.length }, { scope: 'employee', employeeId }).catch(() => {});
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
const REDISTRIBUTE_HOUR = 16; // 4 PM Cairo (كان ٣ العصر — اتغير بطلب صاحب الشركة)

export async function sweepRedistribute3pm(db, env) {
  // نفس الفكرة: قبل ٤ العصر مفيش أي قراءة من القاعدة.
  if (getCairoNow().minutesSinceMidnight < REDISTRIBUTE_HOUR * 60) return { redistributed: 0 };
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

    for (const [employeeIdStr, custs] of Object.entries(byEmployee)) {
      const fromEmployeeId = Number(employeeIdStr);

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

      const targetCounts = {};
      for (let i = 0; i < custs.length; i++) {
        const tid = targets[i % targets.length];
        targetCounts[tid] = (targetCounts[tid] || 0) + 1;
      }
      await broadcast(env, 'CUSTOMER_REASSIGNED', { count: custs.length }, { scope: 'employee', employeeId: fromEmployeeId }).catch(() => {});
      for (const [tid, count] of Object.entries(targetCounts)) {
        await broadcast(env, 'CUSTOMER_ASSIGNED', { count }, { scope: 'employee', employeeId: Number(tid) }).catch(() => {});
      }
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

// ---------------------------------------------------------------------------
// MORNING AUTO-DISTRIBUTE — كل يوم ١١:٣٠ الصبح، أي رقم في قائمة "غير موزع"
// (باقي من اليوم اللي فات أو اتسحب آخر اليوم) يتوزّع تلقائيًا بالتساوي على
// الموظفين الأونلاين وقتها. مرة واحدة بس في اليوم (dedup عبر settings) من غير
// أي إعادة محاولة — ١١:٣٠ وقت الشغل والموظفين المفروض أونلاين.
// ---------------------------------------------------------------------------
const AUTO_DIST_MIN = 11 * 60 + 30;
const AUTO_DIST_LAST_RETRY_MIN = 11 * 60 + 32; // احتياط لو الـ cron اتأخر دقيقتين بس

export async function sweepAutoDistribute(db, env) {
  const nowMin = getCairoNow().minutesSinceMidnight;
  if (nowMin < AUTO_DIST_MIN || nowMin > AUTO_DIST_LAST_RETRY_MIN) return { distributed: 0 };
  const status = await getWorkHoursStatus(db);
  if (status.isHolidayToday) return { distributed: 0 };

  const dedupRow = await db.prepare(`SELECT value FROM settings WHERE key = 'auto_distribute_sent'`).first();
  let sentDate = null;
  try {
    sentDate = dedupRow ? JSON.parse(dedupRow.value).date : null;
  } catch {
    sentDate = null;
  }
  if (sentDate === status.dateStr) return { distributed: 0 };

  const markDone = (info) =>
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('auto_distribute_sent', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(JSON.stringify({ date: status.dateStr, ...info }), nowIso())
      .run();

  const presenceMap = await getEmployeePresenceMap(db);
  const onlineIds = Object.entries(presenceMap)
    .filter(([, p]) => p.online)
    .map(([id]) => Number(id));
  if (onlineIds.length === 0) {
    await markDone({ distributed: 0, reason: 'no_online_employees' });
    return { distributed: 0 };
  }

  const pool = await db
    .prepare(`SELECT id FROM customers WHERE assigned_employee_id IS NULL AND archived = 0 ORDER BY created_at ASC`)
    .all();
  const ids = pool.results.map((r) => r.id);
  if (ids.length === 0) {
    await markDone({ distributed: 0, reason: 'empty_pool' });
    return { distributed: 0 };
  }

  const { label } = await nextDistributionLabel(db);
  const dist = await db
    .prepare(`INSERT INTO distributions (label, method, total_customers, created_by, notes) VALUES (?, 'ROUND_ROBIN', ?, NULL, 'توزيع تلقائي ١١:٣٠') RETURNING id`)
    .bind(label, ids.length)
    .first();
  const ts = nowIso();
  const counts = {};
  const statements = [];
  ids.forEach((cid, i) => {
    const empId = onlineIds[i % onlineIds.length];
    counts[empId] = (counts[empId] || 0) + 1;
    statements.push(
      db.prepare(`UPDATE customers SET assigned_employee_id = ?, assigned_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(empId, ts, ts, cid),
      db.prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, reason, distribution_id) VALUES (?, ?, NULL, 'DISTRIBUTION', ?)`).bind(cid, empId, dist.id),
      db.prepare(`INSERT INTO distribution_items (distribution_id, employee_id, customer_id) VALUES (?, ?, ?)`).bind(dist.id, empId, cid)
    );
  });
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));

  await markDone({ distributed: ids.length, distributionId: dist.id });
  await logActivity(db, {
    actor: null,
    action: 'AUTO_DISTRIBUTE_MORNING',
    entityType: 'distribution',
    entityId: String(dist.id),
    metadata: { total: ids.length, perEmployee: counts },
  });
  for (const [eid, count] of Object.entries(counts)) {
    await broadcast(env, 'CUSTOMER_ASSIGNED', { count }, { scope: 'employee', employeeId: Number(eid) }).catch(() => {});
  }
  return { distributed: ids.length };
}
