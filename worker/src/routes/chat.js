// دردشة داخلية شخص لشخص — أي حساب نشط (موظف، قائد فريق، HR، أو المالك) يقدر
// يراسل أي حساب نشط تاني مباشرة (dm_messages/dm_reads)، مش مقتصرة على
// "موظف <-> قائد الفريق" زي النظام القديم (chat_messages/chat_reads — باقي
// في قاعدة البيانات بدون حذف، لكن غير مستخدم هنا؛ انظر ملاحظة migration
// 0020_direct_messages.sql). كل محادثة خاصة تمامًا بين طرفيها فقط، ما عدا
// حساب الـ HR والمالك اللي يقدروا يشوفوا كل المحادثات في النظام للإشراف
// (endpoints تحت /oversight/*) — طلب صريح من صاحب الشركة.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';

export const chatRoutes = new Hono();
chatRoutes.use('*', requireAuth);

function isHrOrOwner(user) {
  return !!user.isOwner || (user.role === 'team_leader' && !!user.isHr);
}

const CONTACT_FIELDS = `u.id, u.display_name, u.role, u.is_owner, COALESCE(f.is_hr, 0) AS is_hr, e.name_ar, e.avatar_data_url`;
const CONTACT_JOIN = `FROM users u LEFT JOIN user_role_flags f ON f.user_id = u.id LEFT JOIN employees e ON e.user_id = u.id`;

function toContact(row) {
  return {
    userId: row.id,
    name: row.name_ar || row.display_name,
    role: row.role,
    isOwner: !!row.is_owner,
    isHr: !!row.is_hr,
    avatarUrl: row.avatar_data_url || null,
  };
}

// كل الحسابات النشطة الممكن مراسلتها (الكل ما عدا نفسك) — لبدء محادثة جديدة.
chatRoutes.get('/contacts', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const rows = await db
    .prepare(`SELECT ${CONTACT_FIELDS} ${CONTACT_JOIN} WHERE u.active = 1 AND u.id != ? ORDER BY u.role DESC, u.display_name COLLATE NOCASE`)
    .bind(user.id)
    .all();
  return c.json({ contacts: rows.results.map(toContact) });
});

// محادثات المستخدم الحالي نفسه (اللي هو طرف فيها فعليًا) — آخر رسالة + عدد
// غير المقروء لكل واحدة، الأحدث أولًا.
chatRoutes.get('/threads', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const pairs = await db
    .prepare(
      `SELECT other_id, MAX(created_at) AS last_at FROM (
         SELECT recipient_id AS other_id, created_at FROM dm_messages WHERE sender_id = ?1
         UNION ALL
         SELECT sender_id AS other_id, created_at FROM dm_messages WHERE recipient_id = ?1
       ) GROUP BY other_id ORDER BY last_at DESC`
    )
    .bind(user.id)
    .all();

  const threads = [];
  for (const p of pairs.results) {
    const otherId = p.other_id;
    const other = await db.prepare(`SELECT ${CONTACT_FIELDS} ${CONTACT_JOIN} WHERE u.id = ?`).bind(otherId).first();
    if (!other) continue; // حساب اتمسح/عُطّل — نتخطاه من القائمة، الرسائل نفسها تفضل في قاعدة البيانات
    const last = await db
      .prepare(`SELECT message, sender_id, created_at FROM dm_messages WHERE (sender_id = ?1 AND recipient_id = ?2) OR (sender_id = ?2 AND recipient_id = ?1) ORDER BY created_at DESC LIMIT 1`)
      .bind(user.id, otherId)
      .first();
    const read = await db.prepare(`SELECT last_read_at FROM dm_reads WHERE user_id = ? AND other_user_id = ?`).bind(user.id, otherId).first();
    const unread = await db
      .prepare(`SELECT COUNT(*) AS n FROM dm_messages WHERE sender_id = ? AND recipient_id = ? AND created_at > ?`)
      .bind(otherId, user.id, read?.last_read_at || '1970-01-01T00:00:00.000Z')
      .first();
    threads.push({
      ...toContact(other),
      lastMessage: last?.message || null,
      lastMessageAt: last?.created_at || null,
      lastMine: last ? last.sender_id === user.id : false,
      unreadCount: unread.n,
    });
  }
  return c.json({ threads });
});

