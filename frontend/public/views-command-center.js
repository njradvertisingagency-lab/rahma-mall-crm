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
      el('div', { class: 'page-title' }, ['🎛️ Live Command Center']),
      el('button', { class: 'btn btn-outline btn-sm', onclick: () => load() }, ['↻ Refresh']),
    ]));

    const presenceRow = el('div', { class: 'kpi-grid' });
    const salesRow = el('div', { class: 'kpi-grid' });
    const attentionCard = el('div', { class: 'card card-pad' });
    const funnelCard = el('div', { class: 'card card-pad' });
    const employeeTableCard = el('div', { class: 'card card-pad' });
    const reassignCard = el('div', { class: 'card card-pad' });

    container.appendChild(el('div', { class: 'section-title' }, ['Team Presence']));
    container.appendChild(presenceRow);
    container.appendChild(el('div', { class: 'section-title' }, ["Today's Sales"]));
    container.appendChild(salesRow);

    const grid2 = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' }, [attentionCard, funnelCard]);
    if (window.innerWidth < 880) grid2.style.gridTemplateColumns = '1fr';
    container.appendChild(grid2);

    container.appendChild(el('div', { class: 'section-title' }, ['Live Employee Table']));
    container.appendChild(employeeTableCard);
    container.appendChild(el('div', { class: 'section-title' }, ['Smart Reassignment Suggestions']));
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
      presenceRow.appendChild(kpi(p.total, 'Total Employees'));
      presenceRow.appendChild(kpi(p.online, 'Active Now', 'var(--success, #16a34a)'));
      presenceRow.appendChild(kpi(p.idle, 'Idle', '#b45309'));
      presenceRow.appendChild(kpi(p.offline, 'Offline', 'var(--muted)'));
    }

    function renderSales(s) {
      salesRow.innerHTML = '';
      salesRow.appendChild(kpi(s.dealsToday, 'Deals Today'));
      salesRow.appendChild(kpi(s.branchVisitsToday, 'Branch Visits'));
      salesRow.appendChild(kpi(s.grossRevenueToday.toLocaleString(), 'Gross Revenue'));
      salesRow.appendChild(kpi(s.refundsToday.toLocaleString(), 'Refunds'));
      salesRow.appendChild(kpi(s.netRevenueToday.toLocaleString(), 'Net Revenue', 'var(--success, #16a34a)'));
      salesRow.appendChild(kpi(s.averageOrderValueToday.toLocaleString(), 'Avg Order Value'));
      salesRow.appendChild(kpi(s.conversionRate + '%', 'Visit → Deal Conversion'));
    }

    function renderAttention(items) {
      attentionCard.innerHTML = '';
      attentionCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['🚨 Needs Attention (ranked by severity)']));
      if (items.length === 0) {
        attentionCard.appendChild(el('div', { class: 'muted' }, ['Nothing needs attention right now.']));
        return;
      }
      items.forEach((item) => {
        const link = filterToLink(item.filter);
        const sevColor = item.severity === 'CRITICAL' ? '#991b1b' : '#92400e';
        const sevBg = item.severity === 'CRITICAL' ? '#fee2e2' : '#fef3c7';
        const row = el('div', { class: 'flex-between mb-8', style: `padding:8px 10px;border-radius:8px;background:${sevBg}` }, [
          el('span', { style: `color:${sevColor};font-weight:700;font-size:13px` }, [(item.severity === 'CRITICAL' ? '🔴 ' : '🟠 ') + item.label]),
          link ? el('a', { href: link, class: 'btn btn-sm btn-outline' }, ['View →']) : null,
        ]);
        attentionCard.appendChild(row);
      });
    }

    function renderFunnel(funnel) {
      funnelCard.innerHTML = '';
      funnelCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, [`Today's Funnel (Revenue: ${funnel.revenue.toLocaleString()} EGP)`]));
      funnel.stages.forEach((s) => {
        funnelCard.appendChild(el('div', { class: 'mb-8' }, [
          el('div', { class: 'flex-between', style: 'font-size:12.5px' }, [
            el('span', {}, [s.label]),
            el('span', { class: 'muted' }, [`${s.count} (${s.percentOfLeads}% of leads${s.conversionFromPrev !== null ? `, ${s.conversionFromPrev}% from prev` : ''})`]),
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
          el('thead', {}, [el('tr', {}, ['Employee', 'Presence', 'Availability', 'Assigned', 'Seen', 'Closed', 'Follow-ups', 'Overdue', 'Completion', 'Score'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, rows.map((e) => {
            const seen = seenByEmp[e.id];
            return el('tr', {}, [
              el('td', { style: 'font-weight:700' }, [e.nameAr ? `${e.name} (${e.nameAr})` : e.name]),
              el('td', {}, [badges.presence(e.presence)]),
              el('td', {}, [badges.availability(e.availability)]),
              el('td', {}, [String(e.assigned)]),
              el('td', {}, [seen ? `${seen.seen}/${seen.assigned}${seen.notSeen > 0 ? ` (${seen.notSeen} not seen)` : ''}` : '—']),
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
        reassignCard.appendChild(el('div', { class: 'muted' }, ['No reassignment suggestions right now.']));
        return;
      }
      suggestions.forEach((s) => {
        reassignCard.appendChild(el('div', { class: 'flex-between mb-8', style: 'padding:8px 10px;border-radius:8px;background:var(--surface-2)' }, [
          el('div', {}, [
            el('div', { style: 'font-weight:700' }, [s.employeeName]),
            el('div', { class: 'faint' }, [s.reasons.join(' · ') + ` — ${s.openAssignedCustomers} open customer(s)`]),
          ]),
          el('button', { class: 'btn btn-sm btn-outline', onclick: () => App.navigate('#/distribute') }, ['Go to Distribute']),
        ]));
      });
      reassignCard.appendChild(el('div', { class: 'faint mt-8' }, ['Suggestions only — any reassignment always requires manual Team Leader approval.']));
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
