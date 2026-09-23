import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';
import { getEmployeeRewardsSummary, getRewardsSettings } from '../lib/rewards.js';

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
rewardsRoutes.get('/employees/:id', requireRole('team_leader'), async (c) => {
  const id = Number(c.req.param('id'));
  const summary = await getEmployeeRewardsSummary(c.env.DB, id);
  return c.json(summary);
});
