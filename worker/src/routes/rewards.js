import { Hono } from 'hono';
import { requireAuth, requireSalesLead } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';
import { getEmployeeRewardsSummary, getRewardsSettings } from '../lib/rewards.js';
import { getEmployeeMotivationSummary } from '../lib/motivation.js';

export const rewardsRoutes = new Hono();
rewardsRoutes.use('*', requireAuth);

// الموظف يرى محفظته الخاصة فقط.
rewardsRoutes.get('/me', async (c) => {
  const user = c.get('user');
  if (!user.employeeId) return jsonError(c, 400, 'هذا الحساب ليس حساب موظف', 'NOT_AN_EMPLOYEE');
  const summary = await getEmployeeRewardsSummary(c.env.DB, user.employeeId);
  const settings = await getRewardsSettings(c.env.DB);
  return c.json({ ...summary, amountPerSale: settings.amountPerSale });
});

// قائد الفريق (والمالك، بنفس دور team_leader) يرى محفظة أي موظف — للمتابعة
// والشفافية، وليس للتعديل اليدوي (لا يوجد مسار لتعديل الرصيد يدويًا هنا).
rewardsRoutes.get('/employees/:id', requireSalesLead, async (c) => {
  const id = Number(c.req.param('id'));
  const summary = await getEmployeeRewardsSummary(c.env.DB, id);
  return c.json(summary);
});

// نظام التحفيز — ملخص عرض فقط (هدف شهري، شارات، مستوى، تتابع أيام المبيعات).
rewardsRoutes.get('/motivation/me', async (c) => {
  const user = c.get('user');
  if (!user.employeeId) return jsonError(c, 400, 'هذا الحساب ليس حساب موظف', 'NOT_AN_EMPLOYEE');
  const summary = await getEmployeeMotivationSummary(c.env.DB, user.employeeId);
  return c.json(summary);
});

rewardsRoutes.get('/motivation/employees/:id', requireSalesLead, async (c) => {
  const id = Number(c.req.param('id'));
  const summary = await getEmployeeMotivationSummary(c.env.DB, id);
  return c.json(summary);
});
