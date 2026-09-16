'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  function barChart(data, opts) {
    opts = opts || {};
    const max = Math.max(1, ...data.map((d) => d.value));
    return el('div', { class: 'bar-chart' }, data.map((d) =>
      el('div', { class: 'bar-col' }, [
        el('div', { class: 'bar-value' }, [String(d.value)]),
        el('div', { class: 'bar', style: `height:${Math.max(4, (d.value / max) * 120)}px;background:${opts.color || 'var(--brand)'}` }),
        el('div', { class: 'bar-label' }, [String(d.label).slice(0, 10)]),
      ])
    ));
  }

  App.route('/analytics', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Analytics'])]));

    const rangeSel = el('select', {}, [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 Days'], ['30d', 'Last 30 Days']].map(([v, l]) => el('option', { value: v, selected: v === '7d' || undefined }, [l])));
    container.appendChild(el('div', { class: 'filters-bar' }, [rangeSel, el('button', { class: 'btn btn-sm btn-outline', onclick: load }, ['Refresh'])]));

    const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' });
    container.appendChild(grid);
    if (window.innerWidth < 880) grid.style.gridTemplateColumns = '1fr';

    async function load() {
      const data = await api('/analytics/charts?range=' + rangeSel.value);
      grid.innerHTML = '';
      grid.appendChild(chartCard('Customers by Employee', data.customersByEmployee));
      grid.appendChild(chartCard('Status Distribution', data.statusDistribution));
      grid.appendChild(chartCard('Daily Activity', data.dailyActivity));
      grid.appendChild(chartCard('By Source', data.bySource));
      grid.appendChild(chartCard('By Campaign', data.byCampaign));
    }
    function chartCard(title, rows) {
      const card = el('div', { class: 'card card-pad' });
      card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:8px' }, [title]));
      card.appendChild(rows.length ? barChart(rows) : el('div', { class: 'muted' }, ['No data for this range.']));
      return card;
    }
    await load();
    return container;
  }, { roles: ['team_leader'] });

  App.route('/my-performance', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['My Performance'])]));
    const { employees } = await api('/employees');
    const me = employees[0];
    const card = el('div', { class: 'card card-pad' });
    card.appendChild(el('div', { class: 'kpi-grid' }, [
      ['Assigned', me.assigned], ['Closed', me.closed], ['Follow-ups Completed', me.followupsCompleted], ['Follow-ups Overdue', me.followupsOverdue],
    ].map(([l, v]) => el('div', { class: 'kpi-card' }, [el('div', { class: 'kpi-value' }, [String(v)]), el('div', { class: 'kpi-label' }, [l])]))));
    card.appendChild(el('div', { class: 'mt-16' }, [el('div', { class: 'flex-between mb-8' }, ['Completion Rate', Math.round(me.completionRate * 100) + '%']), el('div', { class: 'progress-bar' }, [el('div', { style: `width:${Math.round(me.completionRate * 100)}%` })])]));
    container.appendChild(card);
    return container;
  });

  App.route('/leaderboard', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Leaderboard'])]));
    const { employees, weights } = await api('/employees');
    let sortKey = 'performanceScore';
    const box = el('div');
    container.appendChild(box);

    function render() {
      const sorted = [...employees].sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [
            ['name', 'Employee'], ['assigned', 'Assigned'], ['closed', 'Closed'], ['followupsCompleted', 'Follow-ups'], ['followupsOverdue', 'Overdue'], ['completionRate', 'Completion'], ['performanceScore', 'Score'],
          ].map(([key, label]) => el('th', { style: 'cursor:pointer', onclick: () => { sortKey = key; render(); } }, [label + (sortKey === key ? ' ▾' : '')])))]),
          el('tbody', {}, sorted.map((e, i) => el('tr', {}, [
            el('td', {}, [el('span', { style: 'font-weight:800' }, [i === 0 ? '🏆 ' : '']), e.name]),
            el('td', {}, [String(e.assigned)]),
            el('td', {}, [String(e.closed)]),
            el('td', {}, [`${e.followupsCompleted}/${e.followupsTotal}`]),
            el('td', {}, [String(e.followupsOverdue)]),
            el('td', {}, [Math.round(e.completionRate * 100) + '%']),
            el('td', { style: 'font-weight:800' }, [String(e.performanceScore)]),
          ]))),
        ]),
      ]));
    }
    render();
    return container;
  }, { roles: ['team_leader'] });

  App.route('/reports', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Report Center'])]));
    const reports = [
      ['customers', 'Customer Report', 'All customers with current status, assignment and dates.'],
      ['employees', 'Employee Report', 'Per-employee performance summary.'],
      ['activity', 'Activity Report', 'Full audit trail (who / what / when).'],
      ['followups', 'Follow-up Report', 'All scheduled, completed and overdue follow-ups.'],
      ['status', 'Status Report', 'Customer counts by status.'],
      ['whatsapp', 'WhatsApp Contact Report', 'Every WhatsApp contact initiated, by customer and employee.'],
      ['call-attempts', 'Call Attempts Report', 'Every logged call attempt and its outcome.'],
      ['sla', 'SLA Report', 'Live snapshot of every customer currently in SLA warning or breach.'],
      ['seen', 'Seen / Not-Seen Report', 'Per-employee seen vs. not-seen customer counts.'],
      ['lead-scores', 'Lead Score Report', 'Live, explainable lead scores for all open customers.'],
      ['products', 'Product Interest Report', 'Customer counts per product of interest.'],
      ['sales', 'Sales Report', 'Every purchase transaction with totals, refunds and net revenue.'],
      ['sales-attribution', 'Call Team → Sales Attribution', 'Assigned/seen/contacted/deals/revenue per employee.'],
    ];
    container.appendChild(el('div', { class: 'kpi-grid' }, reports.map(([key, title, desc]) =>
      el('div', { class: 'card card-pad' }, [
        el('div', { style: 'font-weight:800' }, [title]),
        el('div', { class: 'muted mt-8', style: 'font-size:12.5px' }, [desc]),
        el('a', { class: 'btn btn-primary btn-sm mt-12', href: App.apiBase + '/api/reports/' + key, target: '_blank' }, ['⬇ Export CSV']),
      ])
    )));
    return container;
  }, { roles: ['team_leader'] });

  App.route('/ai', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['AI Assistant']),
      el('div', { class: 'flex gap-8' }, [
        el('button', { class: 'btn btn-outline', onclick: generateSummary }, ['Generate Daily Summary']),
        el('button', { class: 'btn btn-outline', onclick: generateInsights }, ['Generate Operational Insights']),
      ]),
    ]));

    const chatBox = el('div', { class: 'card card-pad', style: 'min-height:260px;max-height:420px;overflow-y:auto;margin-bottom:14px' });
    container.appendChild(chatBox);
    const input = el('input', { placeholder: 'Ask about your data, e.g. "How many customers are unassigned?"' });
    container.appendChild(el('div', { class: 'flex gap-8' }, [input, el('button', { class: 'btn btn-primary', onclick: ask }, ['Ask'])]));

    function addMsg(text, who) {
      chatBox.appendChild(el('div', { class: 'mb-12', style: who === 'user' ? 'text-align:end' : '' }, [
        el('div', { style: `display:inline-block;padding:8px 12px;border-radius:10px;background:${who === 'user' ? 'var(--brand)' : 'var(--surface-2)'};color:${who === 'user' ? '#fff' : 'var(--text)'};max-width:80%;font-size:13.5px` }, [text]),
      ]));
      chatBox.scrollTop = chatBox.scrollHeight;
    }
    addMsg('Ask me things like "How many customers were closed today?" or "Which employees have overdue follow-ups?" — every answer comes straight from the database.', 'ai');

    async function ask() {
      const q = input.value.trim();
      if (!q) return;
      addMsg(q, 'user');
      input.value = '';
      try {
        const res = await api('/ai/ask', { method: 'POST', body: { question: q } });
        addMsg(res.answer, 'ai');
      } catch (e) {
        addMsg('Error: ' + e.message, 'ai');
      }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });

    async function generateSummary() {
      const { summary } = await api('/ai/daily-summary');
      addMsg(
        `Team summary (${summary.timeRange}) — ${summary.totalCustomers} total (${summary.assigned} assigned, ${summary.unassigned} unassigned). ${summary.closedToday} closed today, ${summary.interested} interested, ${summary.followUp} in follow-up, ${summary.overdue} overdue follow-ups, ${summary.reopenedToday} reopened today. SLA: ${summary.slaBreaches} breach(es), ${summary.slaWarnings} warning(s). Sales: ${summary.dealsToday} deal(s) today, ${summary.netRevenueToday.toLocaleString()} EGP net revenue today.`,
        'ai'
      );
    }

    async function generateInsights() {
      const { insights } = await api('/ai/insights');
      insights.forEach((ins) => {
        addMsg(`${ins.text} (${ins.timeRange})`, 'ai');
      });
    }

    return container;
  }, { roles: ['team_leader'] });
})();
