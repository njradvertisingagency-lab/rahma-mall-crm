// رحمة مول — نظام إدارة فريق المبيعات المباشر. واجهة الموقع (بدون خطوة بناء).
'use strict';

const App = (window.App = {
  state: {
    user: null,
    theme: localStorage.getItem('rm_theme') || 'light',
    wsStatus: 'OFFLINE', // LIVE | RECONNECTING | OFFLINE
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
// التحديث التلقائي اتلغى بالكامل لتوفير قراءات قاعدة البيانات — التحديث بقى يدوي
// بزرار 🔄 في الشريط العلوي. الدالة فاضلة كـ no-op عشان كل الصفحات اللي بتناديها
// ما تتكسرش (بترجع دالة إلغاء فاضية).
App.onRealtime = () => () => {};

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
    // نداءات الخلفية الصامتة (إشعارات/دردشة غير مقروءة/نبضة تواجد) بتتنفّذ
    // تلقائيًا مع كل فتح للتطبيق ومُلفوفة أصلًا بـ try/catch بتتجاهل أي خطأ
    // منها بصمت — فمفيش أي داعي (ولا صح) إن فشلها يمسح الشاشة كلها بشاشة
    // "النظام مغلق" الكاملة. الشاشة الكاملة دي تفضل فقط لما يكون طلب تحميل
    // محتوى صفحة فعلية هو اللي اتمنع (opts.background غير مُمرَّرة).
    if (!opts.background) showShiftClosedScreen(data.error);
    throw new Error(data.error.message || 'النظام مغلق حاليًا');
  }
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || 'فشل الطلب';
    throw new Error(message);
  }
  // الخادم يرد بآخر نسخة معروفة من البيانات إذا تعذّر الوصول لقاعدة البيانات،
  // ويضع stale: true. لا يصح أن يتصرّف الفريق في بيانات عميل دون أن يعرف أنها
  // قد تكون قديمة — ننبّه مرة واحدة كل دقيقة حتى لا يتحوّل التنبيه إلى إزعاج.
  return data;
}

