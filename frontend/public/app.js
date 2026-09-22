// رحمة مول — نظام إدارة فريق المبيعات المباشر. واجهة الموقع (بدون خطوة بناء).
'use strict';

const App = (window.App = {
  state: {
    user: null,
    theme: localStorage.getItem('rm_theme') || 'light',
    wsStatus: 'OFFLINE', // LIVE | RECONNECTING | OFFLINE
    soundEnabled: localStorage.getItem('rm_sound_enabled') !== 'false',
    notifications: [],
    unreadCount: 0,
    chatUnread: 0,
    employees: [],
    settings: {},
  },
  views: {},
  listeners: {},
});

// ---------------------------------------------------------------------------
// ناقل أحداث بسيط حتى تتفاعل الصفحات مع أحداث الاتصال المباشر بدون استعلام متكرر.
// ---------------------------------------------------------------------------
App.on = (evt, fn) => {
  (App.listeners[evt] = App.listeners[evt] || []).push(fn);
  return () => {
    App.listeners[evt] = App.listeners[evt].filter((f) => f !== fn);
  };
};
App.emit = (evt, payload) => {
  (App.listeners[evt] || []).forEach((fn) => {
    try {
      fn(payload);
    } catch (e) {
      console.error(e);
    }
  });
  (App.listeners['*'] || []).forEach((fn) => fn(evt, payload));
};

// ---------------------------------------------------------------------------
// أدوات مساعدة لبناء عناصر الصفحة
// ---------------------------------------------------------------------------
function el(tag, props, children) {
  const node = document.createElement(tag);
  props = props || {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  (children || []).flat().forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(c) : c);
  });
  return node;
}
App.el = el;

