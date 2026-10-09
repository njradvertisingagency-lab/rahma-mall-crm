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
import { nowIso } from './db.js';

const DEFAULT_RULES = { seenWithinMinutes: 10, contactWithinMinutesAfterSeen: 15, followupWithinMinutesAfterInterested: 60, customerWaitingMinutes: 720 };
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

// "Customer waiting for you" — any active, assigned customer whose record
// hasn't been touched (status/notes/call attempts/etc. all bump
// customers.updated_at) in a long time. Unlike the three rules above, this
// one is about staleness in general, not a specific missed step — so it
// reuses the same anchor/threshold/dedup machinery but is swept into its
// own `waiting_events` table (see sweepCustomerWaiting below) and always
// alerts the employee themselves, not just the Team Leader.
export async function findWaitingCandidates(db, customerId) {
  const { results } = await db
    .prepare(
      `SELECT c.id AS customer_id, c.assigned_employee_id AS employee_id, c.updated_at AS anchor_at
       FROM customers c
       WHERE c.archived = 0 AND c.status != 'CLOSED' AND c.assigned_employee_id IS NOT NULL
         ${customerId ? 'AND c.id = ?' : ''}`
    )
    .bind(...(customerId ? [customerId] : []))
    .all();
  return results;
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

const RULE_LABELS = {
  SEEN_SLA: 'أن تتم رؤيته',
  CONTACT_SLA: 'أن يتم التواصل معه',
  INTERESTED_FOLLOWUP_SLA: 'أن يحصل على متابعة',
};

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