// إجمالي غير المقروء عبر كل محادثاته الشخصية — لشارة الجرس/القائمة الجانبية.
chatRoutes.get('/unread-count', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM dm_messages m
         LEFT JOIN dm_reads r ON r.user_id = ?1 AND r.other_user_id = m.sender_id
         WHERE m.recipient_id = ?1 AND m.created_at > COALESCE(r.last_read_at, '1970-01-01T00:00:00.000Z')`
      )
      .bind(user.id)
      .first();
    return c.json({ unread: row.n });
  } catch (err) {
    console.error('chat/unread-count: D1 unavailable', err);
    return jsonError(c, 503, 'تعذر تحميل عداد الرسائل مؤقتًا — برجاء المحاولة خلال دقائق', 'DB_TEMPORARILY_UNAVAILABLE');
  }
});

// إشراف HR/المالك — كل محادثة في النظام (بين أي طرفين)، بدون اشتراط إن
// المشرف نفسه طرف فيها.
chatRoutes.get('/oversight/all-threads', async (c) => {
  const user = c.get('user');
  if (!isHrOrOwner(user)) return jsonError(c, 403, 'هذا الإجراء مخصص لحساب الموارد البشرية', 'FORBIDDEN_HR_ONLY');
  const db = c.env.DB;
  const pairs = await db
    .prepare(
      `SELECT MIN(sender_id, recipient_id) AS user_a, MAX(sender_id, recipient_id) AS user_b, MAX(created_at) AS last_at, COUNT(*) AS total
       FROM dm_messages GROUP BY user_a, user_b ORDER BY last_at DESC`
    )
    .all();

  const threads = [];
  for (const p of pairs.results) {
    const [ua, ub] = await Promise.all([
      db.prepare(`SELECT ${CONTACT_FIELDS} ${CONTACT_JOIN} WHERE u.id = ?`).bind(p.user_a).first(),
      db.prepare(`SELECT ${CONTACT_FIELDS} ${CONTACT_JOIN} WHERE u.id = ?`).bind(p.user_b).first(),
    ]);
    const last = await db
      .prepare(`SELECT message FROM dm_messages WHERE (sender_id=?1 AND recipient_id=?2) OR (sender_id=?2 AND recipient_id=?1) ORDER BY created_at DESC LIMIT 1`)
      .bind(p.user_a, p.user_b)
      .first();
    threads.push({
      userA: ua ? toContact(ua) : { userId: p.user_a, name: `#${p.user_a}` },
      userB: ub ? toContact(ub) : { userId: p.user_b, name: `#${p.user_b}` },
      lastMessage: last?.message || null,
      lastMessageAt: p.last_at,
      totalMessages: p.total,
    });
  }
  return c.json({ threads });
});

// إشراف HR/المالك — محتوى محادثة محددة بين أي طرفين (بدون تعليم كمقروء —
// المشرف مش طرف فيها، والقراءة الفعلية بتاعة صاحبَي المحادثة فقط).
chatRoutes.get('/oversight/:userAId/:userBId/messages', async (c) => {
  const user = c.get('user');
  if (!isHrOrOwner(user)) return jsonError(c, 403, 'هذا الإجراء مخصص لحساب الموارد البشرية', 'FORBIDDEN_HR_ONLY');
  const db = c.env.DB;
  const a = Number(c.req.param('userAId'));
  const b = Number(c.req.param('userBId'));
  const rows = await db
    .prepare(`SELECT * FROM dm_messages WHERE (sender_id=?1 AND recipient_id=?2) OR (sender_id=?2 AND recipient_id=?1) ORDER BY created_at ASC LIMIT 500`)
    .bind(a, b)
    .all();
  return c.json({ messages: rows.results.map((m) => ({ id: m.id, senderId: m.sender_id, message: m.message, createdAt: m.created_at })) });
});