// نستخدم أرقامًا لاتينية (numberingSystem: latn) مع أسماء الأشهر بالعربي —
// هذا هو المتعارف عليه في البرامج التجارية المصرية.
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ar-EG-u-nu-latn', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ar-EG-u-nu-latn', { day: '2-digit', month: 'short', year: 'numeric' });
}
function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'الآن';
  if (s < 3600) return 'منذ ' + Math.floor(s / 60) + ' د';
  if (s < 86400) return 'منذ ' + Math.floor(s / 3600) + ' س';
  return 'منذ ' + Math.floor(s / 86400) + ' يوم';
}
/** ٤٥ د / ٣س ١٢د / ٢ يوم ٥س — لعرض مدد زمنية (وقت أونلاين، مدة جلسة) بشكل مقروء. */
function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (s < 60) return 'أقل من دقيقة';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} يوم${hours ? ' ' + hours + 'س' : ''}`;
  if (hours > 0) return `${hours}س${mins ? ' ' + mins + 'د' : ''}`;
  return `${mins}د`;
}
App.fmt = { dateTime: fmtDateTime, date: fmtDate, ago: timeAgo, duration: fmtDuration };

const STATUS_LABELS = {
  NEW: 'جديد', CALLING: 'جاري الاتصال', NO_ANSWER: 'لا يوجد رد', BUSY: 'مشغول',
  FOLLOW_UP: 'متابعة', INTERESTED: 'مهتم', NOT_INTERESTED: 'غير مهتم', CLOSED: 'مغلق',
};
function statusBadge(status) {
  return el('span', { class: 'badge badge-' + status.toLowerCase() }, [STATUS_LABELS[status] || status]);
}
const PRIORITY_LABELS = { LOW: 'منخفضة', NORMAL: 'عادية', HIGH: 'عالية', URGENT: 'عاجلة' };
function priorityBadge(p) {
  return el('span', { class: 'badge badge-priority-' + p.toLowerCase() }, [PRIORITY_LABELS[p] || p]);
}
function waBadge(status) {
  const labels = { NOT_CONTACTED: 'لم يتم التواصل', CONTACT_INITIATED: 'تم التواصل واتساب', SENT: 'تم الإرسال', DELIVERED: 'تم التسليم', READ: 'تمت القراءة', FAILED: 'فشل الإرسال' };
  return el('span', { class: 'badge badge-wa-' + status.toLowerCase() }, [labels[status] || status]);
}
function availabilityBadge(a) {
  const cls = { AVAILABLE: 'available', BUSY: 'busy-emp', ON_BREAK: 'on_break', UNAVAILABLE: 'unavailable' }[a] || 'unavailable';
  const labels = { AVAILABLE: 'متاح', BUSY: 'مشغول', ON_BREAK: 'في استراحة', UNAVAILABLE: 'غير متاح' };
  return el('span', { class: 'badge badge-' + cls }, [labels[a] || a]);
}
// حالة الاتصال الفعلية — مختلفة عن حقل "الإتاحة" اليدوي أعلاه.
function presenceBadge(presence) {
  presence = presence || { online: false, activityState: 'OFFLINE' };
  const state = presence.online ? presence.activityState : 'OFFLINE';
  const cls = { ACTIVE: 'available', IDLE: 'on_break', OFFLINE: 'unavailable' }[state] || 'unavailable';
  const dot = { ACTIVE: '🟢', IDLE: '🟡', OFFLINE: '⚪' }[state] || '⚪';
  const labels = { ACTIVE: 'نشط الآن', IDLE: 'خامل', OFFLINE: 'غير متصل' };
  return el('span', { class: 'badge badge-' + cls }, [dot + ' ' + (labels[state] || state)]);
}
function slaBadge(level) {
  if (!level || level === 'OK') return el('span', { class: 'badge', style: 'background:var(--surface-2);color:var(--muted)' }, ['ضمن الموعد']);
  if (level === 'WARNING') return el('span', { class: 'badge', style: 'background:#fbe4da;color:#b34d1f' }, ['⚠ اقترب الموعد']);
  return el('span', { class: 'badge', style: 'background:#fee2e2;color:var(--danger)' }, ['🔴 تم تجاوز الموعد']);
}
function dealStatusBadge(status) {
  const map = {
    NO_PURCHASE: ['—', 'background:var(--surface-2);color:var(--muted)'],
    BRANCH_VISIT: ['🏪 زيارة فرع', 'background:var(--brand-soft);color:var(--brand)'],
    COMPLETED: ['✓ تمت الصفقة', 'background:#dff4ec;color:var(--success)'],
    CANCELLED: ['✕ ملغاة', 'background:var(--surface-2);color:var(--muted)'],
    REFUNDED: ['↩ مسترجعة', 'background:#fee2e2;color:var(--danger)'],
    PARTIALLY_REFUNDED: ['↩ استرجاع جزئي', 'background:#fbe4da;color:#b34d1f'],
  };
  const [label, style] = map[status] || [status, ''];
  return el('span', { class: 'badge', style }, [label]);
}
App.badges = { status: statusBadge, priority: priorityBadge, whatsapp: waBadge, availability: availabilityBadge, presence: presenceBadge, sla: slaBadge, dealStatus: dealStatusBadge };

// تسميات عربية لكل أنواع أحداث سجل الأنشطة (activity_logs.action) — مشتركة بين
// صفحة "سجل الأنشطة" الخاصة بقائد الفريق وصفحة "أدائي" الخاصة بكل موظف، حتى
// لا يظهر نفس الحدث بصياغتين مختلفتين في مكانين.
const ACTIVITY_ACTION_LABELS = {
  LOGIN: 'تسجيل دخول', LOGIN_FAILED: 'محاولة دخول فاشلة', LOGOUT: 'تسجيل خروج', PASSWORD_CHANGED: 'تغيير كلمة المرور',
  CUSTOMER_CREATED: 'إنشاء عميل', CUSTOMER_REASSIGNED: 'إعادة تعيين عميل', CUSTOMER_REOPENED: 'إعادة فتح عميل',
  CUSTOMER_ARCHIVED: 'أرشفة عميل', CUSTOMER_RESTORED: 'استعادة عميل', CUSTOMERS_IMPORTED: 'استيراد عملاء',
  STATUS_CHANGED: 'تغيير الحالة', PRIORITY_CHANGED: 'تغيير الأولوية', ATTRIBUTION_CHANGED: 'تغيير مصدر العميل',
  NOTE_ADDED: 'إضافة ملاحظة', PRODUCT_INTEREST_ADDED: 'إضافة منتج مهتم به', CALL_ATTEMPT_CREATED: 'تسجيل محاولة اتصال',
  CALL_INITIATED: 'بدء اتصال', WHATSAPP_CONTACT_INITIATED: 'تواصل عبر واتساب', FOLLOWUP_CREATED: 'إنشاء متابعة',
  FOLLOWUP_UPDATED: 'تعديل متابعة', FOLLOWUP_COMPLETED: 'إنجاز متابعة', FOLLOWUP_CANCELLED: 'إلغاء متابعة',
  DISTRIBUTION_CREATED: 'توزيع عملاء', EMPLOYEE_STATUS_CHANGED: 'تغيير حالة موظف', DAILY_GOAL_SET: 'تحديد هدف يومي',
  EMPLOYEE_AVATAR_UPDATED: 'تحديث الصورة الشخصية', EMPLOYEE_AVATAR_REMOVED: 'حذف الصورة الشخصية',
  EMPLOYEE_CREATED: 'إضافة موظف جديد', EMPLOYEE_USERNAME_CHANGED: 'تغيير اسم المستخدم', EMPLOYEE_NAME_CHANGED: 'تغيير اسم الموظف', EMPLOYEE_PASSWORD_RESET: 'إعادة تعيين كلمة المرور',
  BRANCH_CREATED: 'إنشاء فرع', BRANCH_VISIT_CREATED: 'تسجيل زيارة فرع', DEAL_DONE_CREATED: 'تسجيل صفقة',
  PURCHASE_UPDATED: 'تعديل عملية شراء', PURCHASE_CANCELLED: 'إلغاء عملية شراء', REFUND_CREATED: 'تسجيل استرجاع',
  SETTINGS_UPDATED: 'تحديث الإعدادات', AI_QUESTION_ASKED: 'سؤال للمساعد الذكي',
  BULK_STATUS: 'تعديل جماعي للحالة', BULK_PRIORITY: 'تعديل جماعي للأولوية', BULK_ARCHIVE: 'أرشفة جماعية',
  COMPLAINT_LOGGED: 'تسجيل شكوى', COMPLAINT_DELETED: 'حذف شكوى', CHAT_MESSAGE_SENT: 'إرسال رسالة دردشة',
  EMPLOYEE_DND_STARTED: 'تفعيل عدم الإزعاج المؤقت', EMPLOYEE_DND_CANCELLED: 'إلغاء عدم الإزعاج',
  CUSTOMER_MARKED_VIP: 'تمييز عميل كـ VIP', CUSTOMER_UNMARKED_VIP: 'إلغاء تمييز VIP',
};
const ACTIVITY_ROLE_LABELS = { team_leader: 'قائد الفريق', employee: 'موظف' };
App.labels = { status: STATUS_LABELS, priority: PRIORITY_LABELS, activity: ACTIVITY_ACTION_LABELS, role: ACTIVITY_ROLE_LABELS };

// ---------------------------------------------------------------------------
// صورة العضو الشخصية — تعرض الصورة إن وُجدت، وإلا ترجع لحرف الاسم كما كان سابقًا.
// ---------------------------------------------------------------------------
function avatarNode({ url, name, sizeClass }) {
  const cls = 'avatar' + (sizeClass ? ' ' + sizeClass : '');
  if (url) return el('img', { src: url, class: cls, style: 'object-fit:cover', alt: name || '' });
  return el('div', { class: cls }, [(name || '?')[0].toUpperCase()]);
}
App.avatar = avatarNode;

// يفتح منتقي ملفات، يقتصّ الصورة مربعة من المنتصف، ويصغّرها إلى JPEG صغير الحجم
// قبل الرفع — بدون أي تخزين خارجي، فقط نص data: URL يُحفظ في قاعدة البيانات.
App.pickAvatarImage = function (maxSize = 256, quality = 0.82) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const size = Math.min(img.width, img.height);
          const sx = (img.width - size) / 2;
          const sy = (img.height - size) / 2;
          const canvas = document.createElement('canvas');
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, sx, sy, size, size, 0, 0, maxSize, maxSize);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(null);
        img.src = reader.result;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
};

// ---------------------------------------------------------------------------
// الاتصال بالـ API
// ---------------------------------------------------------------------------
// الموقع منشور على ووركر واحد يقدّم الواجهة والـ API معًا من نفس النطاق، لكن
// نُبقي هذا الاحتياط لأي نشر منفصل مستقبلًا (مثلاً استضافة الواجهة على نطاق آخر).
const PROD_API_ORIGIN = 'https://rahma-mall-crm.njradvertisingagency.workers.dev';
const PROD_WS_ORIGIN = 'wss://rahma-mall-crm.njradvertisingagency.workers.dev';
const API_BASE = location.hostname.endsWith('.pages.dev') ? PROD_API_ORIGIN : '';

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'x-rahma-client': 'web' }, opts.headers || {});
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + '/api' + path, { method: opts.method || 'GET', headers, body, credentials: 'include' });
  if (res.status === 401) {
    App.state.user = null;
    if (location.hash !== '#/login') location.hash = '#/login';
    throw new Error('يجب تسجيل الدخول');
  }
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || 'فشل الطلب';
    throw new Error(message);
  }
  return data;
}
App.api = api;
App.apiBase = API_BASE; // مُستخدم لبناء روابط مباشرة (مثل تصدير CSV) تعمل حتى لو اختلف النطاق

// تنزيل ملف (مثل تصدير CSV) عبر fetch حتى تُرسَل ترويسة x-rahma-client المطلوبة؛
// روابط <a href> العادية لا يمكنها إرفاق ترويسات مخصّصة فتُرفض من الخادم.
App.downloadFile = async function (path, fallbackFilename) {
  const headers = { 'x-rahma-client': 'web' };
  const res = await fetch(API_BASE + '/api' + path, { headers, credentials: 'include' });
  if (!res.ok) {
    let message = 'فشل تنزيل الملف';
    try {
      const data = await res.json();
      message = (data && data.error && data.error.message) || message;
    } catch {}
    throw new Error(message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = (match && match[1]) || fallbackFilename || 'export.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

// ---------------------------------------------------------------------------
// الإشعارات المنبثقة (Toasts)
// ---------------------------------------------------------------------------
function toast(message, type) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = el('div', { class: 'toast-stack' });
    document.body.appendChild(stack);
  }
  const node = el('div', { class: 'toast ' + (type || 'info') }, [message]);
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4500);
}
App.toast = toast;

// ---------------------------------------------------------------------------
// صوت التنبيهات — نغمة قصيرة تُولَّد برمجيًا (بدون ملف صوتي خارجي) لتنبيه
// الموظف حتى لو كانت التبويبة في الخلفية. تُشغَّل فقط مع تنبيهات فورية حقيقية
// (وليس مع كل رسالة تأكيد عادية)، ويمكن كتمها من الجرس بجوار الإشعارات.
// ---------------------------------------------------------------------------
let audioCtx = null;
function playNotificationSound() {
  if (!App.state.soundEnabled) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1175, now + 0.11);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.4);
  } catch (e) { /* الصوت غير أساسي — تجاهل أي فشل (مثل منع المتصفح للتشغيل التلقائي) */ }
}
App.playNotificationSound = playNotificationSound;
App.toggleSound = () => {
  App.state.soundEnabled = !App.state.soundEnabled;
  localStorage.setItem('rm_sound_enabled', String(App.state.soundEnabled));
  App.emit('sound-toggled');
  if (App.state.soundEnabled) playNotificationSound();
};

/** إشعار فوري حقيقي: رسالة منبثقة + نغمة تنبيه معًا. */
function pushAlert(message, type) {
  toast(message, type);
  playNotificationSound();
}

// ---------------------------------------------------------------------------
// المظهر (فاتح / داكن)
// ---------------------------------------------------------------------------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', App.state.theme);
}
App.toggleTheme = () => {
  App.state.theme = App.state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('rm_theme', App.state.theme);
  applyTheme();
};
applyTheme();

// ---------------------------------------------------------------------------
// اتصال WebSocket المباشر
// ---------------------------------------------------------------------------
const RT = {
  ws: null,
  backoff: 1000,
  intentionalClose: false,
  connect() {
    if (!App.state.user) return;
    RT.intentionalClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsBase = location.hostname.endsWith('.pages.dev') ? PROD_WS_ORIGIN : `${proto}://${location.host}`;
    App.state.wsStatus = 'RECONNECTING';
    App.emit('ws-status', App.state.wsStatus);
    const ws = new WebSocket(`${wsBase}/ws`);
    RT.ws = ws;
    ws.onopen = () => {
      App.state.wsStatus = 'LIVE';
      RT.backoff = 1000;
      App.emit('ws-status', App.state.wsStatus);
      App.emit('ws-reconnected'); // الصفحات تُحدّث بياناتها عند إعادة الاتصال
    };
    ws.onclose = () => {
      if (RT.intentionalClose) {
        App.state.wsStatus = 'OFFLINE';
        App.emit('ws-status', App.state.wsStatus);
        return;
      }
      App.state.wsStatus = 'RECONNECTING';
      App.emit('ws-status', App.state.wsStatus);
      setTimeout(RT.connect, RT.backoff);
      RT.backoff = Math.min(RT.backoff * 1.7, 15000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (data.type === 'pong') return;
      App.emit('rt:' + data.type, data.payload);
      App.emit('rt:*', data);
    };
  },
  disconnect() {
    RT.intentionalClose = true;
    if (RT.ws) RT.ws.close();
  },
};
App.rt = RT;

