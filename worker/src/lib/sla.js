// SLA engine. Thresholds are configurable (settings.sla_rules). The live state
// shown anywhere in the UI is always recomputed from real timestamps — never
// cached/stored — so it can never go stale (same principle as OVERDUE
// follow-up detection). sla_events exists ONLY so the cron sweep notifies once
// per breach/warning instead of re-notifying every minute, and so there's an
// audit trail of when SLA states changed.
//
// FOLLOWUP_DUE_SLA (a follow-up past its scheduled time) deliberately reuses
// the existing, already-tested OVERDUE follow-up detection/notification
// pipeline (routes/followups.js sweepOverdueFollowups) rather than duplicating
// it here — it is exposed in computeCustomerSla() for display purposes only.
import { nowIso, broadcast, createNotification, logActivity } from './db.js';

const DEFAULT_RULES = { seenWithinMinutes: 10, contactWithinMinutesAfterSeen: 15, followupWithinMinutesAfterInterested: 60 };
const WARNING_FRACTION = 0.7;

export async function getSlaRules(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'sla_rules'`).first();
  if (!row) return { ...DEFAULT_RULES };
  try {
    return { ...DEFAULT_RULES, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

function classify(elapsedMinutes, thresholdMinutes) {
  if (elapsedMinutes >= thresholdMinutes) return 'BREACHED';
  if (elapsedMinutes >= thresholdMinutes * WARNING_FRACTION) return 'WARNING';
  return 'OK';
}

// Each candidate query returns every customer for whom the rule's required
// action has NOT yet happened, regardless of how much time has elapsed —
// classification (OK/WARNING/BREACHED) happens afterward in JS against the
// configurable threshold, so a settings change takes effect immediately
// without touching these queries.
export async function findSeenSlaCandidates(db, customerId) {
  const { results } = await db
    .prepare(
      `SELECT c.id AS customer_id, c.assigned_employee_id AS employee_id, c.assigned_at AS anchor_at
       FROM customers c
       WHERE c.archived = 0 AND c.status != 'CLOSED' AND c.assigned_employee_id IS NOT NULL AND c.assigned_at IS NOT NULL
         ${customerId ? 'AND c.id = ?' : ''}
         AND NOT EXISTS (
           SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at
         )`
    )
    .bind(...(customerId ? [customerId] : []))
    .all();
  return results;
}

export async function findContactSlaCandidates(db, customerId) {
  const { results } = await db
    .prepare(
      `SELECT cs.customer_id AS customer_id, cs.employee_id AS employee_id, cs.seen_at AS anchor_at
       FROM customer_seen cs
       JOIN customers c ON c.id = cs.customer_id AND c.assigned_employee_id = cs.employee_id
       WHERE c.archived = 0 AND c.status != 'CLOSED'
         ${customerId ? 'AND c.id = ?' : ''}
         AND NOT EXISTS (SELECT 1 FROM call_attempts ca WHERE ca.customer_id = cs.customer_id AND ca.created_at >= cs.seen_at)
         AND NOT EXISTS (SELECT 1 FROM whatsapp_interactions wi WHERE wi.customer_id = cs.customer_id AND wi.created_at >= cs.seen_at)`
    )
    .bind(...(customerId ? [customerId] : []))
    .all();
  return results;
}

export async function findInterestedFollowupSlaCandidates(db, customerId) {
  const { results } = await db
    .prepare(
      `SELECT c.id AS customer_id, c.assigned_employee_id AS employee_id,
         (SELECT MAX(h.changed_at) FROM customer_status_history h WHERE h.customer_id = c.id AND h.to_status = 'INTERESTED') AS anchor_at
       FROM customers c
       WHERE c.archived = 0 AND c.status = 'INTERESTED'
         ${customerId ? 'AND c.id = ?' : ''}
         AND NOT EXISTS (
           SELECT 1 FROM followups f WHERE f.customer_id = c.id
             AND f.created_at >= (SELECT MAX(h2.changed_at) FROM customer_status_history h2 WHERE h2.customer_id = c.id AND h2.to_status = 'INTERESTED')
         )`
    )
    .bind(...(customerId ? [customerId] : []))
    .all();
  return results.filter((r) => r.anchor_at);
}

const RULES = [
  { rule: 'SEEN_SLA', find: findSeenSlaCandidates, thresholdKey: 'seenWithinMinutes' },
  { rule: 'CONTACT_SLA', find: findContactSlaCandidates, thresholdKey: 'contactWithinMinutesAfterSeen' },
  { rule: 'INTERESTED_FOLLOWUP_SLA', find: findInterestedFollowupSlaCandidates, thresholdKey: 'followupWithinMinutesAfterInterested' },
];

/** Live SLA snapshot for one customer — used by Customer 360 and list badges. */
export async function computeCustomerSla(db, customerId, rules) {
  rules = rules || (await getSlaRules(db));
  const now = Date.now();
  const out = { seen: null, contact: null, interestedFollowup: null, followupDue: null, worst: 'OK' };

  const [seenRows, contactRows, interestedRows, overdueFollowup] = await Promise.all([
    findSeenSlaCandidates(db, customerId),
    findContactSlaCandidates(db, customerId),
    findInterestedFollowupSlaCandidates(db, customerId),
    db.prepare(`SELECT id FROM followups WHERE customer_id = ? AND (status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now')))`).bind(customerId).first(),
  ]);

  if (seenRows[0]) {
    const mins = (now - new Date(seenRows[0].anchor_at).getTime()) / 60000;
    out.seen = { level: classify(mins, rules.seenWithinMinutes), elapsedMinutes: Math.round(mins), thresholdMinutes: rules.seenWithinMinutes };
  }
  if (contactRows[0]) {
    const mins = (now - new Date(contactRows[0].anchor_at).getTime()) / 60000;
    out.contact = { level: classify(mins, rules.contactWithinMinutesAfterSeen), elapsedMinutes: Math.round(mins), thresholdMinutes: rules.contactWithinMinutesAfterSeen };
  }
  if (interestedRows[0]) {
    const mins = (now - new Date(interestedRows[0].anchor_at).getTime()) / 60000;
    out.interestedFollowup = { level: classify(mins, rules.followupWithinMinutesAfterInterested), elapsedMinutes: Math.round(mins), thresholdMinutes: rules.followupWithinMinutesAfterInterested };
  }
  if (overdueFollowup) out.followupDue = { level: 'BREACHED' };

  const levels = [out.seen?.level, out.contact?.level, out.interestedFollowup?.level, out.followupDue?.level].filter(Boolean);
  out.worst = levels.includes('BREACHED') ? 'BREACHED' : levels.includes('WARNING') ? 'WARNING' : 'OK';
  return out;
}

