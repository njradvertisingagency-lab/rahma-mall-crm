'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;
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
  }, { roles: ['team_leader'], denyIfPlainSalesLead: true });

  // ملحوظة: صفحة "أداء قائد الفريق" المنفصلة اتدمجت جوه /attendance-dashboard
  // (views-attendance.js) — بناءً على طلب المالك بداش بورد واحدة بس تجمع كل
  // حاجة عن الشركة، بدل ما تكون منتشرة في أكتر من صفحة.

})();