// الإشعارات المباشرة: أي حدث تعيين/حالة جديد يُحدّث الجرس فورًا.
App.on('rt:NOTIFICATION_CREATED', () => { pushAlert('🔔 لديك إشعار جديد', 'info'); refreshNotifications(); });
App.on('rt:CUSTOMER_ASSIGNED', () => refreshNotifications());
App.on('rt:FOLLOWUP_OVERDUE', () => refreshNotifications());
App.on('rt:CUSTOMER_REASSIGNED', () => refreshNotifications());
// تنبيهات فورية (Push) لتجاوز مواعيد الخدمة — بدل الاكتفاء بتحديث الجرس بصمت،
// تظهر رسالة منبثقة فورية مع نغمة تنبيه لحظة تجاوز العميل للموعد المسموح.
App.on('rt:SLA_BREACHED', (p) => { pushAlert(`🔴 تجاوز موعد خدمة — العميل ${p?.customerId || ''}`, 'error'); refreshNotifications(); });
App.on('rt:SLA_WARNING', (p) => { pushAlert(`🟠 اقترب موعد خدمة — العميل ${p?.customerId || ''}`, 'info'); refreshNotifications(); });
// "عميل بينتظرك" — تنبيه للموظف نفسه (وليس فقط قائد الفريق) عند مرور وقت طويل بدون أي تحديث على عميله.
App.on('rt:CUSTOMER_WAITING', (p) => { pushAlert(`⏳ عميل بينتظرك — ${p?.customerId || ''}`, 'error'); refreshNotifications(); });
App.on('rt:CUSTOMER_WAITING_WARNING', (p) => { pushAlert(`🟡 عميل يحتاج متابعة قريبًا — ${p?.customerId || ''}`, 'info'); refreshNotifications(); });
// الدردشة الداخلية — رسالة جديدة تُحدّث شارة العداد فورًا وتُظهر تنبيهًا صوتيًا.
App.on('rt:CHAT_MESSAGE', (p) => {
  refreshChatUnread();
  const onChatPage = (location.hash || '').startsWith('#/chat');
  if (!onChatPage) pushAlert(`💬 رسالة جديدة من ${p?.senderName || ''}`, 'info');
});

