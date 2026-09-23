// RewardsService — محفظة مكافآت المبيعات لكل موظف. سجل حركات append-only
// (reward_transactions)؛ الرصيد دائمًا SUM(amount) — لا يوجد عمود رصيد
// مُخزَّن يمكن أن ينحرف عن الحقيقة. مرتبطة بنظام "تمت الصفقة" الموجود
// (lib/sales.js): كل صفقة مكتملة منسوبة لموظف تمنحه مكافأة ثابتة (مُعدّة من
// الإعدادات)، وأي إبطال/استرجاع كامل/إعادة نسب يعكسها بحركة جديدة معاكسة
// بدل حذف أو تعديل الحركة الأصلية، فيبقى تاريخ المكافآت قابلًا للتدقيق دائمًا.
import { nowIso, broadcast, createNotification, logActivity } from './db.js';

export async function getRewardsSettings(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'rewards_settings'`).first();
  const defaults = { amountPerSale: 200 };
  if (!row) return defaults;
  try {
    return { ...defaults, ...JSON.parse(row.value) };
  } catch {
    return defaults;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function insertTransaction(db, { employeeId, purchaseId, customerId, amount, reason, notes, createdBy }) {
  const row = await db
    .prepare(
      `INSERT INTO reward_transactions (employee_id, purchase_id, customer_id, amount, reason, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`
    )
    .bind(employeeId, purchaseId ?? null, customerId ?? null, round2(amount), reason, notes || null, createdBy ?? null)
    .first();
  return row;
}

async function getEmployeeBalance(db, employeeId) {
  const row = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS balance FROM reward_transactions WHERE employee_id = ?`).bind(employeeId).first();
  return round2(row.balance || 0);
}

/** يُستدعى عند تسجيل صفقة جديدة منسوبة لموظف (Deal Done). */
export async function creditSaleReward(db, env, { employeeId, purchaseId, customerId, createdBy }) {
  if (!employeeId) return null;
  const settings = await getRewardsSettings(db);
  const amount = Number(settings.amountPerSale) || 0;
  if (amount <= 0) return null;

  await insertTransaction(db, { employeeId, purchaseId, customerId, amount, reason: 'SALE_BONUS', createdBy });
  const balance = await getEmployeeBalance(db, employeeId);

  const emp = await db.prepare(`SELECT user_id, name FROM employees WHERE id = ?`).bind(employeeId).first();
  if (emp?.user_id) {
    await createNotification(db, {
      userId: emp.user_id,
      type: 'REWARD_EARNED',
      title: '🎉 مكافأة صفقة جديدة',
      message: `مبروك! حصلت على مكافأة ${amount} ج.م لتسجيل صفقة جديدة. رصيدك الآن ${balance} ج.م.`,
      entityType: 'customer',
      entityId: customerId || null,
    });
    await broadcast(env, 'REWARD_EARNED', { amount, balance, purchaseId, customerId }, { scope: 'employee', employeeId });
  }
  await logActivity(db, { actor: { id: createdBy }, action: 'REWARD_EARNED', entityType: 'employee', entityId: String(employeeId), metadata: { amount, purchaseId, customerId } });
  await broadcast(env, 'REWARDS_UPDATED', { employeeId }, { scope: 'role', role: 'team_leader' });
  return { amount, balance };
}