// محادثة المستخدم الحالي مع :otherUserId — فتحها يعلّمها كمقروءة تلقائيًا.
chatRoutes.get('/:otherUserId/messages', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const otherUserId = Number(c.req.param('otherUserId'));
  if (!otherUserId || otherUserId === user.id) return jsonError(c, 400, 'معرف المستخدم غير صالح', 'INVALID_USER');
  const other = await db.prepare(`SELECT id FROM users WHERE id = ? AND active = 1`).bind(otherUserId).first();
  if (!other) return jsonError(c, 404, 'المستخدم غير موجود', 'NOT_FOUND');

  const rows = await db
    .prepare(`SELECT * FROM dm_messages WHERE (sender_id = ?1 AND recipient_id = ?2) OR (sender_id = ?2 AND recipient_id = ?1) ORDER BY created_at ASC LIMIT 500`)
    .bind(user.id, otherUserId)
    .all();

  const now = nowIso();
  await db
    .prepare(`INSERT INTO dm_reads (user_id, other_user_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, other_user_id) DO UPDATE SET last_read_at = excluded.last_read_at`)
    .bind(user.id, otherUserId, now)
    .run();

  return c.json({
    messages: rows.results.map((m) => ({ id: m.id, senderId: m.sender_id, message: m.message, createdAt: m.created_at, mine: m.sender_id === user.id })),
  });
});

chatRoutes.post('/:otherUserId/messages', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const otherUserId = Number(c.req.param('otherUserId'));
  if (!otherUserId || otherUserId === user.id) return jsonError(c, 400, 'معرف المستخدم غير صالح', 'INVALID_USER');
  const other = await db.prepare(`SELECT id FROM users WHERE id = ? AND active = 1`).bind(otherUserId).first();
  if (!other) return jsonError(c, 404, 'المستخدم غير موجود', 'NOT_FOUND');

  const body = await c.req.json().catch(() => ({}));
  const message = String(body.message || '').trim().slice(0, 4000);
  if (!message) return jsonError(c, 400, 'نص الرسالة مطلوب', 'EMPTY_MESSAGE');

  const res = await db
    .prepare(`INSERT INTO dm_messages (sender_id, recipient_id, message) VALUES (?, ?, ?) RETURNING id, created_at`)
    .bind(user.id, otherUserId, message)
    .first();

  // مؤشر قراءة المرسل نفسه بيتقدّم كمان، عشان رسالته هو ما تفضلش ظاهرة له كـ"غير مقروءة".
  await db
    .prepare(`INSERT INTO dm_reads (user_id, other_user_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, other_user_id) DO UPDATE SET last_read_at = excluded.last_read_at`)
    .bind(user.id, otherUserId, res.created_at)
    .run();

  const payload = { senderId: user.id, recipientId: otherUserId, message, senderName: user.displayName, createdAt: res.created_at };
  await broadcast(c.env, 'CHAT_MESSAGE', payload, { scope: 'user', userId: otherUserId });

  // نسخة بث لحسابات الإشراف (HR + المالك) عشان شاشة "كل المحادثات" تتحدّث
  // لحظيًا لو مفتوحة عندهم — بدون تكرار لو المرسل أو المستقبل نفسه من ضمنهم.
  try {
    const overseers = (
      await db
        .prepare(
          `SELECT u.id FROM users u LEFT JOIN user_role_flags f ON f.user_id = u.id
           WHERE u.active = 1 AND (u.is_owner = 1 OR (u.role = 'team_leader' AND f.is_hr = 1))
             AND u.id != ? AND u.id != ?`
        )
        .bind(user.id, otherUserId)
        .all()
    ).results;
    if (overseers.length > 0) {
      await broadcast(c.env, 'CHAT_MESSAGE_OVERSIGHT', payload, { scope: 'users', userIds: overseers.map((o) => o.id) });
    }
  } catch (err) {
    console.error('chat: could not notify HR overseers (best-effort, non-fatal)', err);
  }

  await logActivity(db, { actor: user, action: 'CHAT_MESSAGE_SENT', entityType: 'user', entityId: String(otherUserId) });
  return c.json({ message: { id: res.id, ...payload } }, 201);
});