// النظام مغلق خارج مواعيد العمل لغير التيم ليدر والمالك (يوفّر استهلاك قاعدة
// البيانات). الأصل كان بيمسح #app بالكامل — الشريط الجانبي والعلوي والمحتوى
// مع بعض — لكن ده كان معناه إن أي طلب بيانات عادي لصفحة (مثل إحصائيات
// الداشبورد) يفشل بعد الساعة 6 فيقفل الشاشة كلها، بما فيها زر "البصمة" في
// الشريط العلوي نفسه — رغم إن الانصراف لسه مسموح فعليًا لحد 8 مساءً. الحل:
// لو القالب العام (renderShell) اتعرض بالفعل ومنطقة المحتوى (activeContentEl)
// موجودة، امسح منطقة المحتوى بس واترك الشريط العلوي/الجانبي شغالين — الموظف
// يقدر يضغط "البصمة" عادي حتى لو محتوى الصفحة نفسها مقفول. الشاشة الكاملة
// القديمة (بإعادة تحميل تلقائية كل دقيقة) تفضل موجودة كحل احتياطي فقط لو
// حصل الرفض قبل ما أي قالب يتعرض أصلًا (مثلاً فشل /auth/me أثناء الإقلاع).
let activeContentEl = null;
let shiftClosedShown = false;
function showShiftClosedScreen(err) {
  if (activeContentEl && document.contains(activeContentEl)) {
    activeContentEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:60px 24px;text-align:center;direction:rtl;font-family:inherit;';
    wrap.innerHTML =
      '<div style="font-size:44px;margin-bottom:12px">🔒</div>' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:8px">هذه الصفحة غير متاحة الآن</div>' +
      '<div style="color:var(--muted,#666);line-height:1.8;font-size:14px;max-width:420px;margin:0 auto">' + (err.message || '') + '</div>';
    activeContentEl.appendChild(wrap);
    return;
  }
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

// تم إلغاء خاصية الإشعارات بالكامل (الجرس/الصفحة/التنبيهات) لتوفير قراءات قاعدة البيانات.
// الدالة فاضلة كـ no-op عشان أي استدعاء قديم ما يكسرش.

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
    // مفيش قالب عام (شريط علوي/جانبي) في شاشة تسجيل الدخول — أي رفض
    // OUTSIDE_WORK_HOURS هنا (مثلاً من /auth/employees-public) يرجع للشاشة
    // الكاملة الاحتياطية بدل منطقة محتوى مش موجودة أصلًا.
    activeContentEl = null;
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
  // القالب العام (الشريط العلوي بزر "البصمة" والشريط الجانبي) اتعرض بالفعل —
  // من هنا فصاعدًا أي رفض OUTSIDE_WORK_HOURS من تحميل بيانات الصفحة يُعرض
  // داخل منطقة المحتوى فقط (انظر showShiftClosedScreen)، ويفضل زر البصمة
  // شغالًا حتى لو محتوى الصفحة نفسها مقفول خارج ساعات العمل.
  activeContentEl = content;
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
    // .page-anim عنصر جديد تمامًا في كل تنقّل (زي content نفسها) — فحركة
    // الدخول السينيمائية (تعريفها في styles.css) بتتشغّل تلقائيًا كل مرة
    // بدون أي تعقيد إضافي أو مؤقّتات يدوية.
    const pageWrap = el('div', { class: 'page-anim' }, [view]);
    content.appendChild(pageWrap);
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
// قائمة قائد الفريق العادي (المبيعات) — نفس القائمة الحصرية اللي حددها صاحب
// الشركة، لكن "مركز التحكم" اترجّع تاني للاتنين (TL وHR) بناءً على طلب
// صريح لاحق. مفيهاش الدردشة، التقارير، سجل الأنشطة، المساعد الذكي،
// الإعدادات، المتابعات، ولا تقويم المتابعات — دي لسه حصرًا لحساب
// الـ HR/الأدمن (NAV_ADMIN). "الإجازات والغياب" اتضافت هنا كبند مشترك
// (يشوفه TL وHR الاتنين)، لكن التيم ليدر العادي يشوفها بس من غير ما يقدر
// يوافق/يرفض على طلبات الإجازة (شوف views-leaves.js).
const NAV_TL = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['accounting-files', '🗃️', 'ملفات العملاء'],
  ['command-center', '🎛️', 'مركز التحكم'],
  ['customers', '👥', 'العملاء'],
  ['import', '📥', 'استيراد عملاء'],
  ['distribute', '🔀', 'توزيع العملاء'],
  ['today-leads', '📞', 'أرقام اليوم'],
  ['team-performance', '🏅', 'أداء الفريق'],
  ['employees', '🧑‍💼', 'خدمة العملاء'],
  ['file-movements', '📂', 'حركة الملفات'],
];

// حساب الموارد البشرية (isHr=1) — نفس role='team_leader' في قاعدة البيانات،
// لكن قائمة مختلفة تمامًا: كل شغل الموارد البشرية (الإجازات، التقييم،
// المخالفات، التدريب، المستندات، المزايا، الإعلانات) + الموظفين كملف
// أساسي، بدون أي وصول لشغل المبيعات/CRM (العملاء، التوزيع، التحليلات...).
const NAV_HR = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['accounting-files', '🗃️', 'ملفات العملاء'],
  ['employees', '🧑‍💼', 'خدمة العملاء'],
  ['file-movements', '📂', 'حركة الملفات'],
];