/** يعكس مكافأة مرتبطة بصفقة (إبطال أو استرجاع كامل) — لا يحذف الحركة الأصلية أبدًا. */
export async function reverseSaleReward(db, env, purchaseId, { reason, changedBy }) {
  const original = await db
    .prepare(`SELECT * FROM reward_transactions WHERE purchase_id = ? AND reason = 'SALE_BONUS' ORDER BY created_at DESC LIMIT 1`)
    .bind(purchaseId)
    .first();
  if (!original) return null; // الصفقة لم تكن منسوبة لموظف أصلًا، أو المبلغ كان صفرًا

  // لو سبق عكسها بالفعل (مثلًا إبطال بعد استرجاع كامل) لا نكرر الخصم.
  const alreadyReversed = await db
    .prepare(`SELECT id FROM reward_transactions WHERE purchase_id = ? AND amount < 0`)
    .bind(purchaseId)
    .first();
  if (alreadyReversed) return null;

  await insertTransaction(db, {
    employeeId: original.employee_id,
    purchaseId,
    customerId: original.customer_id,
    amount: -Math.abs(original.amount),
    reason,
    createdBy: changedBy,
  });
  const balance = await getEmployeeBalance(db, original.employee_id);
  const emp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(original.employee_id).first();
  if (emp?.user_id) {
    await broadcast(env, 'REWARD_REVERSED', { amount: original.amount, balance, purchaseId }, { scope: 'employee', employeeId: original.employee_id });
  }
  await logActivity(db, { actor: { id: changedBy }, action: 'REWARD_REVERSED', entityType: 'employee', entityId: String(original.employee_id), metadata: { purchaseId, amount: original.amount, reason } });
  await broadcast(env, 'REWARDS_UPDATED', { employeeId: original.employee_id }, { scope: 'role', role: 'team_leader' });
  return { amount: -Math.abs(original.amount), balance };
}

/** إعادة نسب صفقة لموظف آخر — تنقل المكافأة: تعكسها عن القديم وتمنحها للجديد
 * (فقط إذا كانت الصفقة لا تزال مكتملة/غير مبطلة). */
export async function moveSaleReward(db, env, purchaseId, { previousEmployeeId, newEmployeeId, purchaseStatus, customerId, changedBy }) {
  if (previousEmployeeId === newEmployeeId) return;

  if (previousEmployeeId) {
    const original = await db
      .prepare(`SELECT * FROM reward_transactions WHERE purchase_id = ? AND reason = 'SALE_BONUS' ORDER BY created_at DESC LIMIT 1`)
      .bind(purchaseId)
      .first();
    if (original) {
      const alreadyReversed = await db.prepare(`SELECT id FROM reward_transactions WHERE purchase_id = ? AND amount < 0`).bind(purchaseId).first();
      if (!alreadyReversed) {
        await insertTransaction(db, { employeeId: previousEmployeeId, purchaseId, customerId, amount: -Math.abs(original.amount), reason: 'ATTRIBUTION_MOVED_OUT', createdBy: changedBy });
        const balance = await getEmployeeBalance(db, previousEmployeeId);
        const empOld = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(previousEmployeeId).first();
        if (empOld?.user_id) await broadcast(env, 'REWARD_REVERSED', { amount: original.amount, balance, purchaseId }, { scope: 'employee', employeeId: previousEmployeeId });
      }
    }
  }

  if (newEmployeeId && purchaseStatus === 'COMPLETED') {
    const settings = await getRewardsSettings(db);
    const amount = Number(settings.amountPerSale) || 0;
    if (amount > 0) {
      await insertTransaction(db, { employeeId: newEmployeeId, purchaseId, customerId, amount, reason: 'ATTRIBUTION_MOVED_IN', createdBy: changedBy });
      const balance = await getEmployeeBalance(db, newEmployeeId);
      const empNew = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(newEmployeeId).first();
      if (empNew?.user_id) {
        await createNotification(db, {
          userId: empNew.user_id,
          type: 'REWARD_EARNED',
          title: '🎉 مكافأة صفقة منسوبة إليك',
          message: `تم نسب صفقة إليك — حصلت على مكافأة ${amount} ج.م. رصيدك الآن ${balance} ج.م.`,
          entityType: 'customer',
          entityId: customerId || null,
        });
        await broadcast(env, 'REWARD_EARNED', { amount, balance, purchaseId, customerId }, { scope: 'employee', employeeId: newEmployeeId });
      }
    }
  }
  await logActivity(db, { actor: { id: changedBy }, action: 'REWARD_MOVED', entityType: 'purchase', entityId: String(purchaseId), metadata: { previousEmployeeId, newEmployeeId } });
  await broadcast(env, 'REWARDS_UPDATED', {}, { scope: 'role', role: 'team_leader' });
}

