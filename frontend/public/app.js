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
    attendance: null, // { checkedInAt, checkedOutAt, isLate, lateMinutes, lateCountThisMonth, remainingLateAllowance, isHolidayToday }
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
// كل صفحة كانت بتعمل App.on('rt:*', load) — يعني أي حدث لحظي في أي مكان في
// الموقع (مكالمة، ملاحظة، تغيير حالة، حضور موظف تاني تمامًا...) كان بيخلّي
// كل تاب مفتوح يعيد تحميل بياناته بالكامل من D1 من الصفر، حتى لو الحدث ده
// مالوش أي علاقة بالشاشة المعروضة. وقت الذروة ده معناه عشرات الاستعلامات
// الكاملة في الدقيقة لكل تاب مفتوح — من أكبر أسباب استهلاك حصة القراءة
// اليومية. onRealtime بتجمع الأحداث المتقاربة وتضمن حد أقصى لمرة تحديث
// واحدة كل minIntervalMs (مع تحديث أخير مضمون بعد آخر حدث، فالشاشة
// متفضلش قديمة لفترة طويلة) — التحديث نفسه لسه لحظي كفاية للعمل اليومي،
// بس بسقف معقول بدل ما يتكرر مع كل حدث فردي.
App.onRealtime = (handler, minIntervalMs = 5000) => {
  let lastRun = 0;
  let timer = null;
  function run() {
    lastRun = Date.now();
    timer = null;
    try {
      handler();
    } catch (e) {
      console.error(e);
    }
  }
  return App.on('rt:*', () => {
    const elapsed = Date.now() - lastRun;
    if (elapsed >= minIntervalMs) {
      run();
    } else if (!timer) {
      timer = setTimeout(run, minIntervalMs - elapsed);
    }
  });
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
// timeZone: 'Africa/Cairo' صريحة هنا — بدونها، أي وقت معروض كان بيتحوّل
// لتوقيت جهاز المتصفح نفسه (لو جهاز الموظف مضبوط بمنطقة زمنية مختلفة)
// بدل توقيت مصر الفعلي، رغم إن كل الأوقات مخزّنة ومحسوبة بتوقيت القاهرة
// من السيرفر أصلًا (lib/workhours.js).
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', day: '2-digit', month: 'short', year: 'numeric' });
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
  EMPLOYEE_HR_PROFILE_UPDATED: 'تحديث ملف HR للموظف',
  LEAVE_REQUESTED: 'طلب إجازة', LEAVE_APPROVED: 'الموافقة على إجازة', LEAVE_REJECTED: 'رفض طلب إجازة',
  LEAVE_CANCELLED: 'إلغاء طلب إجازة', LEAVE_BALANCE_UPDATED: 'تعديل رصيد إجازة',
  EVALUATION_CREATED: 'إنشاء تقييم أداء', EVALUATION_UPDATED: 'تعديل تقييم أداء', EVALUATION_ACKNOWLEDGED: 'اطلاع على تقييم أداء',
  VIOLATION_LOGGED: 'تسجيل مخالفة', VIOLATION_UPDATED: 'تعديل مخالفة', VIOLATION_ACKNOWLEDGED: 'اطلاع على مخالفة', VIOLATION_RESOLVED: 'إغلاق مخالفة',
  TRAINING_ADDED: 'إضافة تدريب', TRAINING_UPDATED: 'تحديث تدريب',
  DOCUMENT_ADDED: 'إضافة مستند', DOCUMENT_UPDATED: 'تعديل مستند', DOCUMENT_DELETED: 'حذف مستند',
  BENEFIT_LOGGED: 'تسجيل مكافأة/خصم مالي', BENEFIT_APPROVED: 'اعتماد حركة مالية', BENEFIT_REJECTED: 'رفض حركة مالية', BENEFIT_PAID: 'صرف حركة مالية',
  ANNOUNCEMENT_POSTED: 'نشر إعلان', ANNOUNCEMENT_UPDATED: 'تعديل إعلان', ANNOUNCEMENT_DELETED: 'حذف إعلان',
  EMPLOYEE_CREATED: 'إضافة موظف جديد', EMPLOYEE_USERNAME_CHANGED: 'تغيير اسم المستخدم', EMPLOYEE_NAME_CHANGED: 'تغيير اسم الموظف', EMPLOYEE_PASSWORD_RESET: 'إعادة تعيين كلمة المرور',
  BRANCH_CREATED: 'إنشاء فرع', BRANCH_VISIT_CREATED: 'تسجيل زيارة فرع', DEAL_DONE_CREATED: 'تسجيل صفقة',
  PURCHASE_UPDATED: 'تعديل عملية شراء', PURCHASE_CANCELLED: 'إلغاء عملية شراء', REFUND_CREATED: 'تسجيل استرجاع',
  SETTINGS_UPDATED: 'تحديث الإعدادات', AI_QUESTION_ASKED: 'سؤال للمساعد الذكي',
  BULK_STATUS: 'تعديل جماعي للحالة', BULK_PRIORITY: 'تعديل جماعي للأولوية', BULK_ARCHIVE: 'أرشفة جماعية',
  COMPLAINT_LOGGED: 'تسجيل شكوى', COMPLAINT_DELETED: 'حذف شكوى', CHAT_MESSAGE_SENT: 'إرسال رسالة دردشة',
  EMPLOYEE_DND_STARTED: 'تفعيل عدم الإزعاج المؤقت', EMPLOYEE_DND_CANCELLED: 'إلغاء عدم الإزعاج',
  CUSTOMER_MARKED_VIP: 'تمييز عميل كـ VIP', CUSTOMER_UNMARKED_VIP: 'إلغاء تمييز VIP',
  REWARD_EARNED: 'مكافأة صفقة', REWARD_REVERSED: 'عكس مكافأة', REWARD_MOVED: 'نقل مكافأة صفقة',
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
  if (res.status === 403 && data && data.error && data.error.code === 'OUTSIDE_WORK_HOURS') {
    showShiftClosedScreen(data.error);
    throw new Error(data.error.message || 'النظام مغلق حاليًا');
  }
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || 'فشل الطلب';
    throw new Error(message);
  }
  // الخادم يرد بآخر نسخة معروفة من البيانات إذا تعذّر الوصول لقاعدة البيانات،
  // ويضع stale: true. لا يصح أن يتصرّف الفريق في بيانات عميل دون أن يعرف أنها
  // قد تكون قديمة — ننبّه مرة واحدة كل دقيقة حتى لا يتحوّل التنبيه إلى إزعاج.
  if (data && data.stale === true) notifyStaleData();
  return data;
}

