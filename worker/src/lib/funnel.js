// Sales/call-team funnel — cumulative "ever reached this stage" semantics for
// a cohort of leads (optionally scoped to a date range on customers.created_at).
// Every count is a real query against real tables; nothing here is guessed.
function round2(n) {
  return Math.round(n * 100) / 100;
}

export async function computeFunnel(db, { from, to } = {}) {
  const dateFilter = from && to ? 'AND c.created_at BETWEEN ? AND ?' : '';
  const binds = () => (from && to ? [from, to] : []);

  const [leads, assigned, seen, contacted, interested, followup, branchVisit, dealDone, revenueRow] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 ${dateFilter}`).bind(...binds()).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 AND c.assigned_employee_id IS NOT NULL ${dateFilter}`).bind(...binds()).first(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 AND c.assigned_employee_id IS NOT NULL ${dateFilter}
         AND EXISTS (SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at)`
      )
      .bind(...binds())
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 ${dateFilter}
         AND (EXISTS (SELECT 1 FROM call_attempts ca WHERE ca.customer_id = c.id) OR EXISTS (SELECT 1 FROM whatsapp_interactions wi WHERE wi.customer_id = c.id))`
      )
      .bind(...binds())
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 ${dateFilter}
         AND (c.status = 'INTERESTED' OR EXISTS (SELECT 1 FROM customer_status_history h WHERE h.customer_id = c.id AND h.to_status = 'INTERESTED'))`
      )
      .bind(...binds())
      .first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 ${dateFilter} AND EXISTS (SELECT 1 FROM followups f WHERE f.customer_id = c.id)`).bind(...binds()).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 ${dateFilter} AND EXISTS (SELECT 1 FROM customer_branch_visits bv WHERE bv.customer_id = c.id)`).bind(...binds()).first(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 ${dateFilter}
         AND EXISTS (SELECT 1 FROM purchase_transactions p WHERE p.customer_id = c.id AND p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED'))`
      )
      .bind(...binds())
      .first(),
    db
      .prepare(
        `SELECT COALESCE(SUM(p.total_amount - p.refunded_amount), 0) AS revenue FROM purchase_transactions p JOIN customers c ON c.id = p.customer_id WHERE p.status != 'CANCELLED' ${dateFilter}`
      )
      .bind(...binds())
      .first(),
  ]);

  const stages = [
    { key: 'leads', label: 'العملاء المحتملون', count: leads.n },
    { key: 'assigned', label: 'موزّع', count: assigned.n },
    { key: 'seen', label: 'تمت رؤيته', count: seen.n },
    { key: 'contacted', label: 'تم التواصل', count: contacted.n },
    { key: 'interested', label: 'مهتم', count: interested.n },
    { key: 'followup', label: 'متابعة', count: followup.n },
    { key: 'branchVisit', label: 'زيارة فرع', count: branchVisit.n },
    { key: 'dealDone', label: 'تمت الصفقة', count: dealDone.n },
  ];
  const base = leads.n || 1;
  return {
    stages: stages.map((s, i) => ({
      ...s,
      percentOfLeads: Math.round((s.count / base) * 1000) / 10,
      conversionFromPrev: i === 0 ? null : stages[i - 1].count > 0 ? Math.round((s.count / stages[i - 1].count) * 1000) / 10 : 0,
    })),
    revenue: round2(revenueRow.revenue),
  };
}