// حساب "admin" (👑 الرؤية الشاملة، is_owner=1) — god-view كامل للشركة:
// كل بنود المبيعات/CRM (NAV_TL) + كل بنود الموارد البشرية (NAV_HR) في
// قائمة واحدة مدمجة، بدون أي قفل. هذا هو حساب المالك الفعلي بعد التحديث —
// وصول تشغيلي كامل، مش عرض فقط زي الحساب القديم.
const NAV_ADMIN = [
  ['accounting-files', '🗃️', 'الحسابات — الملفات'],
  ['file-movements', '📂', 'حركة الملفات'],
  ['dashboard', '📊', 'لوحة التحكم'],
  ['command-center', '🎛️', 'مركز التحكم'],
  ['customers', '👥', 'العملاء'],
  ['import', '📥', 'استيراد عملاء'],
  ['distribute', '🔀', 'توزيع العملاء'],
  ['today-leads', '📞', 'أرقام اليوم'],
  ['team-performance', '🏅', 'أداء الفريق'],
  ['employees', '🧑‍💼', 'خدمة العملاء'],
  ['followups', '⏰', 'المتابعات'],
  ['reports', '🧾', 'التقارير'],
  ['activity', '🕒', 'سجل الأنشطة'],
  ['settings', '⚙️', 'الإعدادات'],
];
// موظفو الحسابات (department='accounting') — قائمة خاصة بقسم الحسابات فقط:
// الداشبورد + ملفات العملاء + حركة الملفات + البصمة/الحضور + الإجازات
// + الإشعارات + الملف الشخصي. لا يوجد وصول لأي شيء في المبيعات/CRM.
const NAV_ACCOUNTING = [
  ['accounting-files', '🗃️', 'ملفات العملاء'],
  ['file-movements', '📂', 'حركة الملفات'],
  ['import', '📥', 'استيراد عملاء'],
  ['distribute', '🔀', 'توزيع العملاء'],
  ['today-leads', '📞', 'أرقام اليوم'],
  ['team-performance', '🏅', 'أداء الفريق'],
  ['reports', '🧾', 'التقارير'],
  ['dashboard', '📊', 'لوحة التحكم'],
  ['payroll-salaries', '💰', 'تكوين الرواتب'],
  ['payroll-runs', '📋', 'دورات المرتبات'],
  ['profile', '🙍', 'الملف الشخصي'],
];

// موظفو الشئون القانونية (department='legal') — نفس صفحات الحسابات تقريبًا:
// الداشبورد + ملفات العملاء + حركة الملفات + الإجازات + الإشعارات + الملف الشخصي.
const NAV_LEGAL = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['accounting-files', '🗃️', 'ملفات العملاء'],
  ['file-movements', '📂', 'حركة الملفات'],
  ['profile', '🙍', 'الملف الشخصي'],
];

const NAV_EMPLOYEE = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['my-files', '🗃️', 'ملفاتي'],
  ['my-customers', '👥', 'عملائي'],
  ['followups', '⏰', 'المتابعات'],
  ['my-performance', '📈', 'أدائي'],
  ['profile', '🙍', 'الملف الشخصي'],
];
function renderShell() {
  const user = App.state.user;
  const isAdmin = !!user.isOwner; // حساب "admin" — الرؤية الشاملة (god-view)
  // الـ HR أعلى من قائد الفريق في الهرم: يشوف كل حاجة (مبيعات + HR)، فقائمته
  // بقت زي قائمة الأدمن بالظبط (بدون المظهر الذهبي المميز اللي يفضل لحساب
  // الأدمن/المالك فقط). قائد الفريق العادي لسه يشوف مبيعاته بس.
  const nav = user.role === 'team_leader'
    ? ((isAdmin || user.isHr) ? NAV_ADMIN : NAV_TL)
    : (user.department === 'accounting' ? NAV_ACCOUNTING
       : user.department === 'legal' ? NAV_LEGAL
       : NAV_EMPLOYEE);
  const currentPath = (location.hash || '#/dashboard').replace(/^#\//, '').split('/')[0];

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
    el('div', { class: 'nav' }, [el('div', { class: 'nav-item nav-calc', onclick: () => { openInstallmentCalculator(); document.getElementById('sidebar').classList.remove('open'); } }, [
      el('span', { class: 'nav-icon' }, ['🧮']),
      'حاسبة الأقساط',
    ])].concat(nav.map(([path, icon, label]) =>
      el('div', {
        class: 'nav-item' + (currentPath === path ? ' active' : ''),
        onclick: () => { App.navigate('#/' + path); document.getElementById('sidebar').classList.remove('open'); },
      }, [
        el('span', { class: 'nav-icon', style: 'position:relative' }, [icon]),
        label,
      ])
    ))),
    el('div', { class: 'sidebar-footer' }, [
      el('button', { class: 'btn btn-outline btn-block btn-sm', onclick: App.toggleTheme }, [App.state.theme === 'dark' ? '☀️ الوضع الفاتح' : '🌙 الوضع الداكن']),
      el('div', { class: 'dev-credit' }, ['Developed by Ahmed Nagy']),
    ]),
  ]);

  const connBadge = renderConnBadge();
  const adminReportsBtn = renderAdminReportsButton();
  const refreshBtn = renderRefreshBtn();
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
      el('button', { class: 'btn btn-outline btn-sm calc-topbtn', title: 'حاسبة الأقساط', onclick: openInstallmentCalculator }, ['🧮 حاسبة الأقساط']),
      connBadge,
      refreshBtn,
      attendanceBtn,
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
  const cleanups = [connBadge.offEvt, refreshBtn.offEvt, attendanceBtn && attendanceBtn.offEvt].filter(Boolean);
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


