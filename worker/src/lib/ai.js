// مساعد ذكي "غير توليدي" عن قصد: كل إجابة تُنتَج بتشغيل استعلام SQL حقيقي وقابل
// للتدقيق على D1 وتنسيق نتيجته. لا يوجد نموذج لغوي في الحلقة، فلا يوجد شيء
// يمكن أن يختلقه — سؤال لا يطابق نية معروفة ومدعومة بالبيانات يحصل على إجابة
// صريحة بـ"لا تتوفر بيانات كافية" بدلاً من التخمين.

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function weekStart() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function monthStart() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function yesterdayRange() {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

function includesAny(lower, words) {
  return words.some((w) => lower.includes(w));
}

const STATUS_LABELS_AR = {
  NEW: 'جديد', CALLING: 'جاري الاتصال', NO_ANSWER: 'لا يوجد رد', BUSY: 'مشغول',
  FOLLOW_UP: 'متابعة', INTERESTED: 'مهتم', NOT_INTERESTED: 'غير مهتم', CLOSED: 'مغلق',
};

const STATUS_WORDS = {
  new: 'NEW', 'جديد': 'NEW',
  calling: 'CALLING', 'جاري الاتصال': 'CALLING',
  'no answer': 'NO_ANSWER', 'لا يوجد رد': 'NO_ANSWER',
  busy: 'BUSY', 'مشغول': 'BUSY',
  'follow up': 'FOLLOW_UP', 'follow-up': 'FOLLOW_UP', followup: 'FOLLOW_UP', 'متابعة': 'FOLLOW_UP',
  interested: 'INTERESTED', 'مهتم': 'INTERESTED',
  'not interested': 'NOT_INTERESTED', 'غير مهتم': 'NOT_INTERESTED',
  closed: 'CLOSED', 'مغلق': 'CLOSED',
};

async function findMentionedEmployee(db, question) {
  const employees = (await db.prepare(`SELECT id, name, user_id FROM employees`).all()).results;
  const lower = question.toLowerCase();
  return employees.find((e) => lower.includes(e.name.toLowerCase()) || question.includes(e.name)) || null;
}

function findMentionedStatus(question) {
  const lower = question.toLowerCase();
  for (const [word, status] of Object.entries(STATUS_WORDS)) {
    if (lower.includes(word) || question.includes(word)) return status;
  }
  return null;
}

function timeWindowFromQuestion(question) {
  const lower = question.toLowerCase();
  if (includesAny(lower, ['today']) || question.includes('اليوم')) return { label: 'اليوم', from: todayStart() };
  if (includesAny(lower, ['this week']) || question.includes('الأسبوع')) return { label: 'هذا الأسبوع', from: weekStart() };
  if (includesAny(lower, ['this month']) || question.includes('الشهر')) return { label: 'هذا الشهر', from: monthStart() };
  return null;
}

export async function answerQuestion(db, question, askingUser) {
  const q = String(question || '').trim();
  const lower = q.toLowerCase();
  const scopeEmployeeId = askingUser.role === 'employee' ? askingUser.employeeId : null;
  const NO_DATA = 'لا توجد بيانات كافية للإجابة على هذا السؤال بالمعلومات المتاحة حاليًا.';

  // ١. المتابعات المتأخرة حسب الموظف.
  if ((includesAny(lower, ['overdue']) || q.includes('متأخر')) && (includesAny(lower, ['which employee', 'who has', 'employees']) || q.includes('موظف'))) {
    const rows = await db
      .prepare(
        `SELECT e.name, COUNT(*) AS n FROM followups f JOIN employees e ON e.id = f.employee_id WHERE (f.status = 'OVERDUE' OR (f.status = 'UPCOMING' AND f.scheduled_for < datetime('now'))) ${scopeEmployeeId ? 'AND f.employee_id = ?' : ''} GROUP BY e.name ORDER BY n DESC`
      )
      .bind(...(scopeEmployeeId ? [scopeEmployeeId] : []))
      .all();
    if (rows.results.length === 0) return { answer: 'لا يوجد موظفون لديهم متابعات متأخرة حاليًا.', grounded: true };
    return { answer: rows.results.map((r) => `${r.name}: ${r.n} متأخرة`).join('، '), grounded: true, data: rows.results };
  }

  // ٢. عدد العملاء المغلقين [اليوم|الأسبوع|الشهر] [بواسطة موظف].
  if ((includesAny(lower, ['close']) || q.includes('غلق') || q.includes('أغلق') || q.includes('اغلق')) && (includesAny(lower, ['how many', 'did']) || q.includes('كام') || q.includes('كم'))) {
    const employee = await findMentionedEmployee(db, q);
    const window = timeWindowFromQuestion(q) || { label: 'كل الفترات', from: null };
    const conds = [`status = 'CLOSED'`, 'archived = 0'];
    const binds = [];
    if (window.from) {
      conds.push('closed_at >= ?');
      binds.push(window.from);
    }
    if (employee) {
      conds.push('assigned_employee_id = ?');
      binds.push(employee.id);
    } else if (scopeEmployeeId) {
      conds.push('assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    const who = employee ? employee.name : scopeEmployeeId ? 'أنت' : 'الفريق';
    return { answer: `${who} أغلق ${row.n} عميل ${window.label}.`, grounded: true, data: { count: row.n } };
  }

  // ٣. العملاء غير الموزّعين.
  if (lower.includes('unassigned') || q.includes('غير موزّع') || q.includes('غير موزع')) {
    if (scopeEmployeeId) return { answer: NO_DATA, grounded: true };
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id IS NULL AND archived = 0`).first();
    return { answer: `يوجد حاليًا ${row.n} عميل غير موزّع.`, grounded: true, data: { count: row.n } };
  }

  // ٤. عدد العملاء في حالة معينة حاليًا.
  const status = findMentionedStatus(q);
  if (status && (includesAny(lower, ['how many', 'currently']) || q.includes('كام') || q.includes('كم') || q.includes('حاليًا') || q.includes('حاليا'))) {
    const conds = [`status = ?`, 'archived = 0'];
    const binds = [status];
    if (scopeEmployeeId) {
      conds.push('assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    return { answer: `يوجد ${row.n} عميل في حالة "${STATUS_LABELS_AR[status] || status}" حاليًا.`, grounded: true, data: { count: row.n } };
  }

  // ٥. العملاء الذين تم تعيينهم أمس ولم يُحدَّثوا منذ ذلك الحين.
  if ((lower.includes('yesterday') || q.includes('أمس')) && (includesAny(lower, ["haven't been updated", 'not been updated', 'not updated']) || q.includes('لم يُحدَّث') || q.includes('لم يتم تحديث'))) {
    const { start, end } = yesterdayRange();
    const conds = ['assigned_at BETWEEN ? AND ?', 'updated_at <= assigned_at', 'archived = 0'];
    const binds = [start, end];
    if (scopeEmployeeId) {
      conds.push('assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const rows = await db.prepare(`SELECT id, phone, name FROM customers WHERE ${conds.join(' AND ')} LIMIT 50`).bind(...binds).all();
    if (rows.results.length === 0) return { answer: 'لا يوجد عملاء تم تعيينهم أمس بدون تحديث.', grounded: true };
    return { answer: `${rows.results.length} عميل تم تعيينهم أمس بدون تحديث: ${rows.results.map((r) => r.id).join('، ')}`, grounded: true, data: rows.results };
  }

  // ٦. ملخص أداء الفريق اليومي.
  if ((lower.includes('summar') || q.includes('ملخص')) && (lower.includes('today') || lower.includes('team') || lower.includes('performance') || q.includes('اليوم') || q.includes('الفريق') || q.includes('أداء'))) {
    const summary = await generateDailySummary(db);
    return { answer: formatSummaryText(summary), grounded: true, data: summary };
  }

  // ٧. إجمالي العملاء. (يستثني أسئلة "لم تتم رؤيته" الأكثر تحديدًا، تُعالَج في النية ١٠.)
  if ((includesAny(lower, ['how many customers', 'total customers']) || q.includes('إجمالي العملاء') || ((q.includes('كام') || q.includes('كم')) && q.includes('عميل'))) && !q.includes('لم تتم رؤيته') && !q.includes('لم يُرَ')) {
    const conds = ['archived = 0'];
    const binds = [];
    if (scopeEmployeeId) {
      conds.push('assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    return { answer: `يوجد ${row.n} عميل إجمالاً${scopeEmployeeId ? ' موزّع عليك' : ''}.`, grounded: true, data: { count: row.n } };
  }

  // ٨. متوسط زمن الاستجابة.
  if (includesAny(lower, ['average response', 'response time']) || q.includes('سرعة الاستجابة') || q.includes('زمن الاستجابة') || q.includes('متوسط الاستجابة')) {
    const conds = [`h.from_status = 'NEW'`, 'c.assigned_at IS NOT NULL'];
    const binds = [];
    if (scopeEmployeeId) {
      conds.push('c.assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const row = await db
      .prepare(
        `SELECT AVG((julianday(h.changed_at) - julianday(c.assigned_at)) * 24 * 60) AS avg_minutes
         FROM customer_status_history h JOIN customers c ON c.id = h.customer_id WHERE ${conds.join(' AND ')}`
      )
      .bind(...binds)
      .first();
    if (row.avg_minutes == null) return { answer: NO_DATA, grounded: true };
    return { answer: `متوسط زمن أول استجابة هو ${Math.round(row.avg_minutes)} دقيقة.`, grounded: true, data: { avgMinutes: row.avg_minutes } };
  }

  // ٩. أُعيد فتحه اليوم.
  if (lower.includes('reopen') || q.includes('إعادة فتح') || q.includes('اعادة فتح')) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'CUSTOMER_REOPENED' AND created_at >= ?`).bind(todayStart()).first();
    return { answer: `تم إعادة فتح ${row.n} عميل اليوم.`, grounded: true, data: { count: row.n } };
  }

  // ١٠. العملاء الذين لم تتم رؤيتهم.
  if (includesAny(lower, ['not seen', 'not been seen', 'unseen']) || q.includes('لم تتم رؤيته') || q.includes('لم يُرَ') || q.includes('لم ير')) {
    const conds = [`c.archived = 0`, `c.assigned_employee_id IS NOT NULL`, `NOT EXISTS (SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at)`];
    const binds = [];
    if (scopeEmployeeId) { conds.push('c.assigned_employee_id = ?'); binds.push(scopeEmployeeId); }
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    return { answer: `${row.n} عميل لم تتم رؤيته بعد.`, grounded: true, data: { count: row.n } };
  }

  // ١١. تجاوزات مواعيد الخدمة (SLA).
  if (lower.includes('sla') && (includesAny(lower, ['breach', 'how many', 'warning']) || q.includes('تجاوز') || q.includes('تحذير'))) {
    const { getSlaCounts } = await import('./sla.js');
    const counts = await getSlaCounts(db);
    return { answer: `${counts.breached} تجاوز و ${counts.warning} تحذير لموعد الخدمة عبر ${counts.customersAffected} عميل.`, grounded: true, data: counts };
  }

  // ١٢. تقييم عميل محدد (بالكود).
  const custIdMatch = q.match(/RM-\d+/i);
  if (custIdMatch && (lower.includes('lead score') || q.includes('تقييم'))) {
    const { computeLeadScore } = await import('./leadscore.js');
    const id = custIdMatch[0].toUpperCase();
    const customer = await db.prepare(`SELECT id FROM customers WHERE id = ?`).bind(id).first();
    if (!customer) return { answer: 'لم يتم العثور على هذا العميل.', grounded: true };
    const { score, reasons } = await computeLeadScore(db, id);
    return { answer: `تقييم العميل ${id} هو ${score}. الأسباب: ${reasons.map((r) => r.label).join('، ') || 'لا يوجد بعد'}.`, grounded: true, data: { score, reasons } };
  }

  // ١٣. أداء الحملات.
  if (lower.includes('campaign') || q.includes('حملة')) {
    const campaignRow = await db.prepare(`SELECT DISTINCT campaign FROM customers WHERE campaign IS NOT NULL`).all();
    const mentioned = campaignRow.results.find((r) => lower.includes(String(r.campaign).toLowerCase()) || q.includes(String(r.campaign)));
    if (mentioned) {
      const [leads, deals, revenue] = await Promise.all([
        db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE campaign = ? AND archived = 0`).bind(mentioned.campaign).first(),
        db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE c.campaign = ? AND EXISTS (SELECT 1 FROM purchase_transactions p WHERE p.customer_id = c.id AND p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED'))`).bind(mentioned.campaign).first(),
        db.prepare(`SELECT COALESCE(SUM(p.total_amount - p.refunded_amount),0) AS net FROM purchase_transactions p JOIN customers c ON c.id = p.customer_id WHERE c.campaign = ? AND p.status != 'CANCELLED'`).bind(mentioned.campaign).first(),
      ]);
      return { answer: `حملة "${mentioned.campaign}": ${leads.n} عميل محتمل، ${deals.n} صفقة، ${Math.round(revenue.net)} ج.م صافي إيراد.`, grounded: true, data: { leads: leads.n, deals: deals.n, netRevenue: revenue.net } };
    }
  }

  // ١٤. الصفقات / المبيعات اليوم.
  if ((includesAny(lower, ['deal', 'sale']) || q.includes('صفقة') || q.includes('صفقات') || q.includes('مبيعات')) && (lower.includes('today') || q.includes('اليوم'))) {
    const today = todayStart();
    const row = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_amount - refunded_amount),0) AS net FROM purchase_transactions WHERE purchase_at >= ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`).bind(today).first();
    return { answer: `تمت ${row.n} صفقة اليوم، بصافي إيراد ${Math.round(row.net)} ج.م.`, grounded: true, data: { deals: row.n, netRevenue: row.net } };
  }

  // ١٥. إجمالي المبيعات / صافي الإيراد (كل الفترات أو فترة محددة).
  if (includesAny(lower, ['total sales', 'net revenue']) || (lower.includes('revenue') && lower.includes('how much')) || q.includes('صافي الإيراد') || q.includes('إجمالي المبيعات') || q.includes('الإيراد')) {
    const window = timeWindowFromQuestion(q);
    const conds = [`status != 'CANCELLED'`];
    const binds = [];
    if (window?.from) { conds.push('purchase_at >= ?'); binds.push(window.from); }
    const row = await db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS gross, COALESCE(SUM(refunded_amount),0) AS refunds FROM purchase_transactions WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    const net = Math.round((row.gross - row.refunds) * 100) / 100;
    return { answer: `صافي الإيراد${window ? ' ' + window.label : ''}: ${net} ج.م (إجمالي ${Math.round(row.gross)}، مرتجعات ${Math.round(row.refunds)}).`, grounded: true, data: { gross: row.gross, refunds: row.refunds, net } };
  }

  // ١٦. زيارات فرع بدون شراء (مقياس صريح، غير مُستنتج).
  if ((lower.includes('branch visit') || q.includes('زيارة فرع') || q.includes('زيارات الفرع')) && (includesAny(lower, ['no purchase', 'without', 'did not buy', "didn't buy"]) || q.includes('بدون شراء') || q.includes('لم يشترِ') || q.includes('لم يشتري'))) {
    const row = await db
      .prepare(
        `SELECT COUNT(DISTINCT bv.customer_id) AS n FROM customer_branch_visits bv
         WHERE NOT EXISTS (SELECT 1 FROM purchase_transactions p WHERE p.customer_id = bv.customer_id AND p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED'))`
      )
      .first();
    return { answer: `${row.n} عميل زار الفرع ولم يشترِ بعد.`, grounded: true, data: { count: row.n } };
  }

  // ١٧. المرتجعات.
  if (lower.includes('refund') || q.includes('استرجاع') || q.includes('مرتجع')) {
    const window = timeWindowFromQuestion(q);
    const conds = [];
    const binds = [];
    if (window?.from) { conds.push('created_at >= ?'); binds.push(window.from); }
    const row = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(refund_amount),0) AS total FROM purchase_refunds ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}`).bind(...binds).first();
    return { answer: `${row.n} عملية استرجاع${window ? ' ' + window.label : ''} بإجمالي ${Math.round(row.total)} ج.م.`, grounded: true, data: { count: row.n, total: row.total } };
  }

  // ١٨. مبيعات كل موظف.
  const salesEmployee = await findMentionedEmployee(db, q);
  if (salesEmployee && (includesAny(lower, ['sale', 'deal', 'revenue']) || q.includes('مبيعات') || q.includes('صفقات') || q.includes('إيراد'))) {
    const row = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_amount - refunded_amount),0) AS net FROM purchase_transactions WHERE attributed_employee_id = ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`).bind(salesEmployee.id).first();
    return { answer: `لدى ${salesEmployee.name} ${row.n} صفقة منسوبة إليه، بصافي إيراد ${Math.round(row.net)} ج.م.`, grounded: true, data: { deals: row.n, netRevenue: row.net } };
  }

  // ١٩. أفضل المنتجات مبيعًا.
  if (includesAny(lower, ['top product', 'best sell', 'bestsell']) || q.includes('أفضل المنتجات') || q.includes('الأكثر مبيعًا')) {
    const rows = await db
      .prepare(`SELECT product_name, SUM(quantity) AS qty, COUNT(DISTINCT purchase_id) AS orders FROM purchase_items GROUP BY product_name ORDER BY qty DESC LIMIT 5`)
      .all();
    if (rows.results.length === 0) return { answer: 'لا توجد أصناف مبيعات مسجّلة بعد.', grounded: true };
    return { answer: 'أفضل المنتجات: ' + rows.results.map((r) => `${r.product_name} (${r.qty} وحدة، ${r.orders} طلب)`).join('، '), grounded: true, data: rows.results };
  }

  return { answer: NO_DATA, grounded: true };
}