// النظام مغلق تمامًا خارج مواعيد العمل لغير التيم ليدر والمالك (يوفّر استهلاك
// قاعدة البيانات). نعرض شاشة كاملة بدل أي محتوى — لا نحاول تحميل شيء آخر —
// ونعيد تحميل الصفحة تلقائيًا كل دقيقة حتى تُفتح مع بداية الشيفت من تلقاء نفسها.
let shiftClosedShown = false;
function showShiftClosedScreen(err) {
  if (shiftClosedShown) return;
  shiftClosedShown = true;
  const appEl = document.getElementById('app');
  if (!appEl) return;
  appEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;direction:rtl;font-family:inherit;';
  wrap.innerHTML =
    '<div style="max-width:420px">' +
    '<div style="font-size:48px;margin-bottom:12px">🔒</div>' +
    '<div style="font-size:20px;font-weight:700;margin-bottom:10px">النظام مغلق حاليًا</div>' +
    '<div style="color:var(--muted,#666);line-height:1.8;font-size:15px">' + (err.message || '') + '</div>' +
    '</div>';
  appEl.appendChild(wrap);
  setInterval(() => location.reload(), 60 * 1000);
}
App.showShiftClosedScreen = showShiftClosedScreen;

let lastStaleNoticeAt = 0;
function notifyStaleData() {
  const now = Date.now();
  if (now - lastStaleNoticeAt < 60 * 1000) return;
  lastStaleNoticeAt = now;
  toast('البيانات المعروضة قد تكون غير محدَّثة — قاعدة البيانات تحت ضغط مؤقت', 'warn');
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

// مكافأة صفقة — تصل للموظف صاحب الصفقة فقط (السيرفر يحدد المستلم بالبث
// الموجَّه scope:'employee'). تنبيه احتفالي واضح بدل توست عادي — الهدف
// تحفيز الموظف فعليًا، وليس مجرد إعلامه.
App.on('rt:REWARD_EARNED', (p) => { pushAlert(`🎉💰 مبروك! حصلت على مكافأة ${p.amount} ج.م — رصيدك الآن ${p.balance} ج.م`, 'success'); });
// خصم شفاف من رصيد المكافآت (مثل تأخير كتابة ملاحظة) — نفس وضوح تنبيه
// المكافأة، بالسالب، حتى لا يفاجأ الموظف لاحقًا برصيد أقل من غير سبب واضح.
App.on('rt:REWARD_REVERSED', (p) => { if (p.amount < 0) pushAlert(`⚠️ تم خصم ${Math.abs(p.amount)} ج.م من رصيد مكافآتك — رصيدك الآن ${p.balance} ج.م`, 'warn'); });
// إنجازات تحفيزية بلا مقابل مالي (اقتراب من الهدف الشهري / تحقيقه بالكامل).
App.on('rt:MOTIVATION_MILESTONE', (p) => {
  if (p.kind === 'MONTHLY_GOAL_HIT') pushAlert(`🎯 مبروك! حققت هدفك الشهري (${p.target} صفقات) 👏`, 'success');
  else if (p.kind === 'MONTHLY_GOAL_NEAR') pushAlert('🔥 باقي صفقة واحدة فقط لتحقيق هدفك الشهري!', 'info');
});

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
// خريطة مساعِدة (patttern -> handler) — تتيح لصفحة استدعاء صفحة أخرى مباشرة
// وتضمين نتيجتها كقسم فرعي، بدل تكرار نفس الكود. صفحة داش بورد المالك
// الوحيدة تستخدمها لتضمين محتوى "لوحة التحكم" و"مركز التحكم" و"التحليلات"
// و"لوحة الصدارة" و"التقارير" و"سجل الأنشطة" كأقسام داخل صفحته — بدون أي
// تنقّل فعلي (location.hash لا يتغيّر)، فلا تأثير على التوجيه العادي لباقي
// الحسابات ولا خطر حلقة إعادة توجيه.
const ROUTE_HANDLERS = {};
App.getRouteHandler = (pattern) => ROUTE_HANDLERS[pattern];
// المعامل الثالث الاختياري:
//   { roles: ['team_leader'] } يقصر الصفحة على هذه الأدوار.
//   { denyIfPlainSalesLead: true } يمنع قائد الفريق العادي (المبيعات، مش HR
//     ومش الأدمن) من فتح صفحة خاصة بالموارد البشرية — الصفحة لسه مفتوحة
//     للموظف (يشوف بياناته هو) ولحساب HR/الأدمن.
//   { denyIfPlainHr: true } عكسها: يمنع حساب HR العادي من فتح صفحة خاصة
//     بقائد الفريق (المبيعات).
// هذا حماية إضافية من جهة الواجهة فقط — كل نقطة تعديل (وأغلب نقاط القراءة)
// محمية أيضًا من جهة السيرفر بغض النظر عمّا تعرضه الواجهة. لكن بدون هذا الفحص
// هنا، حساب يُعدّل الرابط يدويًا (مثلاً إلى #/distribute أو #/leaves) سيظل
// يبني الصفحة بالكامل وتُنفَّذ استدعاءات تحميل بياناتها (وبعضها غير محمي في
// القراءة أصلاً) فيرى بيانات أو صفحة مكسورة لا يجب أن يراها، بدل رسالة واضحة
// إنها خاصة بحساب تاني.
App.route = (pattern, handler, opts) => {
  ROUTES.push({
    pattern,
    handler,
    roles: opts && opts.roles,
    denyIfPlainSalesLead: opts && opts.denyIfPlainSalesLead,
    denyIfPlainHr: opts && opts.denyIfPlainHr,
  });
  ROUTE_HANDLERS[pattern] = handler;
};

function matchRoute(hash) {
  const path = (hash.replace(/^#/, '') || '/dashboard').split('?')[0] || '/dashboard';
  for (const r of ROUTES) {
    const keys = [];
    const regex = new RegExp('^' + r.pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    const m = path.match(regex);
    if (m) {
      const params = {};
      keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params, roles: r.roles, denyIfPlainSalesLead: r.denyIfPlainSalesLead, denyIfPlainHr: r.denyIfPlainHr };
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
  // يُفحص عند كل تنقّل، مش بس أول تحميل — تعديل الرابط يدويًا (hashchange)
  // بعد الحظر الأول ما ينفعش يلتف حول شاشة الحظر.
  if (!isLikelyDesktopDevice()) {
    showDeviceBlockedScreen();
    return;
  }
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
  // حساب "admin" (👑 الرؤية الشاملة — is_owner=1) بقى حساب god-view كامل:
  // كل شغل قائد الفريق (المبيعات) + كل شغل الموارد البشرية في مكان واحد،
  // بدون أي قفل أو تحويل تلقائي لصفحة واحدة (كان ده سلوك الحساب القديم
  // "استاذ هاني" اللي كان للعرض فقط — اتلغى تمامًا بناءً على طلب صريح).
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
    const curUser = App.state.user;
    // قائد فريق عادي (مبيعات فقط) — مش HR ومش الأدمن.
    const isPlainSalesLead = curUser.role === 'team_leader' && !curUser.isHr && !curUser.isOwner;
    // حساب HR عادي — مش الأدمن.
    const isPlainHr = curUser.role === 'team_leader' && curUser.isHr && !curUser.isOwner;
    let denyMessage = null;
    if (match && match.roles && !match.roles.includes(curUser.role)) {
      denyMessage = 'ليس لديك صلاحية لعرض هذه الصفحة.';
    } else if (match && match.denyIfPlainSalesLead && isPlainSalesLead) {
      denyMessage = 'هذه الصفحة خاصة بحساب الموارد البشرية — ليس لديك صلاحية لعرضها.';
    } else if (match && match.denyIfPlainHr && isPlainHr) {
      denyMessage = 'هذه الصفحة خاصة بحساب قائد الفريق — ليس لديك صلاحية لعرضها.';
    }
    if (denyMessage) {
      view = el('div', { class: 'empty-state' }, [
        el('div', { class: 'icon' }, ['🚫']),
        el('div', { style: 'font-weight:700;margin-bottom:4px' }, ['غير مصرح بالدخول']),
        el('div', { class: 'muted' }, [denyMessage]),
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
// ---------------------------------------------------------------------------
// حارس "الملاحظة الإلزامية" — تسجّله صفحة تفاصيل العميل عندما يكون العميل
// المفتوح محتاج ملاحظة (فُتح ولم تُكتب عنه ملاحظة بعد)، ويمنع أي تنقّل — زر
// رجوع، رابط في القائمة الجانبية، أو زر رجوع المتصفح — لحد ما تُكتب الملاحظة.
// hashchange تسجّل التنقّل بعد ما يحصل فعلًا، فالحيلة إننا نرجّع الهاش فورًا
// لمكانه (revertingGuardedHash يمنع هذا الرجوع نفسه من إعادة تشغيل الحارس)
// ونعرض نافذة الملاحظة الإلزامية بدل الصفحة الجديدة. الهدف اللي كان بيحاول
// يوصله المستخدم يتذكّر (pendingBlockedHash) عشان يوصله تلقائيًا بعد الحفظ.
// ---------------------------------------------------------------------------
let activeNoteGuard = null; // { hash, onRequireNote() } | null
let pendingBlockedHash = null;
let revertingGuardedHash = false;
App.setNoteGuard = (guard) => { activeNoteGuard = guard; };
App.clearNoteGuard = () => { activeNoteGuard = null; pendingBlockedHash = null; };
App.consumeBlockedNavigation = () => { const h = pendingBlockedHash; pendingBlockedHash = null; return h; };

function guardedHashChange() {
  if (revertingGuardedHash) { revertingGuardedHash = false; renderRoute(); return; }
  if (activeNoteGuard && location.hash !== activeNoteGuard.hash) {
    pendingBlockedHash = location.hash;
    revertingGuardedHash = true;
    location.hash = activeNoteGuard.hash;
    activeNoteGuard.onRequireNote();
    return;
  }
  renderRoute();
}
window.addEventListener('hashchange', guardedHashChange);
// إغلاق التاب/تحديث الصفحة لا يمكن منعه فعليًا (ولا ينبغي)، لكن تحذير
// المتصفح الافتراضي هنا أفضل من مغادرة صامتة تمامًا بدون ملاحظة.
window.addEventListener('beforeunload', (e) => {
  if (activeNoteGuard) { e.preventDefault(); e.returnValue = ''; }
});
App.navigate = (hash) => { location.hash = hash; };
// يعيد رسم الصفحة الحالية (الهيكل والمحتوى) دون تغيير الرابط — مفيد بعد تعديل
// بيانات المستخدم نفسه (مثل الصورة الشخصية) حيث لا يُطلق hashchange لنفس الرابط.
App.rerender = renderRoute;

// ---------------------------------------------------------------------------
// القالب العام للموقع (الشريط الجانبي والشريط العلوي)
// ---------------------------------------------------------------------------
// قائد الفريق الفعلي (المبيعات) — بعد فصل صلاحيات HR، القائمة دي بقت مقتصرة
// على شغل المبيعات/CRM فقط، وبنودها السبعة الخاصة بالموارد البشرية اتنقلت
// لقائمة NAV_HR المنفصلة تحت.
// قائمة قائد الفريق العادي (المبيعات) — القائمة الحصرية اللي حددها صاحب
// الشركة بالظبط: مفيهاش مركز التحكم، الدردشة، التقارير، سجل الأنشطة،
// المساعد الذكي، الإعدادات، المتابعات، ولا تقويم المتابعات — دي بقت حصرًا
// لحساب الـ HR/الأدمن (NAV_ADMIN). "الإجازات والغياب" اتضافت هنا كبند
// مشترك (يشوفه TL وHR الاتنين)، لكن التيم ليدر العادي يشوفها بس من غير ما
// يقدر يوافق/يرفض على طلبات الإجازة (شوف views-leaves.js).
const NAV_TL = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['customers', '👥', 'العملاء'],
  ['favorites', '⭐', 'المفضلة'],
  ['import', '📥', 'استيراد عملاء'],
  ['distribute', '🔀', 'توزيع العملاء'],
  ['today-leads', '📞', 'أرقام اليوم'],
  ['team-performance', '🏅', 'أداء الفريق'],
  ['leaves', '🗓️', 'الإجازات والغياب'],
  ['employees', '🧑‍💼', 'الموظفين'],
  ['complaints', '🚩', 'الشكاوى'],
  ['analytics', '📈', 'التحليلات'],
  ['leaderboard', '🏆', 'لوحة الصدارة'],
  ['notifications', '🔔', 'الإشعارات'],
];

// حساب الموارد البشرية (isHr=1) — نفس role='team_leader' في قاعدة البيانات،
// لكن قائمة مختلفة تمامًا: كل شغل الموارد البشرية (الإجازات، التقييم،
// المخالفات، التدريب، المستندات، المزايا، الإعلانات) + الموظفين كملف
// أساسي، بدون أي وصول لشغل المبيعات/CRM (العملاء، التوزيع، التحليلات...).
const NAV_HR = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['employees', '🧑‍💼', 'الموظفين'],
  ['leaves', '🗓️', 'الإجازات والغياب'],
  ['evaluations', '📝', 'الأداء والتقييم'],
  ['violations', '⚠️', 'المخالفات والإجراءات'],
  ['trainings', '🎓', 'التدريب والتطوير'],
  ['documents', '📁', 'المستندات والعقود'],
  ['benefits', '💰', 'المزايا والمكافآت'],
  ['announcements', '📢', 'الإعلانات الداخلية'],
  ['chat', '💬', 'الدردشة'],
  ['notifications', '🔔', 'الإشعارات'],
];

// حساب "admin" (👑 الرؤية الشاملة، is_owner=1) — god-view كامل للشركة:
// كل بنود المبيعات/CRM (NAV_TL) + كل بنود الموارد البشرية (NAV_HR) في
// قائمة واحدة مدمجة، بدون أي قفل. هذا هو حساب المالك الفعلي بعد التحديث —
// وصول تشغيلي كامل، مش عرض فقط زي الحساب القديم.
const NAV_ADMIN = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['command-center', '🎛️', 'مركز التحكم'],
  ['customers', '👥', 'العملاء'],
  ['favorites', '⭐', 'المفضلة'],
  ['import', '📥', 'استيراد عملاء'],
  ['distribute', '🔀', 'توزيع العملاء'],
  ['today-leads', '📞', 'أرقام اليوم'],
  ['team-performance', '🏅', 'أداء الفريق'],
  ['employees', '🧑‍💼', 'الموظفين'],
  ['leaves', '🗓️', 'الإجازات والغياب'],
  ['evaluations', '📝', 'الأداء والتقييم'],
  ['violations', '⚠️', 'المخالفات والإجراءات'],
  ['trainings', '🎓', 'التدريب والتطوير'],
  ['documents', '📁', 'المستندات والعقود'],
  ['benefits', '💰', 'المزايا والمكافآت'],
  ['announcements', '📢', 'الإعلانات الداخلية'],
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
const NAV_EMPLOYEE = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['work-queue', '🎯', 'قائمة مهامي'],
  ['my-customers', '👥', 'عملائي'],
  ['favorites', '⭐', 'المفضلة'],
  ['followups', '⏰', 'المتابعات'],
  ['calendar', '🗓️', 'تقويم المتابعات'],
  ['leaves', '🗓️', 'إجازاتي'],
  ['evaluations', '📝', 'تقييماتي'],
  ['violations', '⚠️', 'مخالفاتي'],
  ['trainings', '🎓', 'تدريباتي'],
  ['documents', '📁', 'مستنداتي'],
  ['benefits', '💰', 'مزاياي ومكافآتي'],
  ['announcements', '📢', 'الإعلانات الداخلية'],
  ['chat', '💬', 'الدردشة'],
  ['notifications', '🔔', 'الإشعارات'],
  ['my-performance', '📈', 'أدائي'],
  ['profile', '🙍', 'الملف الشخصي'],
];

// شاشة أستاذ هاني كاملة: مفيش شريط جانبي ولا أي زر ينقّل لصفحة تانية —
// بس شعار الموقع، شارة الاتصال المباشر، وزرار تسجيل الخروج. القصد إنه
// يفتح الموقع فيلاقي نفسه على الداش بورد على طول، من غير ما يقدر يعمل
// أي حاجة تانية أو يضغط غلط على أي إجراء.
function renderOwnerShell() {
  const user = App.state.user;
  const connBadge = renderConnBadge();
  const soundToggle = renderSoundToggle();
  // Pure read-only report modal (start-of-day / end-of-shift snapshots) —
  // no action on any data, just viewing, so it belongs here same as it did
  // in the old sidebar's topbar. renderAdminReportsButton() already checks
  // isOwner internally and returns the button for this account.
  const adminReportsBtn = renderAdminReportsButton();
  // مظهر مميز لحساب المالك — شريط علوي بتدرّج ذهبي وشارة "المالك"، حتى
  // يكون واضحًا من أول لحظة إن هذا الحساب مختلف عن أي حساب موظف أو حتى
  // قائد الفريق العادي (بناءً على طلبه صراحةً).
  const topbar = el('div', { class: 'topbar', style: 'background:linear-gradient(90deg,var(--surface-2),var(--brand-soft));border-bottom:2px solid #d4a017' }, [
    el('div', { class: 'flex gap-8', style: 'align-items:center' }, [
      el('img', { src: '/logo.png', alt: 'رحمة مول', style: 'height:28px' }),
      el('div', { style: 'font-weight:800' }, ['رحمة مول']),
      el('span', { class: 'badge', style: 'background:#d4a017;color:#fff;font-weight:800' }, ['👑 حساب المالك']),
    ]),
    el('div', { class: 'topbar-actions' }, [
      connBadge,
      soundToggle,
      adminReportsBtn,
      el('button', { class: 'btn btn-outline btn-sm', onclick: App.toggleTheme }, [App.state.theme === 'dark' ? '☀️' : '🌙']),
      el('div', { class: 'flex gap-8', style: 'align-items:center' }, [
        App.avatar({ url: user.avatarUrl, name: user.displayName, sizeClass: 'avatar-sm' }),
        el('div', { class: 'topbar-user-name' }, [el('div', { style: 'font-weight:700;font-size:13px' }, [user.displayName])]),
        el('button', { class: 'btn btn-outline btn-sm', onclick: doLogout }, ['تسجيل خروج']),
      ]),
    ]),
  ]);
  const content = el('div', { class: 'content' });
  const main = el('div', { class: 'main', style: 'width:100%' }, [topbar, content]);
  const root = el('div', { class: 'shell owner-shell' }, [main]);
  const cleanups = [connBadge.offEvt, soundToggle.offEvt].filter(Boolean);
  return { root, content, cleanup: () => cleanups.forEach((off) => off()) };
}

function renderShell() {
  const user = App.state.user;
  const isAdmin = !!user.isOwner; // حساب "admin" — الرؤية الشاملة (god-view)
  // الـ HR أعلى من قائد الفريق في الهرم: يشوف كل حاجة (مبيعات + HR)، فقائمته
  // بقت زي قائمة الأدمن بالظبط (بدون المظهر الذهبي المميز اللي يفضل لحساب
  // الأدمن/المالك فقط). قائد الفريق العادي لسه يشوف مبيعاته بس.
  const nav = user.role === 'team_leader' ? ((isAdmin || user.isHr) ? NAV_ADMIN : NAV_TL) : NAV_EMPLOYEE;
  const currentPath = (location.hash || '#/dashboard').replace(/^#\//, '').split('/')[0];
  const chatNavBadge = renderChatNavBadge();

  // مظهر مميز (ذهبي) لحساب الأدمن فقط — عشان يبان من أول لحظة إنه حساب
  // مختلف تمامًا عن أي حساب تاني، مش بس شارة زي القديم، لكن الشريط الجانبي
  // والعلوي كمان يتلوّنوا بتدرّج ذهبي خفيف.
  const sidebar = el('div', { class: 'sidebar' + (isAdmin ? ' sidebar-admin' : ''), id: 'sidebar', style: isAdmin ? 'background:linear-gradient(180deg,var(--surface-2),rgba(212,160,23,0.08));border-inline-end:2px solid #d4a017' : '' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('div', { class: 'brand-row' }, [
        el('div', { class: 'brand-mark' }, [el('img', { src: '/logo.png', alt: 'رحمة مول' })]),
        el('div', {}, [
          el('div', { class: 'logo' }, ['رحمة مول']),
          el('div', { class: 'sub' }, [isAdmin ? '👑 لوحة تحكم الأدمن — رؤية شاملة' : 'نظام إدارة فريق المبيعات']),
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
  const adminReportsBtn = renderAdminReportsButton();
  const attendanceBtn = renderAttendanceButton();
  const topbar = el('div', { class: 'topbar', style: isAdmin ? 'background:linear-gradient(90deg,var(--surface-2),var(--brand-soft));border-bottom:2px solid #d4a017' : '' }, [
    el('button', { class: 'btn btn-icon sidebar-toggle', onclick: () => document.getElementById('sidebar').classList.toggle('open') }, ['☰']),
    isAdmin ? el('span', { class: 'badge', style: 'background:#d4a017;color:#fff;font-weight:800' }, ['👑 Admin']) : null,
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
      attendanceBtn,
      notifBell,
      adminReportsBtn,
      el('div', { class: 'flex gap-8', style: 'align-items:center' }, [
        App.avatar({ url: user.avatarUrl, name: user.displayName, sizeClass: 'avatar-sm' }),
        el('div', { class: 'topbar-user-name' }, [el('div', { style: 'font-weight:700;font-size:13px' }, [user.displayName]), el('div', { class: 'faint' }, [isAdmin ? '👑 المالك — رؤية شاملة' : (user.role === 'team_leader' ? (user.isHr ? 'الموارد البشرية' : 'قائد الفريق') : 'موظف')])]),
        el('button', { class: 'btn btn-outline btn-sm', onclick: doLogout }, ['تسجيل خروج']),
      ]),
    ]),
  ]);

  const content = el('div', { class: 'content' });
  const main = el('div', { class: 'main' }, [topbar, content]);
  const root = el('div', { class: 'shell' }, [sidebar, main]);
  const cleanups = [connBadge.offEvt, notifBell.offEvt, chatNavBadge.offEvt, soundToggle.offEvt, attendanceBtn && attendanceBtn.offEvt].filter(Boolean);
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
// تقارير الإدارة (بداية اليوم / نهاية الشيفت) — زر في الشريط العلوي يظهر فقط
// لحساب المالك (is_owner — حساب أستاذ هاني) ولا يظهر أبدًا لحساب قائد الفريق
// العادي. البيانات تُحسب حيًّا من الخادم في كل ضغطة، بالإضافة لإشعار تلقائي
// يومي مرة عند بداية الدوام ومرة عند نهايته (انظر worker/src/lib/opsreports.js).
// ---------------------------------------------------------------------------
function modal(title, bodyNode, footerNodes) {
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  const m = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title' }, [title]), el('button', { class: 'modal-close', onclick: () => close() }, ['✕'])]),
    el('div', { class: 'modal-body' }, [bodyNode]),
    el('div', { class: 'modal-footer' }, footerNodes || []),
  ]);
  backdrop.appendChild(m);
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
  return { close, el: backdrop };
}

function renderAdminReportsButton() {
  if (!App.state.user || !App.state.user.isOwner) return null;
  return el('button', { class: 'btn btn-icon', title: 'تقارير الإدارة — بداية اليوم / نهاية الشيفت', onclick: openAdminReportsModal }, ['📊']);
}

async function openAdminReportsModal() {
  let tab = 'start'; // 'start' | 'end'
  const startBtn = el('button', { class: 'btn btn-sm', onclick: () => { tab = 'start'; render(); } }, ['🌅 بداية اليوم']);
  const endBtn = el('button', { class: 'btn btn-sm', onclick: () => { tab = 'end'; render(); } }, ['🌙 نهاية الشيفت']);
  const content = el('div', {});
  const body = el('div', {}, [el('div', { class: 'flex gap-8 mb-12' }, [startBtn, endBtn]), content]);

  function setActiveStyles() {
    startBtn.className = 'btn btn-sm ' + (tab === 'start' ? 'btn-primary' : 'btn-outline');
    endBtn.className = 'btn btn-sm ' + (tab === 'end' ? 'btn-primary' : 'btn-outline');
  }

  async function render() {
    setActiveStyles();
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'muted' }, ['جارِ التحميل…']));
    try {
      if (tab === 'start') {
        const { report } = await api('/ops-reports/start-of-day');
        content.innerHTML = '';
        content.appendChild(el('div', { class: 'mb-12' }, [
          el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['🟢 أونلاين الآن']), el('span', { style: 'font-weight:700' }, [`${report.onlineNow}/${report.totalEmployees}`])]),
          el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['⏰ متابعات متأخرة']), el('span', { style: 'font-weight:700' }, [String(report.overdueFollowupsCount)])]),
        ]));
        if (report.attentionItems.length === 0) {
          content.appendChild(el('div', { class: 'muted' }, ['✅ لا يوجد ما يحتاج انتباه فوري.']));
        } else {
          report.attentionItems.forEach((item) => {
            const sev = item.severity === 'CRITICAL' ? 'critical' : 'warning';
            content.appendChild(el('div', { class: 'alert-row alert-row-' + sev, style: 'margin-bottom:8px' }, [
              el('div', { class: 'alert-row-main' }, [el('span', { class: 'alert-row-dot' }), el('span', { class: 'alert-row-label' }, [item.label])]),
            ]));
          });
        }
        content.appendChild(el('div', { class: 'faint mt-8' }, ['آخر تحديث: ' + fmtDateTime(report.generatedAt)]));
      } else {
        const { report } = await api('/ops-reports/end-of-shift');
        content.innerHTML = '';
        content.appendChild(el('div', { class: 'mb-12' }, [
          el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['📞 مكالمات اليوم']), el('span', { style: 'font-weight:700' }, [String(report.totalCallsToday)])]),
          el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['✅ عملاء مغلقين اليوم']), el('span', { style: 'font-weight:700' }, [String(report.totalClosedToday)])]),
          el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['💰 صافي إيراد اليوم']), el('span', { style: 'font-weight:700' }, [report.netRevenueToday.toLocaleString() + ' ج.م'])]),
          el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['🧾 صفقات اليوم']), el('span', { style: 'font-weight:700' }, [String(report.dealsToday)])]),
        ]));
        if (report.topPerformer) {
          content.appendChild(el('div', { class: 'badge', style: 'background:var(--success-soft);color:var(--success);margin-bottom:12px' }, [`🏆 الأفضل اليوم: ${report.topPerformer.name} (${report.topPerformer.closedToday} مغلق)`]));
        }
        content.appendChild(el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['الموظف', 'مكالمات', 'مغلق'].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, report.perEmployee.map((e) => el('tr', {}, [
              el('td', {}, [e.name]), el('td', {}, [String(e.callsToday)]), el('td', {}, [String(e.closedToday)]),
            ]))),
          ]),
        ]));
        content.appendChild(el('div', { class: 'faint mt-8' }, ['آخر تحديث: ' + fmtDateTime(report.generatedAt)]));
      }
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'error-text' }, [e.message || 'تعذّر تحميل التقرير']));
    }
  }

  const dlg = modal('📊 تقارير الإدارة', body, [el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إغلاق'])]);
  await render();
}

// ---------------------------------------------------------------------------
// الحضور والانصراف — زر في الشريط العلوي ظاهر لكل الحسابات (موظف أو قائد
// فريق، بما في ذلك حساب أستاذ هاني نفسه) — منفصل تمامًا عن تسجيل الدخول/
// الخروج. الحالة تُحمّل مرة عند فتح الجلسة (boot) وتُحدَّث محليًا فور كل
// إجراء (تسجيل حضور/انصراف) دون الحاجة لانتظار الاتصال المباشر.
// ---------------------------------------------------------------------------
async function refreshAttendanceStatus() {
  try {
    App.state.attendance = await api('/attendance/me');
  } catch {
    App.state.attendance = null;
  }
  App.emit('attendance-updated');
}
App.refreshAttendanceStatus = refreshAttendanceStatus;

function renderAttendanceButton() {
  // حساب الأدمن (isOwner) — الرؤية الشاملة للشركة — لا يسجّل حضورًا هو
  // نفسه، زي أي مالك/تنفيذي. مخفي لحسابه فقط؛ أي حساب تاني (بما فيه قائد
  // الفريق وHR) لسه بيستخدمها عادي.
  if (!App.state.user || App.state.user.isOwner) return null;
  // كانت مجرد أيقونة ساعة 🕒 صغيرة بين باقي أيقونات الشريط العلوي — ونفس
  // الأيقونة مستخدمة في الشريط الجانبي لصفحة "سجل الأنشطة" أصلًا، فمش واضح
  // إنها خاصة بالبصمة تحديدًا. بقت زر بارز بخلفية ملوّنة ونص "البصمة"
  // صريح، ولونها وخلفيتها تتغيّر حسب الحالة بدل لون النص لوحده.
  const btn = el('button', {
    class: 'btn btn-sm',
    title: 'البصمة — الحضور والانصراف',
    onclick: openAttendanceModal,
    style: 'font-weight:800;border:1.5px solid currentColor;white-space:nowrap',
  }, ['🕒 البصمة']);
  function update() {
    const a = App.state.attendance;
    // "لسه ما سجّلش حضور" هي الحالة الوحيدة اللي فيها ننوّر الزر بحلقة
    // متحركة — لو ناسي يبصم، تبقى ملفتة للنظر بدل لون أحمر ثابت سهل يتفوّت.
    const forgotToCheckIn = !!a && !a.checkedInAt && !a.isHolidayToday;
    btn.classList.toggle('attendance-forgot-glow', forgotToCheckIn);
    if (a && a.checkedInAt && !a.checkedOutAt) {
      btn.style.color = 'var(--success)';
      btn.style.background = 'var(--success-soft)';
    } else if (a && a.checkedOutAt) {
      btn.style.color = 'var(--muted)';
      btn.style.background = 'var(--surface-2)';
    } else if (a && a.isHolidayToday) {
      btn.style.color = 'var(--muted)';
      btn.style.background = 'var(--surface-2)';
    } else {
      btn.style.color = 'var(--danger)';
      btn.style.background = 'var(--danger-soft)';
    }
  }
  btn.offEvt = App.on('attendance-updated', update);
  update();
  return btn;
}

async function openAttendanceModal() {
  const body = el('div', {});
  const footer = el('div', { class: 'flex gap-8' });
  const dlg = modal('🕒 الحضور والانصراف', body, [footer]);

  // فاصل بصري ١.٢ ثانية بين تنفيذ إجراء (حضور/انصراف) وظهور الزر التالي —
  // فيه زر الانصراف مش حاضر في الـ DOM أصلًا وقت الفاصل ده، فضغطة تانية
  // سريعة بالغلط بعد تسجيل الحضور توقعش على "تسجيل انصراف" فوق نفس المكان.
  function showTransientSuccess(text) {
    return new Promise((resolve) => {
      footer.innerHTML = '';
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['✅']), text]));
      setTimeout(resolve, 1200);
    });
  }

  // انصراف قبل نهاية الشيفت الفعلية (من الإعدادات، عبر a.isBeforeShiftEnd) —
  // يطلب تأكيدًا صريحًا بدل تسجيل الانصراف على طول، حتى لا يسجّل أحد
  // انصرافًا مبكرًا بضغطة واحدة بالغلط.
  async function handleCheckoutClick(a) {
    if (!a.isBeforeShiftEnd) return doCheckout();
    body.innerHTML = '';
    footer.innerHTML = '';
    body.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'icon' }, ['⚠️']),
      el('div', { style: 'font-weight:700;margin-bottom:6px' }, ['تسجيل انصراف مبكر']),
      el('div', { class: 'muted' }, [`لسه الدوام ما خلصش (حتى ${a.shiftEndText}) — متأكد إنك عاوز تسجّل انصراف دلوقتي؟`]),
    ]));
    const confirmBtn = el('button', { class: 'btn', style: 'background:var(--danger);color:#fff;border:none;font-weight:800', onclick: () => doCheckout(confirmBtn) }, ['تأكيد الانصراف المبكر']);
    footer.appendChild(confirmBtn);
    footer.appendChild(el('button', { class: 'btn btn-outline', onclick: () => render() }, ['رجوع']));
  }

  async function doCheckout(btn) {
    if (btn) btn.disabled = true;
    try {
      await api('/attendance/check-out', { method: 'POST' });
      await showTransientSuccess('✅ تم تسجيل الانصراف بنجاح');
      await render();
    } catch (e) {
      toast(e.message || 'تعذّر تسجيل الانصراف', 'error');
      await render();
    }
  }

  async function render() {
    body.innerHTML = '';
    footer.innerHTML = '';
    body.appendChild(el('div', { class: 'muted' }, ['جارِ التحميل…']));
    try {
      const a = await api('/attendance/me');
      App.state.attendance = a;
      App.emit('attendance-updated');
      body.innerHTML = '';

      if (a.isHolidayToday) {
        body.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['🌙']), 'اليوم عطلة رسمية — لا حاجة لتسجيل حضور.']));
        return;
      }

      body.appendChild(el('div', { class: 'mb-12' }, [
        el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['وقت الحضور']), el('span', { style: 'font-weight:700' }, [a.checkedInAt ? fmtDateTime(a.checkedInAt) : '— لم يُسجَّل بعد —'])]),
        el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['وقت الانصراف']), el('span', { style: 'font-weight:700' }, [a.checkedOutAt ? fmtDateTime(a.checkedOutAt) : '—'])]),
        a.checkedInAt ? el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['حالة الحضور']), a.isLate ? el('span', { class: 'badge', style: 'background:var(--danger-soft);color:var(--danger)' }, [`متأخر ${fmtDuration(a.lateMinutes * 60)}`]) : el('span', { class: 'badge', style: 'background:var(--success-soft);color:var(--success)' }, ['في الميعاد'])]) : null,
        el('div', { class: 'flex-between' }, [el('span', {}, ['تأخيرات هذا الشهر']), el('span', { style: 'font-weight:700' }, [`${a.lateCountThisMonth} (متبقّي ${a.remainingLateAllowance})`])]),
      ]));

      // الزرين ظاهرين مع بعض دايمًا (بدل إظهار واحد بس حسب الحالة) — الغير
      // منطقي منهم بيتعطّل بدل ما يختفي، حتى يبان بوضوح إيه اللي ممكن
      // يتعمل دلوقتي. الألوان لسه متضادة تمامًا (أخضر/أحمر) وبرضه فيه
      // الفاصل الزمني (showTransientSuccess) قبل ما زر الانصراف يتفعّل.
      const checkInBtn = el('button', {
        class: 'btn btn-block',
        style: 'background:var(--success);color:#fff;border:none;font-weight:800',
        disabled: !!a.checkedInAt,
        onclick: async () => {
          checkInBtn.disabled = true;
          checkOutBtn.disabled = true;
          try {
            await api('/attendance/check-in', { method: 'POST' });
            await showTransientSuccess('✅ تم تسجيل الحضور بنجاح');
            await render();
          } catch (e) {
            toast(e.message || 'تعذّر تسجيل الحضور', 'error');
            checkInBtn.disabled = !!a.checkedInAt;
            checkOutBtn.disabled = !a.checkedInAt || !!a.checkedOutAt;
          }
        },
      }, ['✅ تسجيل حضور']);
      const checkOutBtn = el('button', {
        class: 'btn btn-block',
        style: 'background:var(--danger);color:#fff;border:none;font-weight:800',
        disabled: !a.checkedInAt || !!a.checkedOutAt,
        onclick: () => handleCheckoutClick(a),
      }, ['🚪 تسجيل انصراف']);
      footer.appendChild(el('div', { class: 'flex gap-8', style: 'width:100%' }, [checkInBtn, checkOutBtn]));
      if (a.checkedInAt && a.checkedOutAt) {
        footer.appendChild(el('div', { class: 'muted mt-8', style: 'width:100%' }, ['تم تسجيل الحضور والانصراف لهذا اليوم.']));
      }
      footer.appendChild(el('button', { class: 'btn btn-outline mt-8', style: 'width:100%', onclick: () => dlg.close() }, ['إغلاق']));
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'error-text' }, [e.message || 'تعذّر تحميل بيانات الحضور']));
      footer.appendChild(el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إغلاق']));
    }
  }
  await render();
}

