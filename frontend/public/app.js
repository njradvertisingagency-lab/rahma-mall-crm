// RAHMA MALL — Live Call Team CRM. Frontend SPA (no build step; plain ES modules-free JS).
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
// Tiny event bus so views can react to live WebSocket events without polling.
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
// DOM helpers
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

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
App.fmt = { dateTime: fmtDateTime, date: fmtDate, ago: timeAgo };

const STATUS_LABELS = {
  NEW: 'New', CALLING: 'Calling', NO_ANSWER: 'No Answer', BUSY: 'Busy',
  FOLLOW_UP: 'Follow-up', INTERESTED: 'Interested', NOT_INTERESTED: 'Not Interested', CLOSED: 'Closed',
};
function statusBadge(status) {
  return el('span', { class: 'badge badge-' + status.toLowerCase() }, [STATUS_LABELS[status] || status]);
}
function priorityBadge(p) {
  return el('span', { class: 'badge badge-priority-' + p.toLowerCase() }, [p]);
}
function waBadge(status) {
  const labels = { NOT_CONTACTED: 'لم يتم التواصل', CONTACT_INITIATED: 'تم التواصل واتساب', SENT: 'تم الإرسال', DELIVERED: 'تم التسليم', READ: 'تمت القراءة', FAILED: 'فشل الإرسال' };
  return el('span', { class: 'badge badge-wa-' + status.toLowerCase() }, [labels[status] || status]);
}
function availabilityBadge(a) {
  const cls = { AVAILABLE: 'available', BUSY: 'busy-emp', ON_BREAK: 'on_break', UNAVAILABLE: 'unavailable' }[a] || 'unavailable';
  const labels = { AVAILABLE: 'Available', BUSY: 'Busy', ON_BREAK: 'On Break', UNAVAILABLE: 'Unavailable' };
  return el('span', { class: 'badge badge-' + cls }, [labels[a] || a]);
}
// Real presence — separate from the manual `availability` field above.
function presenceBadge(presence) {
  presence = presence || { online: false, activityState: 'OFFLINE' };
  const state = presence.online ? presence.activityState : 'OFFLINE';
  const cls = { ACTIVE: 'available', IDLE: 'on_break', OFFLINE: 'unavailable' }[state] || 'unavailable';
  const dot = { ACTIVE: '🟢', IDLE: '🟡', OFFLINE: '⚪' }[state] || '⚪';
  const labels = { ACTIVE: 'Active', IDLE: 'Idle', OFFLINE: 'Offline' };
  return el('span', { class: 'badge badge-' + cls }, [dot + ' ' + (labels[state] || state)]);
}
function slaBadge(level) {
  if (!level || level === 'OK') return el('span', { class: 'badge', style: 'background:var(--surface-2);color:var(--muted)' }, ['OK']);
  if (level === 'WARNING') return el('span', { class: 'badge', style: 'background:#fef3c7;color:#92400e' }, ['⚠ Warning']);
  return el('span', { class: 'badge', style: 'background:#fee2e2;color:#991b1b' }, ['🔴 Breached']);
}
function dealStatusBadge(status) {
  const map = {
    NO_PURCHASE: ['—', 'background:var(--surface-2);color:var(--muted)'],
    BRANCH_VISIT: ['🏪 Branch Visit', 'background:#e0e7ff;color:#3730a3'],
    COMPLETED: ['✓ Deal Done', 'background:#dcfce7;color:#166534'],
    CANCELLED: ['✕ Cancelled', 'background:var(--surface-2);color:var(--muted)'],
    REFUNDED: ['↩ Refunded', 'background:#fee2e2;color:#991b1b'],
    PARTIALLY_REFUNDED: ['↩ Partial Refund', 'background:#fef3c7;color:#92400e'],
  };
  const [label, style] = map[status] || [status, ''];
  return el('span', { class: 'badge', style }, [label]);
}
App.badges = { status: statusBadge, priority: priorityBadge, whatsapp: waBadge, availability: availabilityBadge, presence: presenceBadge, sla: slaBadge, dealStatus: dealStatusBadge };

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
// Production is deployed split-origin: the frontend lives on Cloudflare
// Pages (rahma-mall-crm.pages.dev) while the API + WebSocket stay on this
// Worker's own workers.dev domain. Local dev serves both from the same
// origin via wrangler's [assets] binding, so API_BASE/WS_BASE stay empty
// there and every call is same-origin exactly as before.
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
    throw new Error('Not authenticated');
  }
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || 'Request failed';
    throw new Error(message);
  }
  return data;
}
App.api = api;
App.apiBase = API_BASE; // exposed so views can build direct links (CSV export, etc.) that work cross-origin too

