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
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['التحليلات'])]));

    const rangeSel = el('select', {}, [['today', 'اليوم'], ['yesterday', 'أمس'], ['7d', 'آخر ٧ أيام'], ['30d', 'آخر ٣٠ يوم']].map(([v, l]) => el('option', { value: v, selected: v === '7d' || undefined }, [l])));
    container.appendChild(el('div', { class: 'filters-bar' }, [rangeSel, el('button', { class: 'btn btn-sm btn-outline', onclick: load }, ['تحديث'])]));

    const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' });
    container.appendChild(grid);
    if (window.innerWidth < 880) grid.style.gridTemplateColumns = '1fr';

    async function load() {
      const data = await api('/analytics/charts?range=' + rangeSel.value);
      grid.innerHTML = '';
      grid.appendChild(chartCard('العملاء حسب الموظف', data.customersByEmployee));
      grid.appendChild(chartCard('توزيع الحالات', data.statusDistribution));
      grid.appendChild(chartCard('النشاط اليومي', data.dailyActivity));
      grid.appendChild(chartCard('حسب المصدر', data.bySource));
      grid.appendChild(chartCard('حسب الحملة', data.byCampaign));
    }
    function chartCard(title, rows) {
      const card = el('div', { class: 'card card-pad', style: 'min-width:0' });
      card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:8px' }, [title]));
      card.appendChild(rows.length ? barChart(rows) : el('div', { class: 'muted' }, ['لا توجد بيانات في هذه الفترة.']));
      return card;
    }
    await load();
    return container;
  }, { roles: ['team_leader'] });

  App.route('/my-performance', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['أدائي'])]));
    const { employees } = await api('/employees');
    const me = employees[0];
    const card = el('div', { class: 'card card-pad' });
    card.appendChild(el('div', { class: 'kpi-grid' }, [
      ['موزّع', me.assigned], ['مغلق', me.closed], ['متابعات مكتملة', me.followupsCompleted], ['متابعات متأخرة', me.followupsOverdue],
    ].map(([l, v]) => el('div', { class: 'kpi-card' }, [el('div', { class: 'kpi-value' }, [String(v)]), el('div', { class: 'kpi-label' }, [l])]))));
    card.appendChild(el('div', { class: 'mt-16' }, [el('div', { class: 'flex-between mb-8' }, ['نسبة الإنجاز', Math.round(me.completionRate * 100) + '%']), el('div', { class: 'progress-bar' }, [el('div', { style: `width:${Math.round(me.completionRate * 100)}%` })])]));
    container.appendChild(card);
    return container;
  });

  App.route('/leaderboard', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['لوحة الصدارة'])]));
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
            ['name', 'الموظف'], ['assigned', 'موزّع'], ['closed', 'مغلق'], ['followupsCompleted', 'المتابعات'], ['followupsOverdue', 'متأخر'], ['completionRate', 'الإنجاز'], ['performanceScore', 'النقاط'],
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
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['مركز التقارير'])]));
    const reports = [
      ['customers', 'تقرير العملاء', 'كل العملاء بحالتهم الحالية والتعيين والتواريخ.'],
      ['employees', 'تقرير الموظفين', 'ملخص أداء كل موظف.'],
      ['activity', 'تقرير الأنشطة', 'سجل تدقيق كامل (من / ماذا / متى).'],
      ['followups', 'تقرير المتابعات', 'كل المتابعات المجدولة والمكتملة والمتأخرة.'],
      ['status', 'تقرير الحالات', 'عدد العملاء حسب كل حالة.'],
      ['whatsapp', 'تقرير تواصل واتساب', 'كل تواصل عبر واتساب، حسب العميل والموظف.'],
      ['call-attempts', 'تقرير محاولات الاتصال', 'كل محاولة اتصال مسجّلة ونتيجتها.'],
      ['sla', 'تقرير مواعيد الخدمة', 'لقطة حية لكل عميل في حالة تحذير أو تجاوز للموعد.'],
      ['seen', 'تقرير تمت رؤيته / لم يُرَ', 'عدد العملاء الذين تمت رؤيتهم مقابل لم يتم لكل موظف.'],
      ['lead-scores', 'تقرير تقييم العملاء المحتملين', 'تقييم حي وواضح لكل العملاء المفتوحين.'],
      ['products', 'تقرير اهتمام بالمنتجات', 'عدد العملاء حسب كل منتج مهتم به.'],
      ['sales', 'تقرير المبيعات', 'كل عملية شراء بالإجمالي والمرتجعات وصافي الإيراد.'],
      ['sales-attribution', 'تقرير فريق الاتصال ← المبيعات', 'موزّع/شوهد/تم التواصل/صفقات/إيراد لكل موظف.'],
    ];
    container.appendChild(el('div', { class: 'kpi-grid' }, reports.map(([key, title, desc]) =>
      el('div', { class: 'card card-pad' }, [
        el('div', { style: 'font-weight:800' }, [title]),
        el('div', { class: 'muted mt-8', style: 'font-size:12.5px' }, [desc]),
        el('a', { class: 'btn btn-primary btn-sm mt-12', href: App.apiBase + '/api/reports/' + key, target: '_blank' }, ['⬇ تصدير CSV']),
      ])
    )));
    return container;
  }, { roles: ['team_leader'] });

  App.route('/ai', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['المساعد الذكي']),
      el('div', { class: 'flex gap-8' }, [
        el('button', { class: 'btn btn-outline', onclick: generateSummary }, ['إنشاء ملخص اليوم']),
        el('button', { class: 'btn btn-outline', onclick: generateInsights }, ['إنشاء ملاحظات تشغيلية']),
      ]),
    ]));

    const chatBox = el('div', { class: 'card card-pad', style: 'min-height:260px;max-height:420px;overflow-y:auto;margin-bottom:14px' });
    container.appendChild(chatBox);
    const input = el('input', { placeholder: 'اسأل عن بياناتك، مثال: "كام عميل غير موزّع؟"' });
    container.appendChild(el('div', { class: 'flex gap-8' }, [input, el('button', { class: 'btn btn-primary', onclick: ask }, ['اسأل'])]));

    function addMsg(text, who) {
      chatBox.appendChild(el('div', { class: 'mb-12', style: who === 'user' ? 'text-align:end' : '' }, [
        el('div', { style: `display:inline-block;padding:8px 12px;border-radius:10px;background:${who === 'user' ? 'var(--brand)' : 'var(--surface-2)'};color:${who === 'user' ? '#fff' : 'var(--text)'};max-width:80%;font-size:13.5px` }, [text]),
      ]));
      chatBox.scrollTop = chatBox.scrollHeight;
    }
    addMsg('اسألني أشياء مثل "كام عميل تم إغلاقه اليوم؟" أو "مين الموظفين اللي عندهم متابعات متأخرة؟" — كل إجابة تُؤخذ مباشرة من قاعدة البيانات.', 'ai');

    async function ask() {
      const q = input.value.trim();
      if (!q) return;
      addMsg(q, 'user');
      input.value = '';
      try {
        const res = await api('/ai/ask', { method: 'POST', body: { question: q } });
        addMsg(res.answer, 'ai');
      } catch (e) {
        addMsg('حدث خطأ: ' + e.message, 'ai');
      }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });

    async function generateSummary() {
      const { summary } = await api('/ai/daily-summary');
      addMsg(
        `ملخص الفريق (${summary.timeRange}) — الإجمالي ${summary.totalCustomers} (${summary.assigned} موزّع، ${summary.unassigned} غير موزّع). ${summary.closedToday} تم إغلاقهم اليوم، ${summary.interested} مهتم، ${summary.followUp} قيد المتابعة، ${summary.overdue} متابعة متأخرة، ${summary.reopenedToday} أُعيد فتحه اليوم. مواعيد الخدمة: ${summary.slaBreaches} تجاوز، ${summary.slaWarnings} تحذير. المبيعات: ${summary.dealsToday} صفقة اليوم، صافي إيراد ${summary.netRevenueToday.toLocaleString()} ج.م اليوم.`,
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