// إشعارات الصفقات — يراها قائد الفريق فقط (السيرفر يحدد من يستقبل البث).
App.on('rt:DEAL_DONE_CREATED', (p) => { if (App.state.user?.role === 'team_leader') pushAlert(`🎉 تمت صفقة — ${p.customerId} — ${p.amount} ج.م في ${p.branchName || ''}`, 'success'); });
App.on('rt:BRANCH_VISIT_CREATED', (p) => { if (App.state.user?.role === 'team_leader') pushAlert(`🏪 زيارة فرع — ${p.customerId} في ${p.branchName || ''}`, 'info'); });
App.on('rt:PURCHASE_REFUNDED', (p) => { if (App.state.user?.role === 'team_leader') pushAlert(`↩ تم تسجيل استرجاع — ${p.customerId}`, 'info'); });
App.on('rt:PURCHASE_PARTIALLY_REFUNDED', (p) => { if (App.state.user?.role === 'team_leader') pushAlert(`↩ استرجاع جزئي — ${p.customerId}`, 'info'); });

async function refreshNotifications() {
  if (!App.state.user) return;
  try {
    const data = await api('/notifications');
    App.state.notifications = data.notifications;
    App.state.unreadCount = data.unreadCount;
    App.emit('notifications-updated');
  } catch {}
}
App.refreshNotifications = refreshNotifications;

