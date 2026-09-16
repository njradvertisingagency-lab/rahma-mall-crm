// Explainable Lead Score (0-100), computed live from real signals every time
// it's requested — never stored, so it can never drift from the underlying
// data. Every point is attributed to a real, named reason; nothing here is
// randomized or guessed.
import { computeCustomerSla } from './sla.js';

const DEFAULT_WEIGHTS = {
  interested: 25,
  contacted: 15,
  followupScheduled: 10,
  whatsappInteraction: 12,
  recentActivityBonus: 18,
  closedWon: 20,
  callAttemptPenalty: -3,
  noAnswerStreakPenalty: -5,
  slaBreachPenalty: -8,
};

export async function getLeadScoreWeights(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'lead_score_weights'`).first();
  if (!row) return { ...DEFAULT_WEIGHTS };
  try {
    return { ...DEFAULT_WEIGHTS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

export async function computeLeadScore(db, customerId, opts = {}) {
  const weights = opts.weights || (await getLeadScoreWeights(db));
  const customer = await db.prepare(`SELECT status, closed_reason, updated_at FROM customers WHERE id = ?`).bind(customerId).first();
  if (!customer) return { score: 0, reasons: [] };

  const [callAttemptsRes, whatsappRow, openFollowup, slaState] = await Promise.all([
    db.prepare(`SELECT outcome, created_at FROM call_attempts WHERE customer_id = ? ORDER BY created_at DESC`).bind(customerId).all(),
    db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_interactions WHERE customer_id = ?`).bind(customerId).first(),
    db.prepare(`SELECT id FROM followups WHERE customer_id = ? AND status IN ('UPCOMING','DUE','OVERDUE') LIMIT 1`).bind(customerId).first(),
    computeCustomerSla(db, customerId).catch(() => null),
  ]);
  const attempts = callAttemptsRes.results;

  const reasons = [];
  let score = 0;
  const add = (label, points) => {
    if (!points) return;
    score += points;
    reasons.push({ label, points });
  };

  if (customer.status === 'INTERESTED') add('Interested', weights.interested);
  if (customer.status === 'CLOSED' && customer.closed_reason === 'Purchased') add('Closed — purchased', weights.closedWon);

  const contacted = attempts.length > 0 || whatsappRow.n > 0;
  if (contacted) add('Contacted', weights.contacted);
  if (whatsappRow.n > 0) add('WhatsApp interaction', weights.whatsappInteraction);
  if (openFollowup) add('Follow-up scheduled', weights.followupScheduled);

  if (customer.updated_at && Date.now() - new Date(customer.updated_at).getTime() < 24 * 3600 * 1000) {
    add('Recent activity (last 24h)', weights.recentActivityBonus);
  }

  if (attempts.length >= 3 && attempts.slice(0, 3).every((a) => a.outcome === 'NO_ANSWER')) {
    add('3+ consecutive no-answer', weights.noAnswerStreakPenalty);
  } else {
    const failedCount = attempts.filter((a) => a.outcome !== 'ANSWERED').length;
    if (failedCount > 0) add(`${failedCount} unanswered call attempt(s)`, weights.callAttemptPenalty * failedCount);
  }

  if (slaState && slaState.worst === 'BREACHED') add('SLA breached', weights.slaBreachPenalty);

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons };
}