async function notifyForEvent(db, env, { rule, level, customerId, employeeId }) {
  const customer = await db.prepare(`SELECT id, name, normalized_phone FROM customers WHERE id = ?`).bind(customerId).first();
  const label = customer?.name || customer?.normalized_phone || customerId;
  const ruleLabel = { SEEN_SLA: 'be seen', CONTACT_SLA: 'be contacted', INTERESTED_FOLLOWUP_SLA: 'get a follow-up' }[rule] || rule;
  const title = level === 'BREACHED' ? `🔴 SLA breached — ${customerId}` : `🟠 SLA warning — ${customerId}`;
  const message = `${label} needed to ${ruleLabel} within SLA.`;

  const employeeUser = employeeId ? await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(employeeId).first() : null;
  if (employeeUser) {
    await createNotification(db, { userId: employeeUser.user_id, type: level === 'BREACHED' ? 'SLA_BREACHED' : 'SLA_WARNING', title, message, entityType: 'customer', entityId: customerId });
  }
  if (level === 'BREACHED') {
    const tls = await db.prepare(`SELECT id FROM users WHERE role = 'team_leader' AND active = 1`).all();
    for (const tl of tls.results) {
      await createNotification(db, { userId: tl.id, type: 'SLA_BREACHED', title, message, entityType: 'customer', entityId: customerId });
    }
  }
  await broadcast(env, level === 'BREACHED' ? 'SLA_BREACHED' : 'SLA_WARNING', { customerId, rule, employeeId }, { scope: 'role', role: 'team_leader' });
  if (employeeId) await broadcast(env, level === 'BREACHED' ? 'SLA_BREACHED' : 'SLA_WARNING', { customerId, rule }, { scope: 'employee', employeeId });
}