// زرار التحديث اليدوي — بديل التحديث التلقائي اللي اتلغى لتوفير القراءات.
// freshNext بتخلي لوحة التحكم تتخطى الكاش المؤقت وتجيب أرقام جديدة.
function renderRefreshBtn() {
  const btn = el('button', {
    class: 'btn btn-icon refresh-btn' + (App.state.pendingAssign ? ' refresh-needed' : ''),
    title: 'تحديث الصفحة',
    onclick: () => { App.state.pendingAssign = false; btn.classList.remove('refresh-needed'); App.freshNext = true; renderRoute(); },
  }, ['🔄']);
  btn.offEvt = App.on('assign-pending', () => { btn.classList.toggle('refresh-needed', !!App.state.pendingAssign); });
  return btn;
}

// تنبيه خفيف بدون أي قراءة من القاعدة: السيرفر بيبعت حدث لحظي (WebSocket)
// للموظف لما يتوزع عليه أرقام، فبنظهر نقطة حمراء على 🔄 ورسالة مرة واحدة.
// مفيش تحميل للقائمة إلا لما الموظف نفسه يضغط 🔄.
function onAssignmentEvent() {
  if (App.state.user?.role !== 'employee') return;
  const first = !App.state.pendingAssign;
  App.state.pendingAssign = true;
  App.emit('assign-pending');
  if (first) toast('📥 اتوزع عليك أرقام جديدة — اضغط 🔄 لتحديث القائمة', 'success');
}
App.on('rt:CUSTOMER_ASSIGNED', onAssignmentEvent);
App.on('rt:CUSTOMER_REASSIGNED', onAssignmentEvent);

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
  try { await api('/presence/heartbeat', { method: 'POST', background: true }); } catch {}
}
App.startPresenceHeartbeat = function () {
  if (presenceHeartbeatStarted) return;
  presenceHeartbeatStarted = true;
  lastUserActivityAt = Date.now(); // أول نبضة فورية عند تسجيل الدخول/فتح الصفحة، دون انتظار دقيقة كاملة
  sendPresenceHeartbeatIfActive();
  setInterval(sendPresenceHeartbeatIfActive, 180 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sendPresenceHeartbeatIfActive(); });
};

// ---------------------------------------------------------------------------
// تقارير الإدارة (بداية اليوم / نهاية الشيفت) — زر في الشريط العلوي يظهر فقط
// لحساب المالك (is_owner — حساب أستاذ هاني) ولا يظهر أبدًا لحساب قائد الفريق
// العادي. البيانات تُحسب حيًّا من الخادم في كل ضغطة، بالإضافة لإشعار تلقائي
// يومي مرة عند بداية الدوام ومرة عند نهايته (انظر worker/src/lib/opsreports.js).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// حاسبة أقساط العملاء — حساب لحظي في المتصفح بس (مفيش أي قراءة/كتابة في القاعدة).
// المقدم ٢٠٪ من المبلغ، والفايدة نسبة كلية على المتبقي (بعد المقدم) عن المدة كلها.
// ---------------------------------------------------------------------------
const INSTALLMENT_DOWN_PCT = 0.2;
const INSTALLMENT_PLANS = [
  { years: 1, rate: 0.3, label: 'سنة' },
  { years: 2, rate: 0.45, label: 'سنتين' },
  { years: 3, rate: 0.55, label: '٣ سنين' },
  { years: 4, rate: 0.65, label: '٤ سنين' },
];
const moneyFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function calcInstallment(amount, plan) {
  const down = amount * INSTALLMENT_DOWN_PCT;
  const financed = amount - down;
  const totalFinanced = financed * (1 + plan.rate);
  const months = plan.years * 12;
  return { down, financed, months, totalFinanced, monthly: totalFinanced / months, grandTotal: down + totalFinanced };
}

