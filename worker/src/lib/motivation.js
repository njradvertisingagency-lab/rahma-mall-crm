// MotivationService — "نظام التحفيز": مكافآت/خصومات وعروض تحفيزية مبنية فوق
// نظام المكافآت الأساسي (lib/rewards.js) بدون أي تعديل في مخطط قاعدة
// البيانات الحية. كل حركة مالية جديدة هنا تُسجَّل في نفس reward_transactions
// (reason='MANUAL_ADJUSTMENT'، والتفاصيل الحقيقية داخل notes) عبر
// applyManualAdjustment من rewards.js — فيبقى الرصيد دائمًا مصدر حقيقة واحد.
// الجدول الوحيد المُضاف (motivation_events) لا يخزّن أي رصيد؛ دوره فقط منع
// صرف نفس المكافأة/الخصم مرتين (idempotency)، بنفس فكرة sweepOpsReports.
import { applyManualAdjustment } from './rewards.js';
import { getCairoNow, getCairoDayBoundsUtc } from './workhours.js';
import { createNotification, broadcast } from './db.js';

const DEFAULT_MOTIVATION_SETTINGS = {
  monthlySalesTarget: 8,
  firstDealOfDay: { enabled: true, amount: 50 },
  lateNotePenalty: { enabled: true, amount: 20, deadlineHours: 24 },
  monthlyTop3: { enabled: true, amounts: [500, 300, 150] },
};

export async function getMotivationSettings(db) {
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key = 'motivation_settings'`).first();
    if (!row) return { ...DEFAULT_MOTIVATION_SETTINGS };
    const parsed = JSON.parse(row.value);
    return {
      ...DEFAULT_MOTIVATION_SETTINGS,
      ...parsed,
      firstDealOfDay: { ...DEFAULT_MOTIVATION_SETTINGS.firstDealOfDay, ...(parsed.firstDealOfDay || {}) },
      lateNotePenalty: { ...DEFAULT_MOTIVATION_SETTINGS.lateNotePenalty, ...(parsed.lateNotePenalty || {}) },
      monthlyTop3: { ...DEFAULT_MOTIVATION_SETTINGS.monthlyTop3, ...(parsed.monthlyTop3 || {}) },
    };
  } catch (err) {
    console.error('getMotivationSettings: falling back to defaults', err);
    return { ...DEFAULT_MOTIVATION_SETTINGS };
  }
}

function getCairoMonthStr() {
  return getCairoNow().dateStr.slice(0, 7); // 'YYYY-MM'
}

function firstAndLastDayOfMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const first = `${monthStr}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${monthStr}-${String(lastDay).padStart(2, '0')}`;
  return { first, last };
}

function getPreviousMonthStr(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** يحاول "حجز" حدث مرة واحدة فقط (bonus_type + ref_key فريدان) — أي محاولة
 * ثانية لنفس المفتاح تُتجاهل بصمت بفضل UNIQUE INDEX. هذا هو الحارس الوحيد
 * ضد صرف نفس المكافأة/الخصم مرتين. */
async function claimEvent(db, { employeeId, bonusType, refKey, amount }) {
  const res = await db
    .prepare(`INSERT OR IGNORE INTO motivation_events (employee_id, bonus_type, ref_key, amount) VALUES (?, ?, ?, ?)`)
    .bind(employeeId, bonusType, refKey, amount)
    .run();
  return { claimed: (res.meta?.changes || 0) > 0, id: res.meta?.last_row_id };
}

async function getEmployeeMonthlySalesCount(db, employeeId, monthStr) {
  const { first, last } = firstAndLastDayOfMonth(monthStr);
  const { dayStartIso } = getCairoDayBoundsUtc(first);
  const { dayEndIso } = getCairoDayBoundsUtc(last);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM purchase_transactions WHERE attributed_employee_id = ? AND status = 'COMPLETED' AND purchase_at >= ? AND purchase_at <= ?`)
    .bind(employeeId, dayStartIso, dayEndIso)
    .first();
  return row.n;
}

