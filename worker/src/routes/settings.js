import { Hono } from 'hono';
import { requireAuth, requireSalesLead } from '../lib/auth.js';
import { logActivity, jsonError, nowIso } from '../lib/db.js';

export const settingsRoutes = new Hono();
settingsRoutes.use('*', requireAuth, requireSalesLead);

const KEYS = ['performance_weights', 'distribution_defaults', 'notification_prefs', 'whatsapp_template', 'sla_rules', 'lead_score_weights', 'presence_thresholds', 'sales_settings', 'rewards_settings', 'motivation_settings'];

settingsRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`SELECT * FROM settings WHERE key IN (${KEYS.map(() => '?').join(',')})`).bind(...KEYS).all();
  const out = {};
  for (const row of rows.results) out[row.key] = JSON.parse(row.value);
  return c.json({ settings: out });
});

settingsRoutes.patch('/:key', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const key = c.req.param('key');
  if (!KEYS.includes(key)) return jsonError(c, 400, 'مفتاح إعدادات غير معروف', 'INVALID_KEY');
  const body = await c.req.json().catch(() => ({}));
  await db
    .prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(key, JSON.stringify(body), nowIso(), user.id)
    .run();
  await logActivity(db, { actor: user, action: 'SETTINGS_UPDATED', entityType: 'settings', entityId: key, metadata: body });
  return c.json({ ok: true });
});