export async function generateDailySummary(db) {
  const today = todayStart();
  const [total, assigned, unassigned, closedToday, interested, followUp, overdue, reopenedToday, sla, sales] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND assigned_employee_id IS NOT NULL`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND assigned_employee_id IS NULL`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND closed_at >= ?`).bind(today).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND status = 'INTERESTED'`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND status = 'FOLLOW_UP'`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE (status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now')))`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'CUSTOMER_REOPENED' AND created_at >= ?`).bind(today).first(),
    import('./sla.js').then((m) => m.getSlaCounts(db)),
    db.prepare(`SELECT COUNT(*) AS deals, COALESCE(SUM(total_amount - refunded_amount),0) AS net FROM purchase_transactions WHERE purchase_at >= ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`).bind(today).first(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    timeRange: 'اليوم',
    totalCustomers: total.n,
    assigned: assigned.n,
    unassigned: unassigned.n,
    closedToday: closedToday.n,
    interested: interested.n,
    followUp: followUp.n,
    overdue: overdue.n,
    reopenedToday: reopenedToday.n,
    slaBreaches: sla.breached,
    slaWarnings: sla.warning,
    dealsToday: sales.deals,
    netRevenueToday: Math.round(sales.net * 100) / 100,
  };
}

function formatSummaryText(s) {
  return (
    `ملخص الفريق — ${s.totalCustomers} عميل إجمالاً (${s.assigned} موزّع، ${s.unassigned} غير موزّع). ` +
    `${s.closedToday} تم إغلاقهم اليوم، ${s.interested} مهتم، ${s.followUp} قيد المتابعة، ${s.overdue} متابعة متأخرة، ${s.reopenedToday} أُعيد فتحه اليوم. ` +
    `مواعيد الخدمة: ${s.slaBreaches} تجاوز، ${s.slaWarnings} تحذير. المبيعات: ${s.dealsToday} صفقة اليوم، صافي إيراد ${s.netRevenueToday} ج.م اليوم.`
  );
}

// كل ملاحظة تحمل بياناتها الداعمة ونطاقها الزمني الخاص بها حتى لا تُعرض أبدًا
// كتأكيد مجرد — يستطيع قائد الفريق دائمًا رؤية الأرقام بالضبط التي أنتجتها.
export async function generateOperationalInsights(db) {
  const insights = [];
  const now = new Date().toISOString();

  const staleRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND updated_at <= datetime('now','-24 hours') AND status NOT IN ('CLOSED')`)
    .first();
  if (staleRow.n > 0) insights.push({ text: `${staleRow.n} عميل لم يتم تحديثهم منذ أكثر من ٢٤ ساعة.`, supportingData: { count: staleRow.n }, timeRange: 'آخر ٢٤ ساعة', generatedAt: now });

  const overdueRow = await db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE (status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now')))`).first();
  if (overdueRow.n > 0) insights.push({ text: `${overdueRow.n} متابعة متأخرة.`, supportingData: { count: overdueRow.n }, timeRange: 'حتى الآن', generatedAt: now });

  const unassignedRow = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND assigned_employee_id IS NULL`).first();
  if (unassignedRow.n > 0) insights.push({ text: `${unassignedRow.n} عميل ما زال غير موزّع.`, supportingData: { count: unassignedRow.n }, timeRange: 'حتى الآن', generatedAt: now });

  const reopenedRow = await db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'CUSTOMER_REOPENED' AND created_at >= ?`).bind(todayStart()).first();
  if (reopenedRow.n > 0) insights.push({ text: `تم إعادة فتح ${reopenedRow.n} عميل اليوم.`, supportingData: { count: reopenedRow.n }, timeRange: 'اليوم', generatedAt: now });

  const unavailableRow = await db.prepare(`SELECT COUNT(*) AS n FROM employees WHERE active = 1 AND availability != 'AVAILABLE'`).first();
  if (unavailableRow.n > 0) insights.push({ text: `${unavailableRow.n} موظف غير متاح حاليًا.`, supportingData: { count: unavailableRow.n }, timeRange: 'حتى الآن', generatedAt: now });

  const { getSlaCounts } = await import('./sla.js');
  const slaCounts = await getSlaCounts(db);
  if (slaCounts.breached > 0) insights.push({ text: `${slaCounts.breached} عميل في حالة تجاوز لموعد الخدمة حاليًا.`, supportingData: slaCounts, timeRange: 'حتى الآن', generatedAt: now });

  const noPurchaseVisitRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT bv.customer_id) AS n FROM customer_branch_visits bv
       WHERE NOT EXISTS (SELECT 1 FROM purchase_transactions p WHERE p.customer_id = bv.customer_id AND p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED'))`
    )
    .first();
  if (noPurchaseVisitRow.n > 0) insights.push({ text: `${noPurchaseVisitRow.n} عميل زار فرعًا ولم يشترِ بعد.`, supportingData: { count: noPurchaseVisitRow.n }, timeRange: 'كل الفترات', generatedAt: now });

  if (insights.length === 0) insights.push({ text: 'لا توجد مشكلات تشغيلية ظاهرة في البيانات الحالية.', supportingData: {}, timeRange: 'حتى الآن', generatedAt: now });
  return insights;
}
