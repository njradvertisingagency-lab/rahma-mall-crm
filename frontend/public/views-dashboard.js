'use strict';
(function () {
  const { el, api, fmt, badges } = App;

  function kpi(label, value, accent, onClick) {
    return el('div', { class: 'kpi-card' + (accent ? ' accent-' + accent : ''), onclick: onClick }, [
      el('div', { class: 'kpi-value' }, [String(value)]),
      el('div', { class: 'kpi-label' }, [label]),
    ]);
  }

  // ── الحسابات labels ──
  const STATUS_AR = { active_regular: 'عادي', active_late: 'متأخر', rejected: 'مرفوض', needs_review: 'يحتاج مراجعة' };
  const STATUS_ACCENT = { active_regular: 'success', active_late: 'warning', rejected: 'danger', needs_review: 'info' };
  const LOCATION_AR = { office: 'المكتب (أ. هاني)', accounting: 'الحسابات', legal: 'الشئون القانونية' };
  const LOCATION_ACCENT = { office: 'brand', accounting: 'info', legal: 'warning' };

  // ====================================================================
  //  لوحة تحكم قسم الحسابات
  // ====================================================================
  async function accountingDashboard(container, user) {
    const kpiGrid = el('div', { class: 'kpi-grid' });
    container.appendChild(kpiGrid);

    async function loadStats() {
      const stats = await api('/accounting/stats');
      kpiGrid.innerHTML = '';

      // إجمالي الملفات
      const totalFiles = stats.byStatus.reduce((s, r) => s + r.cnt, 0);
      kpiGrid.appendChild(kpi('إجمالي الملفات', totalFiles, 'brand', () => App.navigate('#/accounting-files')));

      // حسب الحالة
      stats.byStatus.forEach((r) => {
        kpiGrid.appendChild(kpi(STATUS_AR[r.status] || r.status, r.cnt, STATUS_ACCENT[r.status], () => App.navigate('#/accounting-files?status=' + r.status)));
      });

      // حسب الموقع
      stats.byLocation.forEach((r) => {
        kpiGrid.appendChild(kpi(LOCATION_AR[r.current_location] || r.current_location, r.cnt, LOCATION_ACCENT[r.current_location], () => App.navigate('#/accounting-files?location=' + r.current_location)));
      });

      // حركات اليوم / الإجمالي
      kpiGrid.appendChild(kpi('حركات اليوم', stats.todayMovements, 'success', () => App.navigate('#/file-movements')));
      kpiGrid.appendChild(kpi('إجمالي الحركات', stats.totalMovements, null, () => App.navigate('#/file-movements')));
    }
    await loadStats();
    const offRt = App.onRealtime(() => loadStats(), 8000);

    // ── أزرار سريعة ──
    container.appendChild(el('div', { class: 'flex gap-8 mt-16', style: 'flex-wrap:wrap' }, [
      el('button', { class: 'btn btn-brand', onclick: () => App.navigate('#/accounting-files') }, ['🗃️ ملفات العملاء']),
      el('button', { class: 'btn btn-outline', onclick: () => App.navigate('#/file-movements') }, ['📂 حركة الملفات']),
    ]));

    // ── آخر الحركات ──
    container.appendChild(el('div', { class: 'section-title mt-24' }, ['آخر الحركات']));
    const movWrap = el('div');
    container.appendChild(movWrap);
    try {
      const { movements } = await api('/accounting/movements?page=1');
      if (!movements || movements.length === 0) {
        movWrap.appendChild(el('div', { class: 'empty-state' }, ['لا توجد حركات مسجّلة بعد.']));
      } else {
        const recent = movements.slice(0, 10);
        movWrap.appendChild(el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['رقم الملف', 'العميل', 'من', 'إلى', 'المستلم', 'السبب', 'التاريخ'].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, recent.map((m) =>
              el('tr', {}, [
                el('td', { class: 'mono' }, [m.file_number || '']),
                el('td', {}, [m.client_name || '']),
                el('td', {}, [LOCATION_AR[m.from_location] || m.from_location]),
                el('td', {}, [LOCATION_AR[m.to_location] || m.to_location]),
                el('td', {}, [m.taken_by_name || '']),
                el('td', {}, [m.reason || '—']),
                el('td', { class: 'muted', style: 'font-size:12px' }, [fmt.dateTime(m.created_at)]),
              ])
            )),
          ]),
        ]));
      }
    } catch {
      movWrap.appendChild(el('div', { class: 'empty-state' }, ['تعذّر تحميل الحركات.']));
    }

    container.cleanup = () => { offRt(); };
  }

  // ====================================================================
  //  لوحة التحكم الرئيسية (CRM)
  // ====================================================================
  async function crmDashboard(container, user) {
    const kpiGrid = el('div', { class: 'kpi-grid' });
    container.appendChild(kpiGrid);

    async function loadKpis() {
      const fresh = App.freshNext;
      App.freshNext = false;
      const { kpis } = await api('/analytics/dashboard' + (fresh ? '?fresh=1' : ''));
      kpiGrid.innerHTML = '';
      // Compute today's start in Cairo timezone for date-filtered links
      const cairoToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
      const todayFrom = cairoToday + 'T00:00:00';
      const items = [
        ['إجمالي العملاء', kpis.total, 'brand', '#/customers'],
        ...(user.role === 'team_leader' ? [['غير موزّعين', kpis.unassigned, 'danger', '#/customers?employeeId=unassigned']] : []),
        ['موزّعين', kpis.assigned, 'info', '#/customers'],
        ['جديد', kpis.new, 'info', '#/customers?status=NEW'],
        ['لم يُفتح بعد', kpis.unopened || 0, 'danger', '#/customers?seen=not_seen'],
        ['لا يوجد رد', kpis.noAnswer, null, '#/customers?status=NO_ANSWER'],
        ['متابعة', kpis.followUp, 'warning', '#/customers?status=FOLLOW_UP'],
        ['مهتم', kpis.interested, 'success', '#/customers?status=INTERESTED'],
        ['غير مهتم', kpis.notInterested, null, '#/customers?status=NOT_INTERESTED'],
        ['مغلق', kpis.closed, 'success', '#/customers?status=CLOSED'],
        ['متابعات متأخرة', kpis.overdue, 'danger', '#/followups?overdue=true'],
        ['عملاء اليوم', kpis.todayCustomers, 'brand', '#/customers?dateFrom=' + todayFrom],
        ['مغلق اليوم', kpis.todayClosed, 'success', '#/customers?status=CLOSED&dateFrom=' + todayFrom],
        ['متابعات اليوم', kpis.todayFollowups, 'warning', '#/followups'],
        ['نسبة الإنجاز', Math.round(kpis.completionRate * 100) + '%', 'brand', null],
        ['واتساب اليوم', kpis.whatsappToday, 'success', '#/customers?whatsappStatus=CONTACT_INITIATED'],
        ['واتساب هذا الأسبوع', kpis.whatsappWeek, 'success', '#/customers?whatsappStatus=CONTACT_INITIATED'],
      ];
      items.forEach(([label, value, accent, link]) => kpiGrid.appendChild(kpi(label, value, accent, link ? () => App.navigate(link) : null)));
    }
    await loadKpis();
    const offRt = App.onRealtime(() => loadKpis(), 5000);
    let offTeamListeners = [];

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
                el('div', { class: 'flex gap-8', style: 'align-items:center' }, [App.avatar({ url: e.avatarUrl, name: e.name, sizeClass: 'avatar-sm' }), el('div', { style: 'font-weight:700' }, [e.name])]),
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
    } else {
      container.appendChild(el('div', { class: 'section-title' }, ['متابعات اليوم']));
      const fw = el('div');
      container.appendChild(fw);
      const { followups } = await api('/followups?status=OPEN');
      const today = followups.filter((f) => f.status === 'DUE' || f.status === 'OVERDUE');
      if (today.length === 0) fw.appendChild(el('div', { class: 'empty-state' }, ['لا توجد متابعات مستحقة اليوم.']));
      else fw.appendChild(renderFollowupList(today));
    }

    container.cleanup = () => { offRt(); offTeamListeners.forEach((off) => off()); };
  }

  // ====================================================================
  //  Route handler
  // ====================================================================
  App.route('/dashboard', async () => {
    const user = App.state.user;
    const container = el('div');
    const titleText = user.department === 'accounting'
      ? 'لوحة تحكم الحسابات'
      : (user.role === 'team_leader' ? 'لوحة تحكم الفريق' : `أهلاً بك، ${user.displayName}`);
    const header = el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('div', { class: 'page-title' }, [titleText]),
        el('div', { class: 'muted' }, [new Date().toLocaleDateString('ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })]),
      ]),
    ]);
    container.appendChild(header);

    if (user.department === 'accounting') {
      await accountingDashboard(container, user);
    } else {
      await crmDashboard(container, user);
    }

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
