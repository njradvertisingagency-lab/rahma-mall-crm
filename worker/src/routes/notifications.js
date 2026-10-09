import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';

// خاصية الإشعارات اتلغت بالكامل — الراوتس فاضلة بترجع ردود فاضية من غير أي
// قراءة/كتابة على D1، عشان أي واجهة قديمة مفتوحة ما تكسرش.
export const notificationRoutes = new Hono();
notificationRoutes.use('*', requireAuth);

notificationRoutes.get('/', (c) => c.json({ notifications: [], unreadCount: 0 }));
notificationRoutes.patch('/:id/read', (c) => c.json({ ok: true }));
notificationRoutes.post('/mark-all-read', (c) => c.json({ ok: true }));