async function refreshChatUnread() {
  if (!App.state.user) return;
  try {
    const data = await api('/chat/unread-count');
    App.state.chatUnread = data.unread;
    App.emit('chat-unread-updated');
  } catch {}
}
App.refreshChatUnread = refreshChatUnread;

// ---------------------------------------------------------------------------
// الموجّه (Router)
// ---------------------------------------------------------------------------
const ROUTES = [];
// المعامل الثالث الاختياري: { roles: ['team_leader'] } يقصر الصفحة على هذه الأدوار.
// هذا حماية إضافية من جهة الواجهة فقط — كل نقطة تعديل (وأغلب نقاط القراءة)
// محمية أيضًا من جهة السيرفر بغض النظر عمّا تعرضه الواجهة. لكن بدون هذا الفحص
// هنا، موظف يُعدّل الرابط يدويًا (مثلاً إلى #/distribute) سيظل يبني الصفحة
// بالكامل وتُنفَّذ استدعاءات تحميل بياناتها (وبعضها غير محمي في القراءة أصلاً)
// فيرى بيانات لا يجب أن يراها حتى لو فشل الإجراء الفعلي لاحقًا من السيرفر.
App.route = (pattern, handler, opts) => ROUTES.push({ pattern, handler, roles: opts && opts.roles });