// بيقبل أرقام عربية وفواصل (٥٠٬٠٠٠ أو 50,000) ويرجّع رقم أو 0.
function parseAmountInput(raw) {
  const latin = String(raw || '')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[,٬،\s]/g, '')
    .replace(/٫/g, '.');
  const n = parseFloat(latin);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function openInstallmentCalculator() {
  if (document.querySelector('.calc-modal')) return;
  let plan = INSTALLMENT_PLANS[0];
  const input = el('input', { class: 'calc-input', type: 'text', inputmode: 'decimal', dir: 'ltr', placeholder: 'اكتب المبلغ — مثال 50000', autocomplete: 'off' });
  const chips = INSTALLMENT_PLANS.map((p) =>
    el('button', { type: 'button', class: 'calc-chip' + (p === plan ? ' active' : ''), onclick: () => { plan = p; chips.forEach((c, i) => c.classList.toggle('active', INSTALLMENT_PLANS[i] === p)); render(); } }, [p.label])
  );
  const result = el('div', { class: 'calc-result' });
  const compare = el('div', { class: 'calc-compare' });

  function row(label, value, cls) {
    return el('div', { class: 'calc-row' + (cls ? ' ' + cls : '') }, [el('span', {}, [label]), el('b', {}, [value])]);
  }
  function render() {
    const amount = parseAmountInput(input.value);
    result.innerHTML = '';
    compare.innerHTML = '';
    if (!amount) {
      result.appendChild(el('div', { class: 'calc-empty' }, ['اكتب المبلغ واختار المدة عشان يظهرلك القسط فورًا']));
      return;
    }
    const r = calcInstallment(amount, plan);
    result.appendChild(el('div', { class: 'calc-monthly' }, [
      el('div', { class: 'calc-monthly-label' }, ['العميل هيدفع كل شهر']),
      el('div', { class: 'calc-monthly-value' }, [moneyFmt.format(Math.round(r.monthly)) + ' ج']),
      el('div', { class: 'calc-monthly-sub' }, ['لمدة ' + plan.label + ' (' + r.months + ' شهر)']),
    ]));
    result.appendChild(row('المقدم (٢٠٪)', moneyFmt.format(Math.round(r.down)) + ' ج'));
    result.appendChild(row('المتبقي بعد المقدم', moneyFmt.format(Math.round(r.financed)) + ' ج'));
    result.appendChild(row('الفايدة (' + Math.round(plan.rate * 100) + '٪)', moneyFmt.format(Math.round(r.financed * plan.rate)) + ' ج'));
    result.appendChild(row('إجمالي اللي هيتدفع (مع المقدم)', moneyFmt.format(Math.round(r.grandTotal)) + ' ج', 'calc-total'));
    compare.appendChild(el('div', { class: 'calc-compare-title' }, ['مقارنة كل المدد']));
    INSTALLMENT_PLANS.forEach((p) => {
      const c = calcInstallment(amount, p);
      compare.appendChild(el('div', { class: 'calc-compare-row' + (p === plan ? ' active' : ''), onclick: () => { plan = p; chips.forEach((ch, i) => ch.classList.toggle('active', INSTALLMENT_PLANS[i] === p)); render(); } }, [
        el('span', {}, [p.label]),
        el('b', {}, [moneyFmt.format(Math.round(c.monthly)) + ' ج شهريًا']),
      ]));
    });
  }
  input.addEventListener('input', render);

  const body = el('div', { class: 'calc-body' }, [
    el('label', { class: 'calc-label' }, ['المبلغ']),
    input,
    el('label', { class: 'calc-label' }, ['مدة التقسيط']),
    el('div', { class: 'calc-chips' }, chips),
    result,
    compare,
  ]);
  const m = modal('🧮 حاسبة الأقساط', body, []);
  m.el.classList.add('calc-modal');
  const onKey = (e) => { if (e.key === 'Escape') m.close(); };
  document.addEventListener('keydown', onKey);
  new MutationObserver((_, obs) => { if (!m.el.isConnected) { document.removeEventListener('keydown', onKey); obs.disconnect(); } }).observe(document.body, { childList: true });
  render();
  input.focus();
}
App.openInstallmentCalculator = openInstallmentCalculator;

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

