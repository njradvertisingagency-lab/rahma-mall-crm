'use strict';
(function () {
  const { el, api, fmt, badges } = App;

  function kpi(label, value, accent, onClick) {
    return el('div', { class: 'kpi-card' + (accent ? ' accent-' + accent : ''), onclick: onClick }, [
      el('div', { class: 'kpi-value' }, [String(value)]),
      el('div', { class: 'kpi-label' }, [label]),
    ]);
  }

  App.route('/dashboard', async () => {
    const user = App.state.user;
    const container = el('div');
    const header = el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('div', { class: 'page-title' }, [user.role === 'team_leader' ? 'Team Dashboard' : `Welcome, ${user.displayName}`]),
        el('div', { class: 'muted' }, [new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })]),
      ]),
    ]);
    container.appendChild(header);

    const kpiGrid = el('div', { class: 'kpi-grid' });
    container.appendChild(kpiGrid);

    async function loadKpis() {
      const { kpis } = await api('/analytics/dashboard');
      kpiGrid.innerHTML = '';
      const items = [
        ['Total Customers', kpis.total, 'brand', '#/customers'],
        ...(user.role === 'team_leader' ? [['Unassigned', kpis.unassigned, 'danger', '#/customers?employeeId=unassigned']] : []),
        ['Assigned', kpis.assigned, 'info', '#/customers'],
        ['New', kpis.new, 'info', '#/customers?status=NEW'],
        ['Calling', kpis.calling, 'brand', '#/customers?status=CALLING'],
        ['No Answer', kpis.noAnswer, null, '#/customers?status=NO_ANSWER'],
        ['Follow-up', kpis.followUp, 'warning', '#/customers?status=FOLLOW_UP'],
        ['Interested', kpis.interested, 'success', '#/customers?status=INTERESTED'],
        ['Not Interested', kpis.notInterested, null, '#/customers?status=NOT_INTERESTED'],
        ['Closed', kpis.closed, 'success', '#/customers?status=CLOSED'],
        ['Overdue Follow-ups', kpis.overdue, 'danger', '#/followups?overdue=true'],
        ["Today's Customers", kpis.todayCustomers, 'brand'],
        ["Today's Closed", kpis.todayClosed, 'success'],
        ["Today's Follow-ups", kpis.todayFollowups, 'warning'],
        ['Completion Rate', Math.round(kpis.completionRate * 100) + '%', 'brand'],
        ['WhatsApp Today', kpis.whatsappToday, 'success', '#/customers?whatsappStatus=CONTACT_INITIATED'],
        ['WhatsApp This Week', kpis.whatsappWeek, 'success'],
      ];
      items.forEach(([label, value, accent, link]) => kpiGrid.appendChild(kpi(label, value, accent, link ? () => App.navigate(link) : null)));
    }
    await loadKpis();
    const offRt = App.on('rt:*', () => loadKpis());

    if (user.role === 'team_leader') {
      container.appendChild(el('div', { class: 'section-title' }, ['Team Overview']));
      const teamWrap = el('div', { class: 'kpi-grid' });
      container.appendChild(teamWrap);
      async function loadTeam() {
        const { employees } = await api('/employees');
        teamWrap.innerHTML = '';
        employees.forEach((e) => {
          teamWrap.appendChild(
            el('div', { class: 'card card-pad', onclick: () => App.navigate('#/customers?employeeId=' + e.id) }, [
              el('div', { class: 'flex-between' }, [
                el('div', { class: 'flex gap-8', style: 'align-items:center' }, [el('div', { class: 'avatar avatar-sm' }, [e.name[0]]), el('div', { style: 'font-weight:700' }, [e.name])]),
                badges.availability(e.availability),
              ]),
              el('div', { class: 'mt-12 muted', style: 'font-size:12.5px' }, [`Assigned: ${e.assigned} · Closed: ${e.closed} · Overdue: ${e.followupsOverdue}`]),
              el('div', { class: 'progress-bar mt-8' }, [el('div', { style: `width:${Math.round(e.completionRate * 100)}%` })]),
              el('div', { class: 'faint mt-8' }, [`Score: ${e.performanceScore}`]),
            ])
          );
        });
      }
      await loadTeam();
      App.on('rt:EMPLOYEE_AVAILABILITY_CHANGED', loadTeam);
      App.on('rt:CUSTOMER_STATUS_CHANGED', loadTeam);
      App.on('rt:DISTRIBUTION_COMPLETED', loadTeam);

      container.appendChild(el('div', { class: 'section-title' }, ['Operational Insights']));
      const insightsBox = el('div', { class: 'card card-pad' });
      container.appendChild(insightsBox);
      try {
        const { insights } = await api('/ai/insights');
        insightsBox.appendChild(el('div', {}, insights.map((i) => el('div', { class: 'checklist-item' }, ['💡 ' + i]))));
      } catch {
        insightsBox.textContent = 'Insights unavailable.';
      }
    } else {
      container.appendChild(el('div', { class: 'section-title' }, ["Today's Follow-ups"]));
      const fw = el('div');
      container.appendChild(fw);
      const { followups } = await api('/followups?status=OPEN');
      const today = followups.filter((f) => f.status === 'DUE' || f.status === 'OVERDUE');
      if (today.length === 0) fw.appendChild(el('div', { class: 'empty-state' }, ['No follow-ups due today.']));
      else fw.appendChild(renderFollowupList(today));
    }

    container.cleanup = () => offRt();
    return container;
  });

  function renderFollowupList(followups) {
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['Customer', 'Phone', 'Scheduled', 'Status', 'Reason', ''].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, followups.map((f) =>
          el('tr', {}, [
            el('td', {}, [el('a', { href: '#/customers/' + f.customerId, style: 'font-weight:700' }, [f.customerName || f.customerId])]),
            el('td', { class: 'mono' }, [f.customerPhone || '']),
            el('td', {}, [App.fmt.dateTime(f.scheduledFor)]),
            el('td', {}, [App.badges.status(f.status === 'OVERDUE' ? 'CLOSED' : 'FOLLOW_UP').outerHTML ? el('span', { class: 'badge badge-' + (f.status === 'OVERDUE' ? 'overdue' : 'follow_up') }, [f.status]) : f.status]),
            el('td', {}, [f.reason || '—']),
            el('td', {}, [el('button', { class: 'btn btn-sm btn-success', onclick: async () => { await App.api('/followups/' + f.id + '/complete', { method: 'POST' }); App.toast('Follow-up completed', 'success'); App.navigate('#/dashboard'); renderRouteRefresh(); } }, ['Complete'])]),
          ])
        )),
      ]),
    ]);
  }
  function renderRouteRefresh() { window.dispatchEvent(new Event('hashchange')); }
})();