function matchRoute(hash) {
  const path = (hash.replace(/^#/, '') || '/dashboard').split('?')[0] || '/dashboard';
  for (const r of ROUTES) {
    const keys = [];
    const regex = new RegExp('^' + r.pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    const m = path.match(regex);
    if (m) {
      const params = {};
      keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params, roles: r.roles };
    }
  }
  return null;
}

// كل معالج صفحة يمكنه إرفاق `.cleanup()` بالعنصر الذي يُعيده (لإلغاء الاشتراك في
// أحداث الاتصال المباشر). القالب العام (الشريط الجانبي والعلوي) يشترك أيضًا في
// أحداث (شارة الاتصال وجرس الإشعارات) ويُعاد بناؤه بالكامل في كل تنقل. يجب
// إلغاء الاثنين قبل الرسم التالي وإلا تتراكم المستمعات وتُسبب أخطاء أو تسريب ذاكرة.
let currentViewCleanup = null;
let currentShellCleanup = null;
function teardownPreviousRender() {
  if (currentViewCleanup) {
    try { currentViewCleanup(); } catch (e) { console.error(e); }
    currentViewCleanup = null;
  }
  if (currentShellCleanup) {
    try { currentShellCleanup(); } catch (e) { console.error(e); }
    currentShellCleanup = null;
  }
}

async function renderRoute() {
  const root = document.getElementById('app');
  if (!App.state.user) {
    teardownPreviousRender();
    if (location.hash !== '#/login') {
      location.hash = '#/login';
      return;
    }
    root.innerHTML = '';
    root.appendChild(await App.views.login());
    return;
  }
  if (location.hash === '#/login') {
    location.hash = '#/dashboard';
    return;
  }
  const match = matchRoute(location.hash);
  teardownPreviousRender();
  root.innerHTML = '';
  const shell = renderShell();
  currentShellCleanup = shell.cleanup || null;
  root.appendChild(shell.root);
  const content = shell.content;
  content.innerHTML = '<div class="boot-loader" style="height:200px"><div class="spinner"></div></div>';
  try {
    let view;
    if (match && match.roles && !match.roles.includes(App.state.user.role)) {
      view = el('div', { class: 'empty-state' }, [
        el('div', { class: 'icon' }, ['🚫']),
        el('div', { style: 'font-weight:700;margin-bottom:4px' }, ['غير مصرح بالدخول']),
        el('div', { class: 'muted' }, ['ليس لديك صلاحية لعرض هذه الصفحة.']),
      ]);
    } else {
      view = match ? await match.handler(match.params) : el('div', {}, ['الصفحة غير موجودة']);
    }
    content.innerHTML = '';
    content.appendChild(view);
    currentViewCleanup = typeof view.cleanup === 'function' ? view.cleanup : null;
  } catch (err) {
    console.error(err);
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['⚠️']), err.message || 'حدث خطأ ما']));
  }
}
window.addEventListener('hashchange', renderRoute);
App.navigate = (hash) => { location.hash = hash; };
// يعيد رسم الصفحة الحالية (الهيكل والمحتوى) دون تغيير الرابط — مفيد بعد تعديل
// بيانات المستخدم نفسه (مثل الصورة الشخصية) حيث لا يُطلق hashchange لنفس الرابط.
App.rerender = renderRoute;

// ---------------------------------------------------------------------------
// القالب العام للموقع (الشريط الجانبي والشريط العلوي)
// ---------------------------------------------------------------------------
const NAV_TL = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['command-center', '🎛️', 'مركز التحكم'],
  ['customers', '👥', 'العملاء'],
  ['favorites', '⭐', 'المفضلة'],
  ['import', '📥', 'استيراد عملاء'],
  ['distribute', '🔀', 'توزيع العملاء'],
  ['employees', '🧑‍💼', 'الموظفين'],
  ['followups', '⏰', 'المتابعات'],
  ['calendar', '🗓️', 'تقويم المتابعات'],
  ['complaints', '🚩', 'الشكاوى'],
  ['chat', '💬', 'الدردشة'],
  ['analytics', '📈', 'التحليلات'],
  ['leaderboard', '🏆', 'لوحة الصدارة'],
  ['reports', '🧾', 'التقارير'],
  ['activity', '🕒', 'سجل الأنشطة'],
  ['notifications', '🔔', 'الإشعارات'],
  ['ai', '🤖', 'المساعد الذكي'],
  ['settings', '⚙️', 'الإعدادات'],
];
const NAV_TL_OWNER_EXTRA = ['team-leader-performance', '👑', 'أداء قائد الفريق'];
const NAV_EMPLOYEE = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['work-queue', '🎯', 'قائمة مهامي'],
  ['my-customers', '👥', 'عملائي'],
  ['favorites', '⭐', 'المفضلة'],
  ['followups', '⏰', 'المتابعات'],
  ['calendar', '🗓️', 'تقويم المتابعات'],
  ['chat', '💬', 'الدردشة'],
  ['notifications', '🔔', 'الإشعارات'],
  ['my-performance', '📈', 'أدائي'],
  ['profile', '🙍', 'الملف الشخصي'],
];

