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
        el('div', { class: 'page-title' }, [user.role === 'team_leader' ? 'لوحة تحكم الفريق' : `أهلاً بك، ${user.displayName}`]),
        el('div', { class: 'muted' }, [new Date().toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })]),
      ]),
    ]);
    container.appendChild(header);

    const kpiGrid = el('div', { class: 'kpi-grid' });
    container.appendChild(kpiGrid);

    async function loadKpis() {
      const { kpis } = await api('/analytics/dashboard');
      kpiGrid.innerHTML = '';
      const items = [
        ['إجمالي العملاء', kpis.total, 'brand', '#/customers'],
        ...(user.role === 'team_leader' ? [['غير موزّعين', kpis.unassigned, 'danger', '#/customers?employeeId=unassigned']] : []),
        ['موزّعين', kpis.assigned, 'info', '#/customers'],
        ['جديد', kpis.new, 'info', '#/customers?status=NEW'],
        ['جارِ الاتصال', kpis.calling, 'brand', '#/customers?status=CALLING'],
        ['لا يوجد رد', kpis.noAnswer, null, '#/customers?status=NO_ANSWER'],
        ['متابعة', kpis.followUp, 'warning', '#/customers?status=FOLLOW_UP'],
        ['مهتم', kpis.interested, 'success', '#/customers?status=INTERESTED'],
        ['غير مهتم', kpis.notInterested, null, '#/customers?status=NOT_INTERESTED'],
        ['مغلق', kpis.closed, 'success', '#/customers?status=CLOSED'],
        ['متابعات متأخرة', kpis.overdue, 'danger', '#/followups?overdue=true'],
        ['عملاء اليوم', kpis.todayCustomers, 'brand'],
        ['مغلق اليوم', kpis.todayClosed, 'success'],
        ['متابعات اليوم', kpis.todayFollowups, 'warning'],
        ['نسبة الإنجاز', Math.round(kpis.completionRate * 100) + '%', 'brand'],
        ['واتساب اليوم', kpis.whatsappToday, 'success', '#/customers?whatsappStatus=CONTACT_INITIATED'],
        ['واتساب هذا الأسبوع', kpis.whatsappWeek, 'success'],
      ];
      items.forEach(([label, value, accent, link]) => kpiGrid.appendChild(kpi(label, value, accent, link ? () => App.navigate(link) : null)));
    }
    await loadKpis();
    const offRt = App.on('rt:*', () => loadKpis());

    if (user.role === 'team_leader') {
      container.appendChild(el('div', { class: 'section-title' }, ['نظرة على الفريق']));
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
              el('div', { class: 'mt-12 muted', style: 'font-size:12.5px' }, [`موزّع: ${e.assigned} · مغلق: ${e.closed} · متأخر: ${e.followupsOverdue}`]),
              el('div', { class: 'progress-bar mt-8' }, [el('div', { style: `width:${Math.round(e.completionRate * 100)}%` })]),
              el('div', { class: 'faint mt-8' }, [`النقاط: ${e.performanceScore}`]),
            ])
          );
        });
      }
      await loadTeam();
      App.on('rt:EMPLOYEE_AVAILABILITY_CHANGED', loadTeam);
      App.on('rt:CUSTOMER_STATUS_CHANGED', loadTeam);
      App.on('rt:DISTRIBUTION_COMPLETED', loadTeam);

      container.appendChild(el('div', { class: 'section-title' }, ['ملاحظات تشغيلية']));
      const insightsBox = el('div', { class: 'card card-pad' });
      container.appendChild(insightsBox);
      try {
        const { insights } = await api('/ai/insights');
        insightsBox.appendChild(el('div', {}, insights.map((i) => el('div', { class: 'checklist-item' }, ['💡 ' + i]))));
      } catch {
        insightsBox.textContent = 'تعذّر عرض الملاحظات حاليًا.';
      }
    } else {
      container.appendChild(el('div', { class: 'section-title' }, ['متابعات اليوم']));
      const fw = el('div');
      container.appendChild(fw);
      const { followups } = await api('/followups?status=OPEN');
      const today = followups.filter((f) => f.status === 'DUE' || f.status === 'OVERDUE');
      if (today.length === 0) fw.appendChild(el('div', { class: 'empty-state' }, ['لا توجد متابعات مستحقة اليوم.']));
      else fw.appendChild(renderFollowupList(today));
    }

    container.cleanup = () => offRt();
    return container;
  });

  const FOLLOWUP_STATUS_LABELS = { DUE: 'مستحقة', OVERDUE: 'متأخرة' };
  function renderFollowupList(followups) {
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['العميل', 'الهاتف', 'الموعد', 'الحالة', 'السبب', ''].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, followups.map((f) =>
          el('tr', {}, [
            el('td', {}, [el('a', { href: '#/customers/' + f.customerId, style: 'font-weight:700' }, [f.customerName || f.customerId])]),
            el('td', { class: 'mono' }, [f.customerPhone || '']),
            el('td', {}, [App.fmt.dateTime(f.scheduledFor)]),
            el('td', {}, [el('span', { class: 'badge badge-' + (f.status === 'OVERDUE' ? 'overdue' : 'follow_up') }, [FOLLOWUP_STATUS_LABELS[f.status] || f.status])]),
            el('td', {}, [f.reason || '—']),
            el('td', {}, [el('button', { class: 'btn btn-sm btn-success', onclick: async () => { await App.api('/followups/' + f.id + '/complete', { method: 'POST' }); App.toast('تم إنجاز المتابعة', 'success'); App.navigate('#/dashboard'); renderRouteRefresh(); } }, ['إنجاز'])]),
          ])
        )),
      ]),
    ]);
  }
  function renderRouteRefresh() { window.dispatchEvent(new Event('hashchange')); }
})();