// ---------------------------------------------------------------------------
// Toasts
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
// Theme
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
// WebSocket real-time connection
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
      App.emit('ws-reconnected'); // views resync current data on (re)connect
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

// Live notifications: any NOTIFICATION_CREATED / assignment / status event refreshes the bell.
App.on('rt:NOTIFICATION_CREATED', () => { toast('🔔 ' + 'You have a new notification', 'info'); refreshNotifications(); });
App.on('rt:CUSTOMER_ASSIGNED', () => refreshNotifications());
App.on('rt:FOLLOWUP_OVERDUE', () => refreshNotifications());
App.on('rt:CUSTOMER_REASSIGNED', () => refreshNotifications());
App.on('rt:SLA_BREACHED', () => refreshNotifications());
App.on('rt:SLA_WARNING', () => refreshNotifications());

// Sales/Deal-Done toasts — team leader only sees these (server scopes the broadcast).
App.on('rt:DEAL_DONE_CREATED', (p) => { if (App.state.user?.role === 'team_leader') toast(`🎉 Deal Done — ${p.customerId} — ${p.amount} EGP at ${p.branchName || ''}`, 'success'); });
App.on('rt:BRANCH_VISIT_CREATED', (p) => { if (App.state.user?.role === 'team_leader') toast(`🏪 Branch visit — ${p.customerId} at ${p.branchName || ''}`, 'info'); });
App.on('rt:PURCHASE_REFUNDED', (p) => { if (App.state.user?.role === 'team_leader') toast(`↩ Refund recorded — ${p.customerId}`, 'info'); });
App.on('rt:PURCHASE_PARTIALLY_REFUNDED', (p) => { if (App.state.user?.role === 'team_leader') toast(`↩ Partial refund — ${p.customerId}`, 'info'); });

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
// Router
// ---------------------------------------------------------------------------
const ROUTES = [];
// Optional third argument: { roles: ['team_leader'] } restricts a route to those roles.
// This is a UX/defense-in-depth guard only — every mutating (and most reading) endpoint
// is ALSO enforced server-side regardless of what the client renders. But without this,
// an employee who edits the URL hash (e.g. to #/distribute) would still have the full
// page shell built and run its data-loading calls (some of which, like the unassigned
// customers list and full employee roster, are not themselves role-restricted reads),
// exposing information the employee should never see even though the actual mutating
// action would separately 403. So unauthorized routes must never even invoke the handler.
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

// Every route handler may attach a `.cleanup()` to the view it returns (to unsubscribe
// real-time event listeners registered via App.on). The shell itself also subscribes to
// events (connection badge, notification bell) and is fully rebuilt on every navigation.
// Both MUST be torn down before the next render, otherwise listeners accumulate forever
// (each carrying stale DOM references) and eventually throw / leak memory as the user
// navigates around the app.
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
        el('div', { style: 'font-weight:700;margin-bottom:4px' }, ['Access Denied']),
        el('div', { class: 'muted' }, ["You don't have permission to view this page."]),
      ]);
    } else {
      view = match ? await match.handler(match.params) : el('div', {}, ['Not found']);
    }
    content.innerHTML = '';
    content.appendChild(view);
    currentViewCleanup = typeof view.cleanup === 'function' ? view.cleanup : null;
  } catch (err) {
    console.error(err);
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['⚠️']), err.message || 'Something went wrong']));
  }
}
window.addEventListener('hashchange', renderRoute);
App.navigate = (hash) => { location.hash = hash; };