// ---------------------------------------------------------------------------
// 1) أول صفقة في اليوم — أول موظف (عبر الفريق كله) يقفل صفقة كل يوم يحصل على
// مكافأة ثابتة. يُستدعى من lib/sales.js فور نجاح الصفقة، بعد creditSaleReward.
// ---------------------------------------------------------------------------
export async function checkFirstDealOfDayBonus(db, env, { employeeId, purchaseId, customerId, createdBy }) {
  if (!employeeId) return null;
  const settings = await getMotivationSettings(db);
  if (!settings.firstDealOfDay?.enabled) return null;
  const amount = Number(settings.firstDealOfDay.amount) || 0;
  if (amount <= 0) return null;

  const dateStr = getCairoNow().dateStr;
  const claim = await claimEvent(db, { employeeId, bonusType: 'FIRST_DEAL_OF_DAY', refKey: dateStr, amount });
  if (!claim.claimed) return null; // موظف آخر سبقه بصفقة اليوم

  return applyManualAdjustment(db, env, {
    employeeId,
    amount,
    purchaseId,
    customerId,
    createdBy,
    title: '🥇 مكافأة أول صفقة في اليوم',
    notes: 'مكافأة أول صفقة في اليوم 🥇',
  });
}

// ---------------------------------------------------------------------------
// 2) الهدف الشهري (٨ صفقات افتراضيًا) — تنبيه تحفيزي عند اقتراب موظف من هدفه
// ("باقي صفقة واحدة!") ورسالة تهنئة تلقائية عند تحقيقه بالكامل. لا تحريك
// مالي هنا أبدًا — تحفيز/تقدير فقط، فلا حاجة لقرار مالي من أستاذ هاني.
// ---------------------------------------------------------------------------
export async function checkMonthlyGoalProgress(db, env, { employeeId }) {
  if (!employeeId) return;
  const settings = await getMotivationSettings(db);
  const target = Number(settings.monthlySalesTarget) || 0;
  if (target <= 0) return;

  const monthStr = getCairoMonthStr();
  const count = await getEmployeeMonthlySalesCount(db, employeeId, monthStr);
  const emp = await db.prepare(`SELECT user_id, name FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp?.user_id) return;

  if (count === target) {
    const claim = await claimEvent(db, { employeeId, bonusType: 'MONTHLY_GOAL_HIT', refKey: `${monthStr}_${employeeId}`, amount: 0 });
    if (claim.claimed) {
      await createNotification(db, {
        userId: emp.user_id,
        type: 'MONTHLY_GOAL_HIT',
        title: '🎯 حققت هدفك الشهري!',
        message: `مبروك ${emp.name}! أنجزت هدفك الشهري (${target} صفقات) — استمر في التميّز 👏`,
        entityType: 'employee',
        entityId: String(employeeId),
      });
      await broadcast(env, 'MOTIVATION_MILESTONE', { employeeId, kind: 'MONTHLY_GOAL_HIT', target }, { scope: 'employee', employeeId });
    }
  } else if (target - count === 1) {
    const claim = await claimEvent(db, { employeeId, bonusType: 'MONTHLY_GOAL_NEAR', refKey: `${monthStr}_${employeeId}`, amount: 0 });
    if (claim.claimed) {
      await createNotification(db, {
        userId: emp.user_id,
        type: 'MONTHLY_GOAL_NEAR',
        title: '🔥 باقي صفقة واحدة!',
        message: `أنت على بُعد صفقة واحدة فقط من تحقيق هدفك الشهري (${target} صفقات) — يلا كمّل! 💪`,
        entityType: 'employee',
        entityId: String(employeeId),
      });
      await broadcast(env, 'MOTIVATION_MILESTONE', { employeeId, kind: 'MONTHLY_GOAL_NEAR', target }, { scope: 'employee', employeeId });
    }
  }
}

// ---------------------------------------------------------------------------
// 3) خصم تأخير كتابة الملاحظة — cron كل ٥ دقائق. عميل تمت رؤيته (customer_seen)
// ولم تُكتب عنه ملاحظة بعد مرور المهلة المحدَّدة (deadlineHours) يُخصم من
// رصيد الموظف المسؤول خصمًا ثابتًا شفافًا، مرة واحدة فقط لكل (عميل + وقت
// رؤية) — ref_key يمنع تكرار الخصم على نفس الحالة عند كل تشغيل للـcron.
// ---------------------------------------------------------------------------
export async function sweepLateNotePenalty(db, env) {
  const settings = await getMotivationSettings(db);
  if (!settings.lateNotePenalty?.enabled) return { penalized: 0 };
  const amount = Number(settings.lateNotePenalty.amount) || 0;
  const deadlineHours = Number(settings.lateNotePenalty.deadlineHours) || 24;
  if (amount <= 0) return { penalized: 0 };

  const rows = await db
    .prepare(
      `SELECT cs.customer_id, cs.employee_id, cs.seen_at
       FROM customer_seen cs
       WHERE cs.employee_id IS NOT NULL
         AND cs.seen_at <= datetime('now', ?)
         AND NOT EXISTS (SELECT 1 FROM customer_notes n WHERE n.customer_id = cs.customer_id AND n.created_at >= cs.seen_at)`
    )
    .bind(`-${deadlineHours} hours`)
    .all();

  let penalized = 0;
  for (const row of rows.results) {
    const refKey = `${row.customer_id}_${row.seen_at}`;
    const claim = await claimEvent(db, { employeeId: row.employee_id, bonusType: 'LATE_NOTE_PENALTY', refKey, amount: -amount });
    if (!claim.claimed) continue;
    await applyManualAdjustment(db, env, {
      employeeId: row.employee_id,
      amount: -amount,
      customerId: row.customer_id,
      title: '⚠️ خصم تأخير كتابة ملاحظة',
      notes: `خصم تأخير كتابة ملاحظة عميل (تجاوز ${deadlineHours} ساعة) ⏰`,
    });
    penalized++;
  }
  return { penalized };
}

// ---------------------------------------------------------------------------
// 4) مكافأة أعلى ٣ موظفين مبيعات كل شهر — cron كل ٥ دقائق، لكنها تعمل فعليًا
// فقط في أول ٥ أيام من الشهر (هامش أمان لضمان انتهاء الشهر السابق فعلًا)،
// وref_key يشمل الشهر+الترتيب فيمنع تكرار الصرف عند كل تشغيل تالٍ للـcron.
// ---------------------------------------------------------------------------
export async function sweepMonthlyTopSales(db, env) {
  const settings = await getMotivationSettings(db);
  if (!settings.monthlyTop3?.enabled) return { awarded: 0 };
  const amounts = Array.isArray(settings.monthlyTop3.amounts) ? settings.monthlyTop3.amounts : [500, 300, 150];

  const { dateStr } = getCairoNow();
  const dayOfMonth = Number(dateStr.slice(8, 10));
  if (dayOfMonth > 5) return { awarded: 0 }; // بعد أول ٥ أيام من الشهر لا داعي لإعادة المحاولة كل مرة

  const currentMonth = dateStr.slice(0, 7);
  const targetMonth = getPreviousMonthStr(currentMonth);
  const { first, last } = firstAndLastDayOfMonth(targetMonth);
  const { dayStartIso } = getCairoDayBoundsUtc(first);
  const { dayEndIso } = getCairoDayBoundsUtc(last);

  const top = await db
    .prepare(
      `SELECT attributed_employee_id AS employeeId, COUNT(*) AS salesCount
       FROM purchase_transactions
       WHERE status = 'COMPLETED' AND attributed_employee_id IS NOT NULL AND purchase_at >= ? AND purchase_at <= ?
       GROUP BY attributed_employee_id
       HAVING salesCount > 0
       ORDER BY salesCount DESC
       LIMIT 3`
    )
    .bind(dayStartIso, dayEndIso)
    .all();

  let awarded = 0;
  const medals = ['🥇 الأول', '🥈 الثاني', '🥉 الثالث'];
  for (let i = 0; i < top.results.length; i++) {
    const row = top.results[i];
    const amount = Number(amounts[i]) || 0;
    if (amount <= 0) continue;
    const refKey = `${targetMonth}_RANK${i + 1}`;
    const claim = await claimEvent(db, { employeeId: row.employeeId, bonusType: 'MONTHLY_TOP_SALES', refKey, amount });
    if (!claim.claimed) continue;
    await applyManualAdjustment(db, env, {
      employeeId: row.employeeId,
      amount,
      title: `🏆 مكافأة ${medals[i]} في المبيعات الشهرية`,
      notes: `مكافأة الترتيب ${medals[i]} في مبيعات شهر ${targetMonth} (${row.salesCount} صفقة) 🏆`,
    });
    awarded++;
  }
  return { awarded };
}

// ---------------------------------------------------------------------------
// 5) ملخص التحفيز لبروفايل الموظف — عرض فقط، بلا أي حركة مالية: تقدّم الهدف
// الشهري، إجمالي الأرباح منذ أول يوم عمل (Career total)، شارات الإنجاز
// القابلة للتجميع، نظام المستويات (مبتدئ/محترف/خبير)، وعداد التتابع اليومي
// للمبيعات (Sales Streak).
// ---------------------------------------------------------------------------
export async function getEmployeeMotivationSummary(db, employeeId) {
  const settings = await getMotivationSettings(db);
  const target = Number(settings.monthlySalesTarget) || 0;
  const monthStr = getCairoMonthStr();
  const monthlySalesCount = await getEmployeeMonthlySalesCount(db, employeeId, monthStr);

  const careerRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM purchase_transactions WHERE attributed_employee_id = ? AND status = 'COMPLETED'`)
    .bind(employeeId)
    .first();
  const careerTotalSales = careerRow.n;

  const earnedRow = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM reward_transactions WHERE employee_id = ? AND amount > 0`)
    .bind(employeeId)
    .first();
  const careerTotalEarned = Math.round((earnedRow.total || 0) * 100) / 100;

  const MILESTONES = [1, 10, 50, 100];
  const milestoneBadges = MILESTONES.filter((m) => careerTotalSales >= m).map((m) => (m === 1 ? '🎖️ أول صفقة' : `🎖️ ${m} صفقة`));

  let levelTier = 'مبتدئ 🌱';
  if (careerTotalSales >= 50) levelTier = 'خبير 🏆';
  else if (careerTotalSales >= 10) levelTier = 'محترف ⭐';

  const currentStreak = await getSalesStreak(db, employeeId);

  return {
    monthlyTarget: target,
    monthlySalesCount,
    monthlyProgressPercent: target > 0 ? Math.min(100, Math.round((monthlySalesCount / target) * 100)) : 0,
    remainingToTarget: Math.max(0, target - monthlySalesCount),
    careerTotalSales,
    careerTotalEarned,
    milestoneBadges,
    levelTier,
    currentStreak,
  };
}

// تقريبي بحساب التاريخ من purchase_at كما هو مخزَّن (UTC) بدل تحويل كل صف
// لتوقيت القاهرة — فارق ساعتين/ثلاث لا يغيّر نتيجة "تتابع أيام" عمليًا،
// ويوفّر استعلامًا واحدًا بسيطًا بدل حساب مرهق لكل صفقة.
async function getSalesStreak(db, employeeId) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT substr(purchase_at, 1, 10) AS d
       FROM purchase_transactions
       WHERE attributed_employee_id = ? AND status IN ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
       ORDER BY d DESC LIMIT 90`
    )
    .bind(employeeId)
    .all();
  const dates = new Set(rows.results.map((r) => r.d));
  const todayStr = new Date().toISOString().slice(0, 10);
  let cursor = new Date(`${todayStr}T00:00:00Z`);
  if (!dates.has(todayStr)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!dates.has(cursor.toISOString().slice(0, 10))) return 0;
  }
  let streak = 0;
  while (dates.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}