// ---------------------------------------------------------------------------
// قفل الوصول لأجهزة الكمبيوتر فقط (Desktop-only gate). لا يوجد فحص واحد من
// داخل المتصفح "مضمون ١٠٠٪" ضد شخص عنيد مصمّم على التحايل (أي فحص جافاسكريبت
// يمكن نظريًا تعديله) — لكن الفحوصات دي مجتمعة توقف عمليًا أي موبايل أو تابلت
// عادي حتى في وضع "عرض كموقع كمبيوتر" اللي بيغيّر الـ User-Agent فقط:
//   ١) عند تحميل الصفحة: فحص خصائص الجهاز الحقيقية (pointer:fine، hover،
//      عدم وجود نقاط لمس) قبل حتى إظهار شاشة تسجيل الدخول.
//   ٢) طوال الجلسة (أثناء وبعد تسجيل الدخول): أي حدث لمس فعلي على الشاشة
//      يقفل الجلسة فورًا.
//   ٣) أي تغيّر في اتجاه الشاشة (Portrait/Landscape) — ميزة موجودة فعليًا
//      فقط في الموبايل والتابلت — يقفل الجلسة فورًا أيضًا.
// ---------------------------------------------------------------------------
function isLikelyDesktopDevice() {
  const hasFinePointer = !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
  const supportsHover = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
  const noTouchPoints = !navigator.maxTouchPoints || navigator.maxTouchPoints === 0;
  // أي إشارتين حقيقيتين من الثلاثة كافيتين — لا نثق أبدًا بسلسلة الـ User-Agent وحدها.
  const passing = [hasFinePointer, supportsHover, noTouchPoints].filter(Boolean).length;
  return passing >= 2;
}
App.isLikelyDesktopDevice = isLikelyDesktopDevice;