/** ملخص محفظة موظف: الرصيد الحالي، عدد الصفقات المكافأة، وآخر الحركات بالتفصيل. */
export async function getEmployeeRewardsSummary(db, employeeId, { limit = 50 } = {}) {
  const balance = await getEmployeeBalance(db, employeeId);
  const salesCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM reward_transactions WHERE employee_id = ? AND reason = 'SALE_BONUS'`)
    .bind(employeeId)
    .first();
  const rows = await db
    .prepare(
      `SELECT rt.*, c.name AS customer_name, p.total_amount AS purchase_amount, p.purchase_at
       FROM reward_transactions rt
       LEFT JOIN customers c ON c.id = rt.customer_id
       LEFT JOIN purchase_transactions p ON p.id = rt.purchase_id
       WHERE rt.employee_id = ?
       ORDER BY rt.created_at DESC
       LIMIT ?`
    )
    .bind(employeeId, limit)
    .all();
  return { balance, salesCount: salesCount.n, transactions: rows.results };
}

/**
 * تعديل يدوي عام على رصيد موظف — تستخدمه lib/motivation.js لكل أنواع
 * المكافآت/الخصومات الجديدة (أول صفقة في اليوم، خصم تأخير ملاحظة، أعلى ٣
 * مبيعات شهريًا...) بدل توسيع CHECK constraint الخاص بعمود reason، فيبقى
 * نطاقه المسموح كما هو (MANUAL_ADJUSTMENT) وتفاصيل النوع نفسه تُكتب في notes
 * ليقرأها الموظف وقائد الفريق بوضوح في سجل المكافآت.
 */
export async function applyManualAdjustment(db, env, { employeeId, amount, notes, createdBy, purchaseId, customerId, title }) {
  if (!employeeId || !amount) return null;
  await insertTransaction(db, { employeeId, purchaseId, customerId, amount, reason: 'MANUAL_ADJUSTMENT', notes, createdBy });
  const balance = await getEmployeeBalance(db, employeeId);
  const emp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (emp?.user_id) {
    const positive = amount >= 0;
    await createNotification(db, {
      userId: emp.user_id,
      type: positive ? 'REWARD_EARNED' : 'REWARD_REVERSED',
      title: title || (positive ? '🎉 مكافأة جديدة' : '⚠️ خصم من رصيد المكافآت'),
      message: `${notes || ''} — ${positive ? 'أُضيف' : 'خُصم'} ${Math.abs(amount)} ج.م. رصيدك الآن ${balance} ج.م.`,
      entityType: customerId ? 'customer' : 'employee',
      entityId: customerId || String(employeeId),
    });
    await broadcast(env, positive ? 'REWARD_EARNED' : 'REWARD_REVERSED', { amount, balance, notes }, { scope: 'employee', employeeId });
  }
  await logActivity(db, { actor: { id: createdBy }, action: amount >= 0 ? 'REWARD_EARNED' : 'REWARD_REVERSED', entityType: 'employee', entityId: String(employeeId), metadata: { amount, notes } });
  await broadcast(env, 'REWARDS_UPDATED', { employeeId }, { scope: 'role', role: 'team_leader' });
  return { amount, balance };
}

const REASON_LABELS_AR = {
  SALE_BONUS: 'مكافأة صفقة',
  SALE_CANCELLED: 'عكس مكافأة — إبطال صفقة',
  SALE_REFUNDED: 'عكس مكافأة — استرجاع كامل',
  ATTRIBUTION_MOVED_OUT: 'نُقلت الصفقة لموظف آخر',
  ATTRIBUTION_MOVED_IN: 'صفقة مُعاد نسبها إليك',
  MANUAL_ADJUSTMENT: 'تعديل يدوي',
};
export { REASON_LABELS_AR };