/** Cron sweep: dedups notifications via sla_events, and auto-resolves events whose underlying condition cleared. */
export async function sweepSlaBreaches(db, env) {
  const rules = await getSlaRules(db);
  const now = nowIso();
  let warned = 0;
  let breached = 0;
  let resolved = 0;

  for (const { rule, find, thresholdKey } of RULES) {
    const candidates = await find(db);
    const candidateByCustomer = new Map(candidates.map((r) => [r.customer_id, r]));

    const openEvents = await db.prepare(`SELECT id, customer_id, level FROM sla_events WHERE rule = ? AND resolved_at IS NULL`).bind(rule).all();
    const openByCustomer = new Map(openEvents.results.map((r) => [r.customer_id, r]));

    // Resolve anything no longer a candidate at all (the required action happened).
    for (const [customerId, ev] of openByCustomer) {
      if (!candidateByCustomer.has(customerId)) {
        await db.prepare(`UPDATE sla_events SET resolved_at = ? WHERE id = ?`).bind(now, ev.id).run();
        resolved++;
      }
    }

    for (const candidate of candidates) {
      const mins = (Date.now() - new Date(candidate.anchor_at).getTime()) / 60000;
      const level = classify(mins, rules[thresholdKey]);
      const existing = openByCustomer.get(candidate.customer_id);

      if (level === 'OK') {
        if (existing) {
          await db.prepare(`UPDATE sla_events SET resolved_at = ? WHERE id = ?`).bind(now, existing.id).run();
          resolved++;
        }
        continue;
      }
      if (existing && existing.level === level) continue; // already notified at this level
      if (existing && existing.level === 'WARNING' && level === 'BREACHED') {
        await db.prepare(`UPDATE sla_events SET resolved_at = ? WHERE id = ?`).bind(now, existing.id).run();
      }
      if (existing && existing.level === 'BREACHED' && level === 'WARNING') continue; // never de-escalate a breach

      await db
        .prepare(`INSERT INTO sla_events (customer_id, employee_id, rule, level) VALUES (?, ?, ?, ?)`)
        .bind(candidate.customer_id, candidate.employee_id ?? null, rule, level)
        .run();
      await notifyForEvent(db, env, { rule, level, customerId: candidate.customer_id, employeeId: candidate.employee_id });
      if (level === 'BREACHED') breached++;
      else warned++;
    }
  }
  return { warned, breached, resolved };
}

/** Count of customers currently breaching/warning any rule — for Command Center. */
export async function getSlaCounts(db) {
  const rules = await getSlaRules(db);
  const [seen, contact, interested] = await Promise.all([
    findSeenSlaCandidates(db),
    findContactSlaCandidates(db),
    findInterestedFollowupSlaCandidates(db),
  ]);
  let warning = 0;
  let breached = 0;
  const seenIds = new Set();
  for (const [rows, key] of [
    [seen, 'seenWithinMinutes'],
    [contact, 'contactWithinMinutesAfterSeen'],
    [interested, 'followupWithinMinutesAfterInterested'],
  ]) {
    for (const r of rows) {
      const mins = (Date.now() - new Date(r.anchor_at).getTime()) / 60000;
      const level = classify(mins, rules[key]);
      if (level === 'OK') continue;
      seenIds.add(r.customer_id);
      if (level === 'BREACHED') breached++;
      else warning++;
    }
  }
  return { warning, breached, customersAffected: seenIds.size };
}
