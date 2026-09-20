// رحمة مول — نظام إدارة فريق المكالمات المباشر. واجهة الموقع (بدون خطوة بناء).
'use strict';

const App = (window.App = {
  state: {
    user: null,
    theme: localStorage.getItem('rm_theme') || 'light',
    wsStatus: 'OFFLINE', // LIVE | RECONNECTING | OFFLINE
    notifications: [],
    unreadCount: 0,
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
App.fmt = { dateTime: fmtDateTime, date: fmtDate, ago: timeAgo };

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
  if (level === 'WARNING') return el('span', { class: 'badge', style: 'background:#fef3c7;color:#92400e' }, ['⚠ اقترب الموعد']);
  return el('span', { class: 'badge', style: 'background:#fee2e2;color:#991b1b' }, ['🔴 تم تجاوز الموعد']);
}
function dealStatusBadge(status) {
  const map = {
    NO_PURCHASE: ['—', 'background:var(--surface-2);color:var(--muted)'],
    BRANCH_VISIT: ['🏪 زيارة فرع', 'background:#e0e7ff;color:#3730a3'],
    COMPLETED: ['✓ تمت الصفقة', 'background:#dcfce7;color:#166534'],
    CANCELLED: ['✕ ملغاة', 'background:var(--surface-2);color:var(--muted)'],
    REFUNDED: ['↩ مسترجعة', 'background:#fee2e2;color:#991b1b'],
    PARTIALLY_REFUNDED: ['↩ استرجاع جزئي', 'background:#fef3c7;color:#92400e'],
  };
  const [label, style] = map[status] || [status, ''];
  return el('span', { class: 'badge', style }, [label]);
}
App.badges = { status: statusBadge, priority: priorityBadge, whatsapp: waBadge, availability: availabilityBadge, presence: presenceBadge, sla: slaBadge, dealStatus: dealStatusBadge };
App.labels = { status: STATUS_LABELS, priority: PRIORITY_LABELS };

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

// الإشعارات المباشرة: أي حدث تعيين/حالة جديد يُحدّث الجرس فورًا.
App.on('rt:NOTIFICATION_CREATED', () => { toast('🔔 لديك إشعار جديد', 'info'); refreshNotifications(); });
App.on('rt:CUSTOMER_ASSIGNED', () => refreshNotifications());
App.on('rt:FOLLOWUP_OVERDUE', () => refreshNotifications());
App.on('rt:CUSTOMER_REASSIGNED', () => refreshNotifications());
App.on('rt:SLA_BREACHED', () => refreshNotifications());
App.on('rt:SLA_WARNING', () => refreshNotifications());

// إشعارات الصفقات — يراها قائد الفريق فقط (السيرفر يحدد من يستقبل البث).
App.on('rt:DEAL_DONE_CREATED', (p) => { if (App.state.user?.role === 'team_leader') toast(`🎉 تمت صفقة — ${p.customerId} — ${p.amount} ج.م في ${p.branchName || ''}`, 'success'); });
App.on('rt:BRANCH_VISIT_CREATED', (p) => { if (App.state.user?.role === 'team_leader') toast(`🏪 زيارة فرع — ${p.customerId} في ${p.branchName || ''}`, 'info'); });
App.on('rt:PURCHASE_REFUNDED', (p) => { if (App.state.user?.role === 'team_leader') toast(`↩ تم تسجيل استرجاع — ${p.customerId}`, 'info'); });
App.on('rt:PURCHASE_PARTIALLY_REFUNDED', (p) => { if (App.state.user?.role === 'team_leader') toast(`↩ استرجاع جزئي — ${p.customerId}`, 'info'); });

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
  const path = hash.replace(/^#/, '') || '/dashboard';
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

// ---------------------------------------------------------------------------
// القالب العام للموقع (الشريط الجانبي والشريط العلوي)
// ---------------------------------------------------------------------------
const NAV_TL = [
  ['dashboard', '📊', 'لوحة التحكم'],
  ['command-center', '🎛️', 'مركز التحكم'],
  ['customers', '👥', 'العملاء'],
  ['import', '📥', 'استيراد عملاء'],
  ['distribute', '🔀', 'توزيع العملاء'],
  ['employees', '🧑‍💼', 'الموظفين'],
  ['followups', '⏰', 'المتابعات'],
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
  ['followups', '⏰', 'المتابعات'],
  ['notifications', '🔔', 'الإشعارات'],
  ['my-performance', '📈', 'أدائي'],
  ['profile', '🙍', 'الملف الشخصي'],
];

function renderShell() {
  const user = App.state.user;
  const nav = user.role === 'team_leader' ? NAV_TL : NAV_EMPLOYEE;
  const currentPath = (location.hash || '#/dashboard').replace(/^#\//, '').split('/')[0];

  const sidebar = el('div', { class: 'sidebar', id: 'sidebar' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('div', { class: 'logo' }, ['رحمة مول']),
      el('div', { class: 'sub' }, ['نظام إدارة فريق المكالمات']),
    ]),
    el('div', { class: 'nav' }, nav.map(([path, icon, label]) =>
      el('div', {
        class: 'nav-item' + (currentPath === path ? ' active' : ''),
        onclick: () => { App.navigate('#/' + path); document.getElementById('sidebar').classList.remove('open'); },
      }, [el('span', { class: 'nav-icon' }, [icon]), label])
    )),
    el('div', { class: 'sidebar-footer' }, [
      el('button', { class: 'btn btn-outline btn-block btn-sm', onclick: App.toggleTheme }, [App.state.theme === 'dark' ? '☀️ الوضع الفاتح' : '🌙 الوضع الداكن']),
    ]),
  ]);

  const connBadge = renderConnBadge();
  const notifBell = renderNotifBell();
  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'btn btn-icon sidebar-toggle', onclick: () => document.getElementById('sidebar').classList.toggle('open') }, ['☰']),
    el('div', { class: 'search' }, [
      el('input', {
        placeholder: 'ابحث بالهاتف، الكود، الاسم، الحملة…', onkeydown: (e) => {
          if (e.key === 'Enter' && e.target.value.trim()) App.navigate('#/customers?q=' + encodeURIComponent(e.target.value.trim()));
        },
      }),
    ]),
    connBadge,
    notifBell,
    el('div', { class: 'flex gap-8', style: 'align-items:center' }, [
      el('div', { class: 'avatar avatar-sm' }, [(user.displayName || '?')[0].toUpperCase()]),
      el('div', {}, [el('div', { style: 'font-weight:700;font-size:13px' }, [user.displayName]), el('div', { class: 'faint' }, [user.role === 'team_leader' ? 'قائد الفريق' : 'موظف'])]),
      el('button', { class: 'btn btn-outline btn-sm', onclick: doLogout }, ['تسجيل خروج']),
    ]),
  ]);

  const content = el('div', { class: 'content' });
  const main = el('div', { class: 'main' }, [topbar, content]);
  const root = el('div', { class: 'shell' }, [sidebar, main]);
  const cleanups = [connBadge.offEvt, notifBell.offEvt].filter(Boolean);
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
    refreshNotifications();
  }
  renderRoute();
}

App.route('/login', async () => App.views.login());
window.addEventListener('DOMContentLoaded', boot);
