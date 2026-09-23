'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  function kpi(value, label, color) {
    return el('div', { class: 'kpi-card' }, [
      el('div', { class: 'kpi-value', style: color ? `color:${color}` : '' }, [String(value)]),
      el('div', { class: 'kpi-label' }, [label]),
    ]);
  }

  // Translates a Needs Attention item's `filter` (returned by the server,
  // already resolved against real data) into a customers-list deep link.
  // Items with no sensible list-level filter (idle employees; a 3+-failed-call
  // count that has no dedicated query param) render as plain, non-clickable text.
  function filterToLink(filter) {
    if (!filter) return null;
    const params = new URLSearchParams();
    if (filter.sla === 'breached') params.set('segment', 'SLA_BREACHED');
    else if (filter.seen === 'not_seen') params.set('seen', 'not_seen');
    else if (filter.followup === 'overdue') params.set('followup', 'overdue');
    else if (filter.status === 'INTERESTED') params.set('status', 'INTERESTED');
    else return null;
    return '#/customers?' + params.toString();
  }

  App.route('/command-center', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['🎛️ مركز التحكم المباشر']),
      el('button', { class: 'btn btn-outline btn-sm', onclick: () => load() }, ['↻ تحديث']),
    ]));

    const presenceRow = el('div', { class: 'kpi-grid' });
    const salesRow = el('div', { class: 'kpi-grid' });
    const attentionCard = el('div', { class: 'card card-pad', style: 'min-width:0' });
    const funnelCard = el('div', { class: 'card card-pad', style: 'min-width:0' });
    const employeeTableCard = el('div', { class: 'card card-pad' });
    const reassignCard = el('div', { class: 'card card-pad' });

    container.appendChild(el('div', { class: 'section-title' }, ['تواجد الفريق']));
    container.appendChild(presenceRow);
    container.appendChild(el('div', { class: 'section-title' }, ['مبيعات اليوم']));
    container.appendChild(salesRow);

    const grid2 = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' }, [attentionCard, funnelCard]);
    if (window.innerWidth < 880) grid2.style.gridTemplateColumns = '1fr';
    container.appendChild(grid2);

    container.appendChild(el('div', { class: 'section-title' }, ['جدول الموظفين المباشر']));
    container.appendChild(employeeTableCard);
    container.appendChild(el('div', { class: 'section-title' }, ['اقتراحات إعادة التوزيع الذكية']));
    container.appendChild(reassignCard);

    async function load() {
      let snapshot, reassign;
      try {
        [snapshot, reassign] = await Promise.all([
          api('/command-center'),
          api('/command-center/reassignment-suggestions'),
        ]);
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
      renderPresence(snapshot.presence);
      renderSales(snapshot.sales);
      renderAttention(snapshot.needsAttention);
      renderFunnel(snapshot.funnelToday);
      renderEmployeeTable(snapshot.liveEmployeeTable, snapshot.seenSummary);
      renderReassign(reassign.suggestions);
    }

    function renderPresence(p) {
      presenceRow.innerHTML = '';
      presenceRow.appendChild(kpi(p.total, 'إجمالي الموظفين'));
      presenceRow.appendChild(kpi(p.online, 'نشط الآن', 'var(--success, #167e6c)'));
      presenceRow.appendChild(kpi(p.idle, 'غير نشط', '#f2936b'));
      presenceRow.appendChild(kpi(p.offline, 'غير متصل', 'var(--muted)'));
    }

    function renderSales(s) {
      salesRow.innerHTML = '';
      salesRow.appendChild(kpi(s.dealsToday, 'صفقات اليوم'));
      salesRow.appendChild(kpi(s.branchVisitsToday, 'زيارات الفرع'));
      salesRow.appendChild(kpi(s.grossRevenueToday.toLocaleString(), 'إجمالي الإيراد'));
      salesRow.appendChild(kpi(s.refundsToday.toLocaleString(), 'المرتجعات'));
      salesRow.appendChild(kpi(s.netRevenueToday.toLocaleString(), 'صافي الإيراد', 'var(--success, #167e6c)'));
      salesRow.appendChild(kpi(s.averageOrderValueToday.toLocaleString(), 'متوسط قيمة الطلب'));
      salesRow.appendChild(kpi(s.conversionRate + '%', 'تحويل الزيارة ← صفقة'));
    }

    function renderAttention(items) {
      attentionCard.innerHTML = '';
      attentionCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['🚨 يحتاج انتباه (مرتب حسب الخطورة)']));
      if (items.length === 0) {
        attentionCard.appendChild(el('div', { class: 'muted' }, ['لا يوجد ما يحتاج انتباه الآن.']));
        return;
      }
      items.forEach((item) => {
        const link = filterToLink(item.filter);
        const sev = item.severity === 'CRITICAL' ? 'critical' : 'warning';
        const row = el('div', { class: 'alert-row alert-row-' + sev }, [
          el('div', { class: 'alert-row-main' }, [
            el('span', { class: 'alert-row-dot' }),
            el('span', { class: 'alert-row-label' }, [item.label]),
          ]),
          link ? el('a', { href: link, class: 'alert-row-action' }, [el('span', {}, ['عرض']), el('span', { class: 'chevron' })]) : null,
        ]);
        attentionCard.appendChild(row);
      });
    }

    function renderFunnel(funnel) {
      funnelCard.innerHTML = '';
      funnelCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, [`قمع اليوم (الإيراد: ${funnel.revenue.toLocaleString()} ج.م)`]));
      funnel.stages.forEach((s) => {
        funnelCard.appendChild(el('div', { class: 'mb-8' }, [
          el('div', { class: 'flex-between', style: 'font-size:12.5px' }, [
            el('span', {}, [s.label]),
            el('span', { class: 'muted' }, [`${s.count} (${s.percentOfLeads}% من العملاء${s.conversionFromPrev !== null ? `، ${s.conversionFromPrev}% من المرحلة السابقة` : ''})`]),
          ]),
          el('div', { class: 'progress-bar' }, [el('div', { style: `width:${Math.min(100, s.percentOfLeads)}%` })]),
        ]));
      });
    }

    function renderEmployeeTable(rows, seenSummary) {
      employeeTableCard.innerHTML = '';
      const seenByEmp = Object.fromEntries((seenSummary || []).map((s) => [s.employeeId, s]));
      employeeTableCard.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['الموظف', 'الحضور', 'آخر ظهور', 'الإتاحة', 'موزّع', 'تمت رؤيته', 'مغلق', 'المتابعات', 'متأخر', 'الإنجاز', 'النقاط'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, rows.map((e) => {
            const seen = seenByEmp[e.id];
            const lastSeenAt = e.presence?.lastActivityAt || e.presence?.lastLoginAt || null;
            return el('tr', {}, [
              el('td', { style: 'font-weight:700' }, [e.nameAr ? `${e.name} (${e.nameAr})` : e.name]),
              el('td', {}, [badges.presence(e.presence)]),
              el('td', { class: e.presence?.online ? '' : 'muted', title: lastSeenAt ? fmt.dateTime(lastSeenAt) : '' }, [
                e.presence?.online ? 'الآن' : (lastSeenAt ? fmt.ago(lastSeenAt) : 'لم يسجّل دخول بعد'),
              ]),
              el('td', {}, [badges.availability(e.availability)]),
              el('td', {}, [String(e.assigned)]),
              el('td', {}, [seen ? `${seen.seen}/${seen.assigned}${seen.notSeen > 0 ? ` (${seen.notSeen} لم تتم رؤيته)` : ''}` : '—']),
              el('td', {}, [String(e.closed)]),
              el('td', {}, [String(e.followupsCompleted)]),
              el('td', {}, [String(e.followupsOverdue)]),
              el('td', {}, [Math.round(e.completionRate * 100) + '%']),
              el('td', { style: 'font-weight:800' }, [String(e.performanceScore)]),
            ]);
          })),
        ]),
      ]));
    }

    function renderReassign(suggestions) {
      reassignCard.innerHTML = '';
      if (suggestions.length === 0) {
        reassignCard.appendChild(el('div', { class: 'muted' }, ['لا توجد اقتراحات لإعادة التوزيع الآن.']));
        return;
      }
      // حساب المالك لا يتخذ أي إجراء — القرار والتنفيذ شغل التيم ليدر فقط،
      // فنعرض له نفس المعلومة بدون زر ينقّله لصفحة توزيع لا يُفترض أصلاً أن
      // يفتحها (حسابه مقفول على هذه الداش بورد الوحيدة).
      suggestions.forEach((s) => {
        reassignCard.appendChild(el('div', { class: 'flex-between mb-8', style: 'padding:8px 10px;border-radius:8px;background:var(--surface-2)' }, [
          el('div', {}, [
            el('div', { style: 'font-weight:700' }, [s.employeeName]),
            el('div', { class: 'faint' }, [s.reasons.join(' · ') + ` — ${s.openAssignedCustomers} عميل مفتوح`]),
          ]),
          App.state.user.isOwner
            ? null
            : el('button', { class: 'btn btn-sm btn-outline', onclick: () => App.navigate('#/distribute') }, ['الذهاب إلى التوزيع']),
        ]));
      });
      reassignCard.appendChild(el('div', { class: 'faint mt-8' }, ['اقتراحات فقط — أي إعادة توزيع تتطلب دائمًا موافقة يدوية من قائد الفريق.']));
    }

    await load();
    let reloadTimer = null;
    const off = App.on('rt:*', () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 600);
    });
    container.cleanup = () => { off(); clearTimeout(reloadTimer); };
    return container;
  }, { roles: ['team_leader'] });
})();