function renderShell() {
  const user = App.state.user;
  let nav = user.role === 'team_leader' ? NAV_TL : NAV_EMPLOYEE;
  if (user.role === 'team_leader' && user.isOwner) nav = [...nav, NAV_TL_OWNER_EXTRA];
  const currentPath = (location.hash || '#/dashboard').replace(/^#\//, '').split('/')[0];
  const chatNavBadge = renderChatNavBadge();

  const sidebar = el('div', { class: 'sidebar', id: 'sidebar' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('div', { class: 'brand-row' }, [
        el('div', { class: 'brand-mark' }, [el('img', { src: '/logo.png', alt: 'رحمة مول' })]),
        el('div', {}, [
          el('div', { class: 'logo' }, ['رحمة مول']),
          el('div', { class: 'sub' }, ['نظام إدارة فريق المبيعات']),
        ]),
      ]),
    ]),
    el('div', { class: 'nav' }, nav.map(([path, icon, label]) =>
      el('div', {
        class: 'nav-item' + (currentPath === path ? ' active' : ''),
        onclick: () => { App.navigate('#/' + path); document.getElementById('sidebar').classList.remove('open'); },
      }, [
        el('span', { class: 'nav-icon', style: 'position:relative' }, [icon, path === 'chat' ? chatNavBadge : null]),
        label,
      ])
    )),
    el('div', { class: 'sidebar-footer' }, [
      el('button', { class: 'btn btn-outline btn-block btn-sm', onclick: App.toggleTheme }, [App.state.theme === 'dark' ? '☀️ الوضع الفاتح' : '🌙 الوضع الداكن']),
      el('div', { class: 'dev-credit' }, ['Developed by Ahmed Nagy']),
    ]),
  ]);

  const connBadge = renderConnBadge();
  const notifBell = renderNotifBell();
  const soundToggle = renderSoundToggle();
  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'btn btn-icon sidebar-toggle', onclick: () => document.getElementById('sidebar').classList.toggle('open') }, ['☰']),
    el('div', { class: 'search' }, [
      el('input', {
        placeholder: 'ابحث بالهاتف، الكود، الاسم، الحملة…', onkeydown: (e) => {
          if (e.key === 'Enter' && e.target.value.trim()) App.navigate('#/customers?q=' + encodeURIComponent(e.target.value.trim()));
        },
      }),
    ]),
    el('div', { class: 'topbar-actions' }, [
      connBadge,
      soundToggle,
      notifBell,
      el('div', { class: 'flex gap-8', style: 'align-items:center' }, [
        App.avatar({ url: user.avatarUrl, name: user.displayName, sizeClass: 'avatar-sm' }),
        el('div', { class: 'topbar-user-name' }, [el('div', { style: 'font-weight:700;font-size:13px' }, [user.displayName]), el('div', { class: 'faint' }, [user.role === 'team_leader' ? 'قائد الفريق' : 'موظف'])]),
        el('button', { class: 'btn btn-outline btn-sm', onclick: doLogout }, ['تسجيل خروج']),
      ]),
    ]),
  ]);

  const content = el('div', { class: 'content' });
  const main = el('div', { class: 'main' }, [topbar, content]);
  const root = el('div', { class: 'shell' }, [sidebar, main]);
  const cleanups = [connBadge.offEvt, notifBell.offEvt, chatNavBadge.offEvt, soundToggle.offEvt].filter(Boolean);
  return { root, content, cleanup: () => cleanups.forEach((off) => off()) };
}

const CONN_LABELS = { LIVE: 'مباشر', RECONNECTING: 'جارِ إعادة الاتصال', OFFLINE: 'غير متصل' };
function renderConnBadge() {
  const wrap = el('div', { class: 'conn-badge conn-' + App.state.wsStatus.toLowerCase() }, [
    el('span', { class: 'dot' + (App.state.wsStatus === 'LIVE' ? ' pulse' : '') }),
    CONN_LABELS[App.state.wsStatus] || App.state.wsStatus,
  ]);
  wrap.offEvt = App.on('ws-status', () => {
    wrap.className = 'conn-badge conn-' + App.state.wsStatus.toLowerCase();
    wrap.innerHTML = '';
    wrap.appendChild(el('span', { class: 'dot' + (App.state.wsStatus === 'LIVE' ? ' pulse' : '') }));
    wrap.appendChild(document.createTextNode(CONN_LABELS[App.state.wsStatus] || App.state.wsStatus));
  });
  return wrap;
}

