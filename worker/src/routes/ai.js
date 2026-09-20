import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { answerQuestion, generateDailySummary, generateOperationalInsights } from '../lib/ai.js';
import { jsonError, logActivity } from '../lib/db.js';

export const aiRoutes = new Hono();
aiRoutes.use('*', requireAuth, requireRole('team_leader'));

aiRoutes.post('/ask', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  if (!body.question || !String(body.question).trim()) return jsonError(c, 400, 'السؤال مطلوب', 'MISSING_QUESTION');
  const result = await answerQuestion(db, body.question, user);
  await logActivity(db, { actor: user, action: 'AI_QUESTION_ASKED', entityType: 'ai', entityId: null, metadata: { question: body.question } });
  return c.json(result);
});

aiRoutes.get('/daily-summary', async (c) => {
  const summary = await generateDailySummary(c.env.DB);
  return c.json({ summary });
});

aiRoutes.get('/insights', async (c) => {
  const insights = await generateOperationalInsights(c.env.DB);
  return c.json({ insights });
});