// رسالة ترحيب عند تسجيل الحضور بالبصمة — لطيفة ومعنوية ومحفزة، بلا أي لوم
// أو إشارة للتأخير (ده موجود بوضوح في بيانات الحالة تحت لمن يحتاجها)، وبتتغيّر
// عشوائيًا كل مرة عشان تفضل حقيقية ومش رتيبة زي رسالة نظام جامدة.
const CHECK_IN_GREETINGS = [
  '✅ تم تسجيل حضورك — يومك النهارده هيبقى مليان إنجاز يا بطل 🌟',
  '✅ حضورك اتسجّل! يلا نبدأ بطاقة وحماس — إنت قد أي تحدي 💪',
  '✅ أهلًا بيك من جديد! ربنا يوفقك في يوم شغل ناجح ومثمر ✨',
  '✅ تم تسجيل الحضور بنجاح — ثقتنا فيك كبيرة، خليها سنة حلوة 🌸',
  '✅ يومك بدأ رسميًا! كل عميل النهارده فرصة تفرق فيها 🚀',
  '✅ حضورك اتسجّل — خد نفسك، ابتسم، وابدأ يومك بطاقة إيجابية 😊',
  '✅ تم التسجيل بنجاح! إنت جزء مهم من نجاح الفريق النهارده وكل يوم 🙌',
];
function randomCheckInGreeting() {
  return CHECK_IN_GREETINGS[Math.floor(Math.random() * CHECK_IN_GREETINGS.length)];
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
    // سبب الانصراف المبكر مطلوب — هيوصل تلقائيًا لأستاذ هاني والـHR وقائد
    // الفريق (طلب صاحب الشركة صراحةً)، فمفيش تسجيل انصراف مبكر من غيره.
    const reasonBox = el('textarea', { rows: 3, placeholder: 'اكتب سبب الانصراف المبكر هنا (مطلوب)…', style: 'width:100%' });
    body.appendChild(el('div', { class: 'field', style: 'margin-top:10px;text-align:right' }, [
      el('label', {}, ['سبب الانصراف المبكر']),
      reasonBox,
    ]));
    const confirmBtn = el('button', { class: 'btn', style: 'background:var(--danger);color:#fff;border:none;font-weight:800', onclick: () => doCheckout(confirmBtn, reasonBox.value.trim()) }, ['تأكيد الانصراف المبكر']);
    footer.appendChild(confirmBtn);
    footer.appendChild(el('button', { class: 'btn btn-outline', onclick: () => render() }, ['رجوع']));
  }

  async function doCheckout(btn, reason) {
    // "reason" being passed at all (even as an empty string) means this came
    // from the early-checkout confirmation dialog, where it's required —
    // the plain on-time checkout button never passes a second argument.
    if (arguments.length > 1 && !reason) {
      toast('برجاء كتابة سبب الانصراف المبكر', 'error');
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await api('/attendance/check-out', { method: 'POST', body: reason ? { reason } : {} });
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
            await showTransientSuccess(randomCheckInGreeting());
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
  // جهاز كمبيوتر فعلي (ماوس دقيق + hover) حتى لو عنده شاشة لمس (لابتوب تاتش) أو
  // نافذة ضيقة بسبب لوحة جانبية — مفيش داعي نقفل الجلسة. الموبايل/التابلت
  // (pointer:coarse وبدون hover) لسه بيتقفلوا زي الأول.
  if (isLikelyDesktopDevice()) return;
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
    refreshAttendanceStatus();
  }
  renderRoute();
}

App.route('/login', async () => App.views.login());
window.addEventListener('DOMContentLoaded', boot);
