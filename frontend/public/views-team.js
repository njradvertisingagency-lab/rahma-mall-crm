'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  App.route('/employees', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Employees'])]));
    const grid = el('div', { class: 'kpi-grid' });
    container.appendChild(grid);

    async function load() {
      const { employees, weights } = await api('/employees');
      grid.innerHTML = '';
      employees.forEach((e) => {
        const card = el('div', { class: 'card card-pad' });
        card.appendChild(el('div', { class: 'flex-between' }, [
          el('div', { class: 'flex gap-8', style: 'align-items:center' }, [el('div', { class: 'avatar' }, [e.name[0]]), el('div', {}, [el('div', { style: 'font-weight:800' }, [e.name]), e.nameAr ? el('div', { class: 'faint' }, [e.nameAr]) : null])]),
        ]));
        card.appendChild(el('div', { class: 'mt-12' }, [badges.availability(e.availability)]));
        card.appendChild(el('div', { class: 'mt-12', style: 'font-size:12.5px' }, [
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['Assigned']), String(e.assigned)]),
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['Closed']), String(e.closed)]),
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['Follow-ups']), `${e.followupsCompleted}/${e.followupsTotal}`]),
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['Overdue']), String(e.followupsOverdue)]),
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['Score']), String(e.performanceScore)]),
        ]));
        card.appendChild(el('div', { class: 'field mt-12' }, [
          el('label', {}, ['Availability']),
          el('select', { onchange: async (ev) => { await api('/employees/' + e.id, { method: 'PATCH', body: { availability: ev.target.value } }); toast('Availability updated', 'success'); load(); } },
            ['AVAILABLE', 'BUSY', 'ON_BREAK', 'UNAVAILABLE'].map((a) => el('option', { value: a, selected: a === e.availability || undefined }, [a]))),
        ]));
        card.appendChild(el('button', { class: 'btn btn-sm btn-outline btn-block', onclick: async () => { await api('/employees/' + e.id, { method: 'PATCH', body: { active: !e.active } }); load(); } }, [e.active === false ? 'Activate' : 'Deactivate']));
        grid.appendChild(card);
      });
    }
    await load();
    const off = App.on('rt:EMPLOYEE_AVAILABILITY_CHANGED', load);
    container.cleanup = () => off();
    return container;
  }, { roles: ['team_leader'] });

  App.route('/followups', async () => {
    const container = el('div');
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Follow-ups'])]));
    const filterBar = el('div', { class: 'filters-bar' });
    const sel = el('select', {}, [['ALL', 'All'], ['OPEN', 'Open'], ['COMPLETED', 'Completed'], ['CANCELLED', 'Cancelled']].map(([v, l]) => el('option', { value: v }, [l])));
    filterBar.appendChild(sel);
    const overdueCheckbox = el('input', { type: 'checkbox', checked: params.get('overdue') === 'true' || undefined });
    const overdueOnly = el('label', { class: 'checkbox-row' }, [overdueCheckbox, 'Overdue only']);
    filterBar.appendChild(overdueOnly);
    filterBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: load }, ['Apply']));
    container.appendChild(filterBar);
    const box = el('div');
    container.appendChild(box);

    async function load() {
      const q = new URLSearchParams();
      if (sel.value !== 'ALL') q.set('status', sel.value);
      if (overdueCheckbox.checked) q.set('overdue', 'true');
      const { followups } = await api('/followups?' + q.toString());
      box.innerHTML = '';
      if (followups.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['No follow-ups to show.'])); return; }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(App.state.user.role === 'team_leader' ? ['Employee'] : []), 'Customer', 'Phone', 'Scheduled', 'Reason', 'Status', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, followups.map((f) => el('tr', {}, [
            ...(App.state.user.role === 'team_leader' ? [el('td', {}, [f.employeeName || '—'])] : []),
            el('td', {}, [el('a', { href: '#/customers/' + f.customerId }, [f.customerName || f.customerId])]),
            el('td', { class: 'mono' }, [f.customerPhone || '']),
            el('td', {}, [fmt.dateTime(f.scheduledFor)]),
            el('td', {}, [f.reason || '—']),
            el('td', {}, [el('span', { class: 'badge badge-' + (f.status === 'OVERDUE' ? 'overdue' : f.status.toLowerCase()) }, [f.status])]),
            el('td', {}, [f.status === 'UPCOMING' || f.status === 'DUE' || f.status === 'OVERDUE' ? el('button', { class: 'btn btn-sm btn-success', onclick: async () => { await api('/followups/' + f.id + '/complete', { method: 'POST' }); load(); } }, ['Complete']) : '']),
          ]))),
        ]),
      ]));
    }
    await load();
    const off = App.on('rt:*', load);
    container.cleanup = () => off();
    return container;
  });

  App.route('/notifications', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['Notifications']),
      el('button', { class: 'btn btn-outline', onclick: async () => { await api('/notifications/mark-all-read', { method: 'POST' }); App.refreshNotifications(); load(); } }, ['Mark all read']),
    ]));
    const box = el('div');
    container.appendChild(box);
    async function load() {
      const { notifications } = await api('/notifications');
      box.innerHTML = '';
      if (notifications.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['No notifications.'])); return; }
      box.appendChild(el('div', { class: 'card' }, notifications.map((n) => el('div', {
        class: 'checklist-item', style: n.read ? '' : 'background:var(--brand-soft)',
        onclick: async () => { if (!n.read) { await api('/notifications/' + n.id + '/read', { method: 'PATCH' }); App.refreshNotifications(); load(); } },
      }, [el('div', {}, [el('div', { style: 'font-weight:700' }, [n.title]), el('div', { class: 'muted', style: 'font-size:13px' }, [n.message]), el('div', { class: 'faint' }, [fmt.ago(n.created_at)])])]))));
    }
    await load();
    const off = App.on('rt:*', load);
    container.cleanup = () => off();
    return container;
  });

  App.route('/activity', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Activity Log'])]));
    const box = el('div');
    container.appendChild(box);
    const { activity } = await api('/activity');
    if (activity.length === 0) box.appendChild(el('div', { class: 'empty-state' }, ['No activity yet.']));
    else box.appendChild(el('div', { class: 'timeline' }, activity.map((a) => el('div', { class: 'timeline-item' }, [
      el('div', { class: 'timeline-time' }, [fmt.dateTime(a.created_at)]),
      el('div', { class: 'timeline-text' }, [`${a.actor_name || 'System'} (${a.actor_role || '—'}) — ${a.action.replace(/_/g, ' ').toLowerCase()}${a.entity_id ? ' · ' + a.entity_id : ''}`]),
    ]))));
    return container;
  });

  App.route('/profile', async () => {
    const user = App.state.user;
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Profile'])]));
    const card = el('div', { class: 'card card-pad', style: 'max-width:420px' });
    card.appendChild(el('div', { class: 'flex-between mb-8' }, [el('span', { class: 'muted' }, ['Name']), user.displayName]));
    card.appendChild(el('div', { class: 'flex-between mb-8' }, [el('span', { class: 'muted' }, ['Username']), user.username]));
    card.appendChild(el('div', { class: 'flex-between mb-16' }, [el('span', { class: 'muted' }, ['Role']), user.role]));
    card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['Change Password']));
    const cur = el('input', { type: 'password', placeholder: 'Current password' });
    const next = el('input', { type: 'password', placeholder: 'New password (min 8 chars)' });
    card.appendChild(el('div', { class: 'field' }, [cur]));
    card.appendChild(el('div', { class: 'field' }, [next]));
    card.appendChild(el('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur.value, newPassword: next.value } });
        toast('Password changed', 'success');
        cur.value = ''; next.value = '';
      } catch (e) { toast(e.message, 'error'); }
    } }, ['Update Password']));
    container.appendChild(card);
    return container;
  });
})();