function renderSoundToggle() {
  const btn = el('button', {
    class: 'btn btn-icon',
    title: App.state.soundEnabled ? 'كتم صوت التنبيهات' : 'تفعيل صوت التنبيهات',
    onclick: App.toggleSound,
  }, [App.state.soundEnabled ? '🔊' : '🔇']);
  btn.offEvt = App.on('sound-toggled', () => {
    btn.textContent = App.state.soundEnabled ? '🔊' : '🔇';
    btn.title = App.state.soundEnabled ? 'كتم صوت التنبيهات' : 'تفعيل صوت التنبيهات';
  });
  return btn;
}

function renderChatNavBadge() {
  const badge = el('span', {
    style: 'position:absolute;top:-4px;inset-inline-end:-8px;background:var(--danger);color:#fff;border-radius:10px;font-size:9px;padding:1px 4px;display:none;line-height:1.4',
  });
  function update() {
    if (App.state.chatUnread > 0) {
      badge.style.display = 'inline';
      badge.textContent = App.state.chatUnread > 9 ? '9+' : App.state.chatUnread;
    } else badge.style.display = 'none';
  }
  badge.offEvt = App.on('chat-unread-updated', update);
  update();
  return badge;
}

function renderNotifBell() {
  const btn = el('button', { class: 'btn btn-icon', style: 'position:relative', onclick: () => App.navigate('#/notifications') }, ['🔔']);
  const badge = el('span', {
    style: 'position:absolute;top:2px;inset-inline-end:2px;background:var(--danger);color:#fff;border-radius:10px;font-size:10px;padding:1px 5px;display:none',
  });
  btn.appendChild(badge);
  function update() {
    if (App.state.unreadCount > 0) {
      badge.style.display = 'inline';
      badge.textContent = App.state.unreadCount > 9 ? '9+' : App.state.unreadCount;
    } else badge.style.display = 'none';
  }
  btn.offEvt = App.on('notifications-updated', update);
  update();
  return btn;
}

async function doLogout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  App.state.user = null;
  RT.disconnect();
  App.navigate('#/login');
}

// ---------------------------------------------------------------------------
// نبضة الحضور (Presence heartbeat)
// ---------------------------------------------------------------------------
// الخادم يملك بالفعل نظام حضور كامل (تسجيل دخول/خروج + عداد وقت أونلاين +
// اعتبار الموظف "خامل" بعد 5 دقائق و"غير متصل" بعد 15 دقيقة بدون نبضة نشاط —
// انظر worker/src/lib/presence.js) لكن الواجهة لم تكن ترسل أي نبضة نشاط على
// الإطلاق، فكان أي موظف يظهر "غير متصل" لقائد الفريق بعد ١٥ دقيقة من الدخول
// حتى لو كان يستخدم الموقع فعليًا في نفس اللحظة. هذا يرسل نبضة كل دقيقة طالما
// الصفحة ظاهرة (التاب مفتوح) وطالما كان هناك تفاعل حقيقي (مؤشر/لوحة مفاتيح/
// تمرير/لمس) خلال آخر دقيقتين — لا نُرسل نبضة لموظف ترك التاب مفتوحًا وابتعد.
let lastUserActivityAt = Date.now();
let presenceHeartbeatStarted = false;
['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach((evt) => {
  document.addEventListener(evt, () => { lastUserActivityAt = Date.now(); }, { passive: true });
});
async function sendPresenceHeartbeatIfActive() {
  if (!App.state.user || !App.state.user.employeeId) return; // فقط الموظفون لديهم صف حضور — قائد الفريق ليس له
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastUserActivityAt > 2 * 60 * 1000) return; // خامل فعليًا — نترك الخادم يتكفّل بذلك تلقائيًا
  try { await api('/presence/heartbeat', { method: 'POST' }); } catch {}
}
App.startPresenceHeartbeat = function () {
  if (presenceHeartbeatStarted) return;
  presenceHeartbeatStarted = true;
  lastUserActivityAt = Date.now(); // أول نبضة فورية عند تسجيل الدخول/فتح الصفحة، دون انتظار دقيقة كاملة
  sendPresenceHeartbeatIfActive();
  setInterval(sendPresenceHeartbeatIfActive, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sendPresenceHeartbeatIfActive(); });
};

// ---------------------------------------------------------------------------
// الإقلاع
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const data = await api('/auth/me');
    App.state.user = data.user;
  } catch {
    App.state.user = null;
  }
  if (App.state.user) {
    RT.connect();
    App.startPresenceHeartbeat();
    refreshNotifications();
    refreshChatUnread();
  }
  renderRoute();
}

App.route('/login', async () => App.views.login());
window.addEventListener('DOMContentLoaded', boot);