function showDeviceBlockedScreen(reason) {
  const root = document.getElementById('app') || document.body;
  root.innerHTML = '';
  root.appendChild(
    el('div', { style: 'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center' }, [
      el('div', {}, [
        el('div', { style: 'font-size:44px;margin-bottom:16px' }, ['🖥️']),
        el('div', { style: 'font-size:19px;font-weight:800;margin-bottom:10px' }, ['هذا النظام يعمل من جهاز كمبيوتر (PC) فقط']),
        el('div', { class: 'muted', style: 'max-width:420px;margin:0 auto' }, [
          reason || 'تم رصد أن هذا الجهاز موبايل أو تابلت. لا يمكن استخدام نظام إدارة فريق المبيعات إلا من جهاز كمبيوتر.',
        ]),
      ]),
    ])
  );
}

let deviceGuardStarted = false;
let deviceViolationHandled = false;
async function handleDeviceViolation(reason) {
  if (deviceViolationHandled) return;
  deviceViolationHandled = true;
  if (App.state.user) {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    App.state.user = null;
    try { RT.disconnect(); } catch {}
  }
  showDeviceBlockedScreen(reason);
}

function startDeviceGuard() {
  if (deviceGuardStarted) return;
  deviceGuardStarted = true;
  document.addEventListener('touchstart', () => handleDeviceViolation('تم رصد تفاعل لمس أثناء الجلسة — هذا النظام يعمل من جهاز كمبيوتر فقط.'), { passive: true, capture: true });
  window.addEventListener('orientationchange', () => handleDeviceViolation('تم رصد تغيّر في اتجاه الشاشة — هذا النظام يعمل من جهاز كمبيوتر فقط.'));
  if (window.matchMedia) {
    const mq = window.matchMedia('(orientation: portrait)');
    const onChange = () => handleDeviceViolation('تم رصد تغيّر في اتجاه الشاشة — هذا النظام يعمل من جهاز كمبيوتر فقط.');
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange); // Safari القديم
  }
}

// ---------------------------------------------------------------------------
// الإقلاع
// ---------------------------------------------------------------------------
async function boot() {
  if (!isLikelyDesktopDevice()) {
    showDeviceBlockedScreen();
    return;
  }
  startDeviceGuard();
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
    refreshAttendanceStatus();
  }
  renderRoute();
}

App.route('/login', async () => App.views.login());
window.addEventListener('DOMContentLoaded', boot);
