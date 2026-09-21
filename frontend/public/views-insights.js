'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  function barChart(data, opts) {
    opts = opts || {};
    const max = Math.max(1, ...data.map((d) => d.value));
    return el('div', { class: 'bar-chart' }, data.map((d) =>
      el('div', { class: 'bar-col' }, [
        el('div', { class: 'bar-value' }, [String(d.value)]),
        el('div', { class: 'bar', style: `height:${Math.max(4, (d.value / max) * 120)}px;background:${opts.color || 'var(--brand-2)'}` }),
        el('div', { class: 'bar-label' }, [String(d.label).slice(0, 10)]),
      ])
    ));
  }

  // رسم بياني خطي بسيط (SVG) — لمقارنة أداء الموظف عبر الوقت، بدلاً من نقطة اليوم فقط.
  function lineChart(series, opts) {
    opts = opts || {};
    const w = opts.width || 640, h = opts.height || 160, pad = 24;
    if (!series.length) return el('div', { class: 'muted' }, ['لا توجد بيانات كافية بعد لعرض اتجاه الأداء.']);
    const values = series.map((s) => s.value);
    const min = Math.min(0, ...values);
    const max = Math.max(1, ...values);
    const range = max - min || 1;
    const stepX = series.length > 1 ? (w - pad * 2) / (series.length - 1) : 0;
    const points = series.map((s, i) => {
      const x = pad + i * stepX;
      const y = h - pad - ((s.value - min) / range) * (h - pad * 2);
      return [x, y];
    });
    const pathD = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaD = pathD + ` L${points[points.length - 1][0].toFixed(1)},${h - pad} L${points[0][0].toFixed(1)},${h - pad} Z`;
    const color = opts.color || 'var(--brand-2)';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('style', 'display:block');
    svg.innerHTML = `
      <path d="${areaD}" fill="${color}" opacity="0.12" stroke="none"></path>
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>
      ${points.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"></circle>`).join('')}
    `;
    const wrap = el('div', {}, [svg]);
    const labels = el('div', { class: 'flex-between', style: 'font-size:10.5px;color:var(--text-muted);margin-top:4px' }, [
      el('span', {}, [series[0].label]), el('span', {}, [series[series.length - 1].label]),
    ]);
    wrap.appendChild(labels);
    return wrap;
  }

  const BADGE_ICONS = { FASTEST_RESPONSE_WEEK: '⚡', TOP_CLOSER_MONTH: '🥇', FOLLOWUP_CHAMPION_WEEK: '🎯', ZERO_COMPLAINTS_MONTH: '🌟' };
  function badgeChip(b) {
    return el('span', { class: 'badge', style: 'background:var(--brand-soft);color:var(--text);font-size:12px;padding:6px 12px' }, [
      `${b.icon || BADGE_ICONS[b.key] || '🏅'} ${b.label} — ${b.employeeName}${b.detail ? ' (' + b.detail + ')' : ''}`,
    ]);
  }
  async function renderBadgesSection(filterEmployeeId) {
    const wrap = el('div', { class: 'card card-pad mb-16' });
    wrap.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['🏅 الإنجازات والبادجات']));
    try {
      const { weekly, monthly } = await api('/employees/badges');
      const w = filterEmployeeId ? weekly.filter((b) => b.employeeId === filterEmployeeId) : weekly;
      const m = filterEmployeeId ? monthly.filter((b) => b.employeeId === filterEmployeeId) : monthly;
      if (w.length === 0 && m.length === 0) {
        wrap.appendChild(el('div', { class: 'muted' }, ['لا توجد إنجازات محقّقة بعد.']));
        return wrap;
      }
      if (w.length) {
        wrap.appendChild(el('div', { class: 'faint mb-8' }, ['هذا الأسبوع']));
        wrap.appendChild(el('div', { class: 'flex gap-8 wrap mb-12' }, w.map(badgeChip)));
      }
      if (m.length) {
        wrap.appendChild(el('div', { class: 'faint mb-8' }, ['هذا الشهر']));
        wrap.appendChild(el('div', { class: 'flex gap-8 wrap' }, m.map(badgeChip)));
      }
    } catch {
      wrap.appendChild(el('div', { class: 'muted' }, ['تعذّر تحميل الإنجازات.']));
    }
    return wrap;
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
      const STATUS_LABELS = App.labels.status;
      grid.appendChild(chartCard('العملاء حسب الموظف', data.customersByEmployee));
      grid.appendChild(chartCard('توزيع الحالات', data.statusDistribution.map((r) => ({ ...r, label: STATUS_LABELS[r.label] || r.label }))));
      grid.appendChild(chartCard('النشاط اليومي', data.dailyActivity));
      grid.appendChild(chartCard('حسب المصدر', data.bySource.map((r) => ({ ...r, label: r.label === 'Unknown' ? 'غير معروف' : r.label }))));
      grid.appendChild(chartCard('حسب الحملة', data.byCampaign.map((r) => ({ ...r, label: r.label === 'Unknown' ? 'غير معروف' : r.label }))));
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
    container.appendChild(await renderBadgesSection(me.id));
    const card = el('div', { class: 'card card-pad' });
    card.appendChild(el('div', { class: 'kpi-grid' }, [
      ['موزّع', me.assigned], ['مغلق', me.closed], ['متابعات مكتملة', me.followupsCompleted], ['متابعات متأخرة', me.followupsOverdue],
    ].map(([l, v]) => el('div', { class: 'kpi-card' }, [el('div', { class: 'kpi-value' }, [String(v)]), el('div', { class: 'kpi-label' }, [l])]))));
    card.appendChild(el('div', { class: 'mt-16' }, [el('div', { class: 'flex-between mb-8' }, [el('span', {}, ['نسبة الإنجاز']), el('span', {}, [Math.round(me.completionRate * 100) + '%'])]), el('div', { class: 'progress-bar' }, [el('div', { style: `width:${Math.round(me.completionRate * 100)}%` })])]));
    container.appendChild(card);

    // مقارنة أداء عبر الوقت — الاتجاه بدلًا من لقطة اليوم فقط.
    // ملاحظة: نحتفظ بمرجع مباشر لعنصر <select> (trendRangeSel) بدلاً من
    // البحث عنه بـ document.getElementById، لأن loadTrend() يُستدعى أول
    // مرة أثناء بناء الصفحة — قبل أن يُلحق الراوتر العنصر بالـ DOM الفعلي —
    // فيرجع getElementById قيمة null وقتها ويكسر الصفحة بالكامل.
    const trendRangeSel = el('select', { onchange: loadTrend }, [['7', 'آخر ٧ أيام'], ['30', 'آخر ٣٠ يوم'], ['90', 'آخر ٩٠ يوم']].map(([v, l]) => el('option', { value: v, selected: v === '30' || undefined }, [l])));
    const trendCard = el('div', { class: 'card card-pad mt-16' });
    trendCard.appendChild(el('div', { class: 'flex-between mb-8' }, [
      el('div', { style: 'font-weight:800' }, ['📈 اتجاه الأداء']),
      trendRangeSel,
    ]));
    const trendBox = el('div');
    trendCard.appendChild(trendBox);
    container.appendChild(trendCard);
    async function loadTrend() {
      try {
        const days = trendRangeSel.value;
        const { history } = await api('/employees/' + me.id + '/performance-history?days=' + days);
        trendBox.innerHTML = '';
        trendBox.appendChild(lineChart(history.map((h) => ({ label: h.date.slice(5), value: h.score })), { color: 'var(--brand-2)' }));
      } catch (e) { toast(e.message, 'error'); }
    }
    await loadTrend();

    // وقت أونلاين على الموقع — من نظام الحضور الفعلي (تسجيل دخول/خروج + نبضات
    // نشاط)، وليس رقمًا مُقدَّرًا. "اليوم" و"هذا الأسبوع" من سجل الجلسات
    // الفعلي، و"الإجمالي" من عداد العمر الكلي لحالة employee_presence.
    const onlineCard = el('div', { class: 'card card-pad mt-16' });
    onlineCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['⏱ الوقت أونلاين على الموقع']));
    const onlineBox = el('div', { class: 'muted' }, ['جارِ التحميل…']);
    onlineCard.appendChild(onlineBox);
    container.appendChild(onlineCard);
    async function loadOnlineTime() {
      try {
        const { onlineTime } = await api('/presence/me');
        onlineBox.innerHTML = '';
        if (!onlineTime) { onlineBox.appendChild(el('div', { class: 'muted' }, ['غير متاح لهذا الحساب.'])); return; }
        onlineBox.appendChild(el('div', { class: 'kpi-grid' }, [
          ['اليوم', App.fmt.duration(onlineTime.todaySeconds)],
          ['هذا الأسبوع', App.fmt.duration(onlineTime.weekSeconds)],
          ['الإجمالي منذ البداية', App.fmt.duration(onlineTime.allTimeSeconds)],
        ].map(([l, v]) => el('div', { class: 'kpi-card' }, [el('div', { class: 'kpi-value', style: 'font-size:18px' }, [v]), el('div', { class: 'kpi-label' }, [l])]))));
        const statusRow = el('div', { class: 'flex-between mt-12' }, [
          el('span', { class: 'muted' }, ['الحالة الآن']),
          badges.presence({ online: onlineTime.online, activityState: onlineTime.activityState }),
        ]);
        onlineBox.appendChild(statusRow);
        if (onlineTime.online && onlineTime.currentSessionDurationSeconds) {
          onlineBox.appendChild(el('div', { class: 'faint mt-4' }, [`الجلسة الحالية مستمرة منذ ${App.fmt.duration(onlineTime.currentSessionDurationSeconds)}`]));
        } else if (onlineTime.lastLogoutAt) {
          onlineBox.appendChild(el('div', { class: 'faint mt-4' }, [`آخر تسجيل خروج: ${fmt.ago(onlineTime.lastLogoutAt)}`]));
        }
      } catch (e) {
        onlineBox.innerHTML = '';
        onlineBox.appendChild(el('div', { class: 'muted' }, ['تعذّر تحميل بيانات الوقت أونلاين.']));
      }
    }
    await loadOnlineTime();

    // سجل كامل لكل حدث قام به هذا الموظف أو تعلّق بأحد عملائه — نفس البيانات
    // المستخدمة في صفحة "سجل الأنشطة" الخاصة بقائد الفريق (GET /activity)،
    // والتي تُقيَّد تلقائيًا في الـ backend لحساب الموظف على نشاطه هو فقط.
    const activityCard = el('div', { class: 'card card-pad mt-16' });
    activityCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['📋 كل نشاطاتي']));
    const activityBox = el('div', { class: 'muted' }, ['جارِ التحميل…']);
    activityCard.appendChild(activityBox);
    const moreBtnWrap = el('div', { class: 'mt-12', style: 'text-align:center' });
    activityCard.appendChild(moreBtnWrap);
    container.appendChild(activityCard);

    const ACTIVITY_PAGE_SIZE = 20;
    let activityPage = 1;
    let loadedActivity = [];
    function renderActivity() {
      activityBox.innerHTML = '';
      if (loadedActivity.length === 0) { activityBox.appendChild(el('div', { class: 'empty-state' }, ['لا يوجد نشاط مسجّل بعد.'])); return; }
      activityBox.appendChild(el('div', { class: 'timeline' }, loadedActivity.map((a) => el('div', { class: 'timeline-item' }, [
        el('div', { class: 'timeline-time' }, [fmt.dateTime(a.created_at)]),
        el('div', { class: 'timeline-text' }, [
          (App.labels.activity[a.action] || a.action.replace(/_/g, ' ').toLowerCase()) + (a.entity_id ? ' · ' + a.entity_id : ''),
        ]),
      ]))));
    }
    async function loadActivity(append) {
      try {
        const { activity } = await api(`/activity?page=${activityPage}&pageSize=${ACTIVITY_PAGE_SIZE}`);
        loadedActivity = append ? loadedActivity.concat(activity) : activity;
        renderActivity();
        moreBtnWrap.innerHTML = '';
        if (activity.length === ACTIVITY_PAGE_SIZE) {
          moreBtnWrap.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: () => { activityPage++; loadActivity(true); } }, ['تحميل المزيد']));
        }
      } catch (e) {
        activityBox.innerHTML = '';
        activityBox.appendChild(el('div', { class: 'muted' }, ['تعذّر تحميل سجل الأنشطة.']));
      }
    }
    await loadActivity(false);

    return container;
  });

  App.route('/leaderboard', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['لوحة الصدارة'])]));
    container.appendChild(await renderBadgesSection());
    const { employees, weights } = await api('/employees');
    let sortKey = 'performanceScore';
    let expandedId = null;
    const box = el('div');
    container.appendChild(box);

    function render() {
      const sorted = [...employees].sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [
            ['name', 'الموظف'], ['assigned', 'موزّع'], ['closed', 'مغلق'], ['followupsCompleted', 'المتابعات'], ['followupsOverdue', 'متأخر'], ['completionRate', 'الإنجاز'], ['performanceScore', 'النقاط'], ['', ''],
          ].map(([key, label]) => el('th', { style: key ? 'cursor:pointer' : '', onclick: key ? () => { sortKey = key; render(); } : undefined }, [label + (key && sortKey === key ? ' ▾' : '')])))]),
          el('tbody', {}, sorted.map((e, i) => el('tr', {}, [
            el('td', {}, [el('span', { style: 'font-weight:800' }, [i === 0 ? '🏆 ' : '']), e.name]),
            el('td', {}, [String(e.assigned)]),
            el('td', {}, [String(e.closed)]),
            el('td', {}, [`${e.followupsCompleted}/${e.followupsTotal}`]),
            el('td', {}, [String(e.followupsOverdue)]),
            el('td', {}, [Math.round(e.completionRate * 100) + '%']),
            el('td', { style: 'font-weight:800' }, [String(e.performanceScore)]),
            el('td', {}, [el('button', { class: 'btn btn-sm btn-outline', onclick: () => { expandedId = expandedId === e.id ? null : e.id; renderTrend(); } }, ['📈 الاتجاه'])]),
          ]))),
        ]),
      ]));
      renderTrend();
    }
    async function renderTrend() {
      const old = box.querySelector('.leaderboard-trend');
      if (old) old.remove();
      if (!expandedId) return;
      const emp = employees.find((e) => e.id === expandedId);
      const trendCard = el('div', { class: 'card card-pad mt-16 leaderboard-trend' });
      trendCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:8px' }, [`📈 اتجاه أداء — ${emp?.name || ''}`]));
      const trendBox = el('div', { class: 'muted' }, ['جارِ التحميل…']);
      trendCard.appendChild(trendBox);
      box.appendChild(trendCard);
      try {
        const { history } = await api('/employees/' + expandedId + '/performance-history?days=30');
        trendBox.innerHTML = '';
        trendBox.appendChild(lineChart(history.map((h) => ({ label: h.date.slice(5), value: h.score })), { color: 'var(--brand-2)' }));
      } catch (e) { trendBox.textContent = e.message; }
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
      ['sales-attribution', 'تقرير التواصل ← المبيعات', 'موزّع/شوهد/تم التواصل/صفقات/إيراد لكل موظف.'],
    ];
    container.appendChild(el('div', { class: 'kpi-grid' }, reports.map(([key, title, desc]) =>
      el('div', { class: 'card card-pad' }, [
        el('div', { style: 'font-weight:800' }, [title]),
        el('div', { class: 'muted mt-8', style: 'font-size:12.5px' }, [desc]),
        el('button', { class: 'btn btn-primary btn-sm mt-12', onclick: async (e) => {
          const btn = e.target;
          const original = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'جارِ التصدير…';
          try {
            await App.downloadFile('/reports/' + key, key + '.csv');
          } catch (err) {
            App.toast(err.message || 'فشل تصدير التقرير', 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = original;
          }
        } }, ['⬇ تصدير CSV']),
      ])
    )));
    return container;
  }, { roles: ['team_leader'] });

  // خاص بحساب المالك فقط — رؤية شاملة لنشاط/أداء حسابات قائد الفريق نفسها.
  App.route('/team-leader-performance', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['👑 أداء قائد الفريق'])]));
    if (!App.state.user.isOwner) {
      return el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['🚫']), 'هذه الصفحة مخصّصة لحساب المالك فقط.']);
    }
    container.appendChild(el('div', { class: 'muted mb-16' }, ['نظرة شاملة على نشاط كل حسابات قائد الفريق — مبنية بالكامل من سجل الأنشطة الفعلي، بلا أي تقييم مُخترَع.']));
    const box = el('div');
    container.appendChild(box);
    try {
      const { teamLeaders } = await api('/employees/team-leader-performance');
      teamLeaders.forEach((tl) => {
        const card = el('div', { class: 'card card-pad mb-16' });
        card.appendChild(el('div', { class: 'flex-between mb-12' }, [
          el('div', { style: 'font-weight:800' }, [tl.isOwner ? '👑 ' : '🧑‍💼 ', tl.displayName, el('span', { class: 'faint' }, [' @' + tl.username])]),
          el('div', { class: 'faint' }, [tl.lastLoginAt ? 'آخر دخول: ' + fmt.ago(tl.lastLoginAt) : 'لم يسجّل دخول بعد']),
        ]));
        card.appendChild(el('div', { class: 'kpi-grid' }, [
          ['عمليات دخول', tl.loginCount], ['عملاء أُنشئوا', tl.customersCreated], ['استيراد عملاء', tl.customersImported],
          ['توزيعات', tl.distributionsCreated], ['صفقات مسجّلة', tl.dealsRecorded], ['إدارة موظفين', tl.employeesManaged],
          ['شكاوى سجّلها', tl.complaintsLogged], ['رسائل دردشة', tl.chatMessagesSent],
        ].map(([l, v]) => el('div', { class: 'kpi-card' }, [el('div', { class: 'kpi-value' }, [String(v)]), el('div', { class: 'kpi-label' }, [l])]))));
        box.appendChild(card);
      });
      if (teamLeaders.length === 0) box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد حسابات قائد فريق.']));
    } catch (e) {
      box.appendChild(el('div', { class: 'empty-state' }, [e.message]));
    }
    return container;
  }, { roles: ['team_leader'] });

  App.route('/ai', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['المساعد الذكي']),
      el('div', { class: 'flex gap-8 wrap' }, [
        el('button', { class: 'btn btn-outline', onclick: generateSummary }, ['إنشاء ملخص اليوم']),
        el('button', { class: 'btn btn-outline', onclick: generateInsights }, ['إنشاء ملاحظات تشغيلية']),
      ]),
    ]));

    const chatBox = el('div', { class: 'card card-pad', style: 'min-height:260px;max-height:420px;overflow-y:auto;margin-bottom:14px' });
    container.appendChild(chatBox);
    const input = el('input', { placeholder: 'اسأل عن بياناتك، مثال: "كام عميل غير موزّع؟"' });
    container.appendChild(el('div', { class: 'flex gap-8 wrap' }, [input, el('button', { class: 'btn btn-primary', onclick: ask }, ['اسأل'])]));

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