// ---------------------------------------------------------------------------
// App shell (sidebar + topbar)
// ---------------------------------------------------------------------------
const NAV_TL = [
  ['dashboard', '📊', 'Dashboard'],
  ['command-center', '🎛️', 'Command Center'],
  ['customers', '👥', 'Customers'],
  ['import', '📥', 'Import Customers'],
  ['distribute', '🔀', 'Distribute'],
  ['employees', '🧑‍💼', 'Employees'],
  ['followups', '⏰', 'Follow-ups'],
  ['analytics', '📈', 'Analytics'],
  ['leaderboard', '🏆', 'Leaderboard'],
  ['reports', '🧾', 'Reports'],
  ['activity', '🕒', 'Activity Log'],
  ['notifications', '🔔', 'Notifications'],
  ['ai', '🤖', 'AI Assistant'],
  ['settings', '⚙️', 'Settings'],
];
const NAV_EMPLOYEE = [
  ['dashboard', '📊', 'Dashboard'],
  ['work-queue', '🎯', 'My Work Queue'],
  ['my-customers', '👥', 'My Customers'],
  ['followups', '⏰', 'Follow-ups'],
  ['notifications', '🔔', 'Notifications'],
  ['my-performance', '📈', 'My Performance'],
  ['profile', '🙍', 'Profile'],
];

function renderShell() {
  const user = App.state.user;
  const nav = user.role === 'team_leader' ? NAV_TL : NAV_EMPLOYEE;
  const currentPath = (location.hash || '#/dashboard').replace(/^#\//, '').split('/')[0];

  const sidebar = el('div', { class: 'sidebar', id: 'sidebar' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('div', { class: 'logo' }, ['RAHMA MALL']),
      el('div', { class: 'sub' }, ['LIVE CALL TEAM CRM']),
    ]),
    el('div', { class: 'nav' }, nav.map(([path, icon, label]) =>
      el('div', {
        class: 'nav-item' + (currentPath === path ? ' active' : ''),
        onclick: () => { App.navigate('#/' + path); document.getElementById('sidebar').classList.remove('open'); },
      }, [el('span', { class: 'nav-icon' }, [icon]), label])
    )),
    el('div', { class: 'sidebar-footer' }, [
      el('button', { class: 'btn btn-outline btn-block btn-sm', onclick: App.toggleTheme }, [App.state.theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode']),
    ]),
  ]);

  const connBadge = renderConnBadge();
  const notifBell = renderNotifBell();
  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'btn btn-icon sidebar-toggle', onclick: () => document.getElementById('sidebar').classList.toggle('open') }, ['☰']),
    el('div', { class: 'search' }, [
      el('input', {
        placeholder: 'Search phone, ID, name, campaign…', onkeydown: (e) => {
          if (e.key === 'Enter' && e.target.value.trim()) App.navigate('#/customers?q=' + encodeURIComponent(e.target.value.trim()));
        },
      }),
    ]),
    connBadge,
    notifBell,
    el('div', { class: 'flex gap-8', style: 'align-items:center' }, [
      el('div', { class: 'avatar avatar-sm' }, [(user.displayName || '?')[0].toUpperCase()]),
      el('div', {}, [el('div', { style: 'font-weight:700;font-size:13px' }, [user.displayName]), el('div', { class: 'faint' }, [user.role === 'team_leader' ? 'Team Leader' : 'Employee'])]),
      el('button', { class: 'btn btn-outline btn-sm', onclick: doLogout }, ['Logout']),
    ]),
  ]);

  const content = el('div', { class: 'content' });
  const main = el('div', { class: 'main' }, [topbar, content]);
  const root = el('div', { class: 'shell' }, [sidebar, main]);
  const cleanups = [connBadge.offEvt, notifBell.offEvt].filter(Boolean);
  return { root, content, cleanup: () => cleanups.forEach((off) => off()) };
}

function renderConnBadge() {
  const wrap = el('div', { class: 'conn-badge conn-' + App.state.wsStatus.toLowerCase() }, [
    el('span', { class: 'dot' + (App.state.wsStatus === 'LIVE' ? ' pulse' : '') }),
    App.state.wsStatus === 'LIVE' ? 'LIVE' : App.state.wsStatus === 'RECONNECTING' ? 'RECONNECTING' : 'OFFLINE',
  ]);
  wrap.offEvt = App.on('ws-status', () => {
    wrap.className = 'conn-badge conn-' + App.state.wsStatus.toLowerCase();
    wrap.innerHTML = '';
    wrap.appendChild(el('span', { class: 'dot' + (App.state.wsStatus === 'LIVE' ? ' pulse' : '') }));
    wrap.appendChild(document.createTextNode(App.state.wsStatus === 'LIVE' ? 'LIVE' : App.state.wsStatus === 'RECONNECTING' ? 'RECONNECTING' : 'OFFLINE'));
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
// Boot
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
