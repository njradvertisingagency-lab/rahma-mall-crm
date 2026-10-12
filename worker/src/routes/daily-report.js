import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { getCairoNow, getCairoDayBoundsUtc } from '../lib/workhours.js';
import { toInternational } from '../lib/whatsapp.js';

export const dailyReportRoutes = new Hono();
dailyReportRoutes.use('*', requireAuth);

// رقم التيم ليدر (واتساب) — يتحط في settings لو عايز يتغير بعدين.
const TEAM_LEADER_PHONE = '01153557528';

// GET /daily-report — تقرير الموظف اليومي: كل اللي عمله من أول ما وصل لحد دلوقتي.
dailyReportRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  try {

  // الموظف المرتبط بالمستخدم
  const emp = await db.prepare(`SELECT id, name FROM employees WHERE user_id = ? AND active = 1`).bind(user.id).first();
  if (!emp) return c.json({ error: 'لا يوجد موظف مرتبط بالحساب' }, 400);

  const { dateStr } = getCairoNow();
  const { dayStartIso, dayEndIso } = getCairoDayBoundsUtc(dateStr);

  // 1. إجمالي الأرقام اللي استلمها النهاردة
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id = ? AND assigned_at >= ? AND assigned_at <= ? AND archived = 0`)
    .bind(emp.id, dayStartIso, dayEndIso)
    .first();
  const totalReceived = totalRow.n;

  // 2. الأرقام اللي كانت عنده النهاردة بس اتسحبت (assigned today then reassigned away)
  const reclaimedRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT ca1.customer_id) AS n
       FROM customer_assignments ca1
       WHERE ca1.employee_id = ? AND ca1.assigned_at >= ? AND ca1.assigned_at <= ?
         AND ca1.reason = 'DISTRIBUTION'
         AND NOT EXISTS (
           SELECT 1 FROM customers c WHERE c.id = ca1.customer_id AND c.assigned_employee_id = ?
         )`
    )
    .bind(emp.id, dayStartIso, dayEndIso, emp.id)
    .first();
  const reclaimedCount = reclaimedRow.n;

  // 3. ملاحظات مكتوبة النهاردة
  const notesRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT n.customer_id) AS customers, COUNT(*) AS total
       FROM customer_notes n
       JOIN customers c ON c.id = n.customer_id
       WHERE n.author_id = ? AND n.created_at >= ? AND n.created_at <= ?`
    )
    .bind(user.id, dayStartIso, dayEndIso)
    .first();

  // 4. مكالمات النهاردة — إجمالي + تفصيل حسب النتيجة
  const callsRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM call_attempts WHERE employee_id = ? AND created_at >= ? AND created_at <= ?`)
    .bind(emp.id, dayStartIso, dayEndIso)
    .first();

  const callOutcomeRows = await db
    .prepare(`SELECT outcome, COUNT(*) AS n FROM call_attempts WHERE employee_id = ? AND created_at >= ? AND created_at <= ? GROUP BY outcome`)
    .bind(emp.id, dayStartIso, dayEndIso)
    .all();
  const callOutcomeMap = {};
  for (const r of callOutcomeRows.results) callOutcomeMap[r.outcome] = r.n;

  // 5. واتساب — عملاء اتبعتلهم واتساب النهاردة (whatsapp_interactions)
  const waRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT wi.customer_id) AS n
       FROM whatsapp_interactions wi
       WHERE wi.employee_id = ? AND wi.created_at >= ? AND wi.created_at <= ?`
    )
    .bind(emp.id, dayStartIso, dayEndIso)
    .first();

  // 6. حالات العملاء اللي لسه معاه
  const statusRows = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM customers
       WHERE assigned_employee_id = ? AND assigned_at >= ? AND assigned_at <= ? AND archived = 0
       GROUP BY status`
    )
    .bind(emp.id, dayStartIso, dayEndIso)
    .all();
  const statusMap = {};
  for (const r of statusRows.results) statusMap[r.status] = r.n;

  // 7. وقت الحضور
  const attendanceRow = await db
    .prepare(`SELECT check_in_at FROM attendance_records WHERE user_id = ? AND work_date = ?`)
    .bind(user.id, dateStr)
    .first();

  const CALL_OUTCOME_AR = {
    ANSWERED: 'رد ✅',
    NO_ANSWER: 'مارد 📵',
    BUSY: 'مشغول 🔴',
    WRONG_NUMBER: 'رقم غلط ❌',
    SWITCHED_OFF: 'مغلق 📴',
    REJECTED: 'رفض 🚫',
  };

  const STATUS_AR = {
    NEW: 'جديد',
    NO_ANSWER: 'لا يوجد رد',
    FOLLOW_UP: 'متابعة',
    INTERESTED: 'مهتم',
    NOT_INTERESTED: 'غير مهتم',
    SOLD: 'تم البيع',
    CUSTOMER_WAITING: 'عميل منتظر',
    CLOSED: 'مغلق',
  };

  const STATUS_EMOJI = {
    NEW: '🆕', NO_ANSWER: '📵', FOLLOW_UP: '🔁', INTERESTED: '⭐',
    NOT_INTERESTED: '❌', SOLD: '💰', CUSTOMER_WAITING: '⏳', CLOSED: '✅',
  };

  // بناء نص التقرير
  const d = dateStr.split('-');
  const dateAr = `${d[2]}/${d[1]}/${d[0]}`;

  let checkinStr = '—';
  if (attendanceRow?.check_in_at) {
    const t = new Date(attendanceRow.check_in_at);
    const h = t.getUTCHours() + 2; // Cairo = UTC+2 (approximate)
    const m = String(t.getUTCMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'م' : 'ص';
    const h12 = h > 12 ? h - 12 : h || 12;
    checkinStr = `${h12}:${m} ${ampm}`;
  }

  const remaining = totalReceived - reclaimedCount;

  const statusLines = Object.entries(statusMap)
    .map(([k, v]) => `  ${STATUS_EMOJI[k] || '•'} ${STATUS_AR[k] || k}: *${v}*`)
    .join('\n');

  const callOutcomeLines = Object.entries(callOutcomeMap)
    .map(([k, v]) => `  ${CALL_OUTCOME_AR[k] || k}: *${v}*`)
    .join('\n');

  const reportText = [
    `━━━━━━━━━━━━━━━━━━━`,
    `📊 *تقرير يومي — ${dateAr}*`,
    `👤 *${emp.name}*`,
    `⏰ الحضور: ${checkinStr}`,
    `━━━━━━━━━━━━━━━━━━━`,
    '',
    `📱 *الأرقام*`,
    `  استلمت: *${totalReceived}* رقم`,
    `  اتسحب: *${reclaimedCount}* رقم`,
    `  باقي معايا: *${remaining}* رقم`,
    '',
    `📞 *المكالمات: ${callsRow.n} محاولة*`,
    callOutcomeLines || '  لا توجد مكالمات',
    '',
    `✍️ *الملاحظات*`,
    `  كتبت على: *${notesRow.customers}* عميل (${notesRow.total} ملاحظة)`,
    '',
    `💬 *واتساب:* ${waRow.n} عميل`,
    '',
    `📈 *توزيع الحالات:*`,
    statusLines || '  لا توجد حالات',
    '',
    `━━━━━━━━━━━━━━━━━━━`,
    `🏢 *رحمة مول — CRM*`,
  ].filter(Boolean).join('\n');

  const waUrl = `https://wa.me/${toInternational(TEAM_LEADER_PHONE)}?text=${encodeURIComponent(reportText)}`;

  // الزرار يفتح الساعه ٥:٤٥ بالظبط — نفس وقت سحب الأرقام
  const { minutesSinceMidnight } = getCairoNow();
  const canSend = minutesSinceMidnight >= 17 * 60 + 45; // 5:45 PM Cairo

  return c.json({
    date: dateStr,
    employeeName: emp.name,
    checkinTime: checkinStr,
    totalReceived,
    reclaimedCount,
    remaining,
    notesCustomers: notesRow.customers,
    notesTotal: notesRow.total,
    callsCount: callsRow.n,
    whatsappCount: waRow.n,
    statusBreakdown: statusMap,
    callOutcomeBreakdown: callOutcomeMap,
    reportText,
    waUrl,
    teamLeaderPhone: TEAM_LEADER_PHONE,
    canSend,
  });

  } catch (err) {
    console.error('daily-report error', err);
    return c.json({ error: { message: 'تعذر تحميل التقرير اليومي — برجاء المحاولة مرة أخرى', code: 'DAILY_REPORT_ERROR' } }, 500);
  }
});
