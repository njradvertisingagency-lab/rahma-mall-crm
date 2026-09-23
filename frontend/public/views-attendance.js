'use strict';
(function () {
  const { el, api, fmt } = App;

  // داش بورد أستاذ هاني الوحيدة والشاملة — الصفحة الوحيدة اللي حسابه بيشوفها
  // على الإطلاق (مفروضة عليه من renderRoute في app.js، مفيش شريط جانبي ولا
  // أي صفحة تانية). مقسّمة لثلاثة أقسام واضحة بناءً على طلبه صراحةً:
  //   1) "متابعة الفريق" — كل حاجة لايف عن الفريق اليوم (حضور/انصراف،
  //      نظرة عامة، مركز التحكم المباشر).
  //   2) "تحليلات الفريق" — تحليل تفصيلي لكل موظف على حدة (اليوم/أسبوع/شهر)
  //      مع رسوم بيانية، ولوحة صدارة + الإنجازات.
  //   3) "باقي الأقسام" — كل صفحات قائد الفريق المتبقية التي هي عرض بيانات
  //      بحت (تقارير + سجل الأنشطة)، باستثناء أي صفحة إدخال بيانات أو تنفيذ
  //      إجراء (استيراد عملاء، توزيع، إدارة الموظفين، الإعدادات، الدردشة...)
  //      — حسابه للمشاهدة فقط، القرارات والتنفيذ شغل التيم ليدر دائمًا.
  //
  // الأقسام 1 و2 و3 تُبنى بإعادة استخدام صفحات قائد الفريق الجاهزة نفسها
  // (App.getRouteHandler) بدل تكرار الكود — نفس البيانات الحقيقية، نفس
  // التحديث اللحظي، وأي إصلاح مستقبلي لتلك الصفحات ينعكس هنا تلقائيًا.
  // لا شيء منها يُستدعى عبر location.hash، فحساب المالك يبقى "مقفول" على
  // هذه الصفحة الواحدة كما هو مطلوب — الاستدعاء هنا مباشر لدالة الصفحة فقط.
  App.route('/attendance-dashboard', async () => {
    const container = el('div');
    container.appendChild(
      el('div', { class: 'page-header' }, [
        el('div', { class: 'page-title' }, ['📊 كل حاجة عن الشركة']),
        el('div', { class: 'badge', style: 'background:var(--success-soft);color:var(--success)' }, ['🔴 مباشر — يتحدّث أول ما حاجة تحصل']),
      ])
    );

    if (!App.state.user.isOwner) {
      return el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['🚫']), 'هذه الصفحة مخصّصة لحساب المالك فقط.']);
    }

    const embeddedCleanups = [];
    // يضمّن صفحة قائد فريق جاهزة كقسم فرعي هنا — بدون أي تنقّل فعلي
    // (location.hash ثابت طول الوقت)، ويجمع دالة التنظيف الخاصة بها حتى
    // تُستدعى مع تنظيف هذه الصفحة نفسها فتتجنّب أي تسريب مستمعين/مؤقتات.
    async function embed(pattern) {
      const handler = App.getRouteHandler(pattern);
      if (!handler) return el('div', { class: 'muted' }, [`تعذّر تحميل هذا القسم (${pattern}).`]);
      try {
        const sub = await handler();
        if (sub && typeof sub.cleanup === 'function') embeddedCleanups.push(sub.cleanup);
        return sub;
      } catch (e) {
        console.error('attendance-dashboard: embed failed', pattern, e);
        return el('div', { class: 'error-text' }, [`تعذّر تحميل هذا القسم (${pattern}): ${e.message || ''}`]);
      }
    }
    function sectionHeading(icon, title, sub) {
      return el('div', { class: 'mt-16 mb-8' }, [
        el('div', { style: 'font-weight:800;font-size:18px' }, [icon + ' ' + title]),
        sub ? el('div', { class: 'muted', style: 'font-size:12.5px' }, [sub]) : null,
      ]);
    }
    function subCard(node) {
      return el('div', { class: 'mb-16' }, [node]);
    }

    // -------------------------------------------------------------------
    // القسم ١: متابعة الفريق
    // -------------------------------------------------------------------
    container.appendChild(sectionHeading('📍', 'متابعة الفريق', 'كل حاجة بتحصل في الفريق اليوم، لحظة بلحظة.'));

    const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const dateInput = el('input', { type: 'date', value: todayStr, onchange: () => load() });
    container.appendChild(el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center' }, [
      el('label', { class: 'muted' }, ['اختر اليوم:']),
      dateInput,
      el('button', { class: 'btn btn-outline btn-sm', onclick: () => { dateInput.value = todayStr; load(); } }, ['اليوم']),
    ]));

    const summaryGrid = el('div', { class: 'kpi-grid mb-16' });
    const box = el('div');
    container.appendChild(summaryGrid);
    container.appendChild(box);

    function kpi(label, value, accent) {
      return el('div', { class: 'kpi-card' + (accent ? ' accent-' + accent : '') }, [el('div', { class: 'kpi-value' }, [String(value)]), el('div', { class: 'kpi-label' }, [label])]);
    }

    // ساعات العمل بتتحدّث كل ثانية من غير أي طلب من الخادم — نحسبها محليًا
    // من وقت الحضور المسجَّل، فتحس إن الرقم بيجري "لايف" لحظة بلحظة، وليس
    // فقط لما تحصل حادثة جديدة أو يعاد تحميل الصفحة.
    let tickingCells = []; // [{ td, checkInMs }]
    let tickInterval = null;
    function startTicking() {
      if (tickInterval) clearInterval(tickInterval);
      tickInterval = setInterval(() => {
        const now = Date.now();
        tickingCells.forEach(({ td, checkInMs }) => {
          td.textContent = fmt.duration((now - checkInMs) / 1000);
        });
      }, 1000);
    }

    async function load() {
      box.innerHTML = '';
      summaryGrid.innerHTML = '';
      box.appendChild(el('div', { class: 'muted' }, ['جارِ التحميل…']));
      tickingCells = [];
      try {
        const data = await api('/attendance/dashboard?date=' + encodeURIComponent(dateInput.value));
        box.innerHTML = '';

        if (data.isHolidayToday) {
          box.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['🌙']), 'هذا اليوم عطلة رسمية.']));
        }

        const t = data.team || {};
        summaryGrid.appendChild(kpi('حضروا اليوم', `${t.checkedIn ?? 0}/${t.headcount ?? 0}`, 'brand'));
        summaryGrid.appendChild(kpi('متأخرون اليوم', t.lateToday ?? 0, (t.lateToday || 0) > 0 ? 'danger' : 'success'));
        summaryGrid.appendChild(kpi('لم يحضروا', t.absent ?? 0, (t.absent || 0) > 0 ? 'danger' : 'success'));
        summaryGrid.appendChild(kpi('تواصل اليوم (مكالمات + واتساب)', (t.callsToday || 0) + (t.whatsappToday || 0), 'brand'));
        summaryGrid.appendChild(kpi('عملاء تم إغلاقهم اليوم', t.closedToday ?? 0, (t.closedToday || 0) > 0 ? 'success' : 'warning'));
        summaryGrid.appendChild(kpi('متابعات تمت اليوم', t.followupsDoneToday ?? 0, 'brand'));
        summaryGrid.appendChild(kpi('⚠️ عملاء محتاجة ملاحظة', t.needsNoteTotal ?? 0, (t.needsNoteTotal || 0) > 0 ? 'danger' : 'success'));
        summaryGrid.appendChild(kpi('⚠️ متابعات متأخرة', t.followupsOverdue ?? 0, (t.followupsOverdue || 0) > 0 ? 'danger' : 'success'));

        if (t.topPerformer) {
          box.appendChild(el('div', { class: 'card mb-16', style: 'padding:12px 16px' }, [
            el('span', {}, ['🏆 الأعلى أداءً اليوم: ']),
            el('strong', {}, [t.topPerformer]),
          ]));
        }

        const workers = data.people.filter((p) => p.employeeId != null).sort((a, b) => (a.rank || 99) - (b.rank || 99));
        const others = data.people.filter((p) => p.employeeId == null);

        function cell(v, warnIf) {
          const n = Number(v) || 0;
          if (warnIf && n > 0) return el('span', { class: 'badge', style: 'background:var(--danger-soft);color:var(--danger)' }, [String(n)]);
          return String(n);
        }

        function personRow(p, showRank) {
          const hoursTd = el('td', {}, [p.checkInAt ? fmt.duration(p.hoursWorkedSeconds) : '—']);
          // الشخص لسه شغال (حضر ولسه ما مضاش) وده نفس اليوم الحالي — نخليه
          // يتحدّث كل ثانية. لو بيتفرّج على يوم فات، نسيب الرقم ثابت.
          if (p.checkInAt && !p.checkOutAt && dateInput.value === todayStr) {
            tickingCells.push({ td: hoursTd, checkInMs: new Date(p.checkInAt).getTime() });
          }
          return el('tr', p.needsNoteCount > 0 || p.followupsOverdue > 0 ? { class: 'row-needs-note' } : {}, [
            el('td', {}, [showRank && p.rank ? `#${p.rank}` : '—']),
            el('td', { style: 'font-weight:700' }, [p.isOwner ? '👑 ' : '', p.name]),
            el('td', {}, [
              !p.checkInAt
                ? el('span', { class: 'badge', style: 'background:var(--danger-soft);color:var(--danger)' }, ['لم يحضر'])
                : p.isLate
                ? el('span', { class: 'badge', style: 'background:var(--warning-soft);color:var(--warning)' }, [`متأخر ${p.lateMinutes} د`])
                : el('span', { class: 'badge', style: 'background:var(--success-soft);color:var(--success)' }, ['في الميعاد']),
            ]),
            el('td', {}, [p.checkInAt ? fmt.dateTime(p.checkInAt) : '—']),
            el('td', {}, [p.checkOutAt ? fmt.dateTime(p.checkOutAt) : (p.checkInAt ? 'لا يزال في العمل' : '—')]),
            hoursTd,
            el('td', {}, [cell(p.seenToday)]),
            el('td', {}, [cell(p.callsToday)]),
            el('td', {}, [cell(p.whatsappToday)]),
            el('td', {}, [cell(p.notesToday)]),
            el('td', {}, [cell(p.followupsDoneToday)]),
            el('td', {}, [cell(p.closedToday)]),
            el('td', {}, [cell(p.needsNoteCount, true)]),
            el('td', {}, [cell(p.followupsOverdue, true)]),
            el('td', {}, [cell(p.assignedTotal)]),
            el('td', { style: 'font-weight:700' }, [String(p.activityScore ?? 0)]),
            el('td', {}, [cell(p.lateCountThisMonth)]),
            el('td', {}, [cell(p.penaltyCountThisMonth, true)]),
          ]);
        }

        const headers = [
          'الترتيب', 'الاسم', 'الحالة', 'الحضور', 'الانصراف', 'ساعات العمل',
          'عملاء فتحهم', 'مكالمات', 'واتساب', 'ملاحظات', 'متابعات تمت', 'إغلاق',
          '⚠️ محتاج ملاحظة', '⚠️ متابعات متأخرة', 'إجمالي عملائه', 'التقييم',
          'تأخيرات الشهر', 'مخالفات الشهر',
        ];

        box.appendChild(el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, headers.map((h) => el('th', {}, [h])))]),
            el('tbody', {}, [
              ...workers.map((p) => personRow(p, true)),
              ...others.map((p) => personRow(p, false)),
            ]),
          ]),
        ]));

        box.appendChild(el('div', { class: 'muted mt-12', style: 'font-size:12px;line-height:1.9' }, [
          'التقييم = (مكالمات + واتساب + ملاحظات) + (إغلاق×3 + متابعات تمت×2) − (محتاج ملاحظة + متابعات متأخرة)×2 − تأخير اليوم×2. ',
          'رقم إرشادي للمقارنة بين الموظفين في نفس اليوم فقط — وليس أساسًا للخصم.',
        ]));

        startTicking();
      } catch (e) {
        box.innerHTML = '';
        box.appendChild(el('div', { class: 'error-text' }, [e.message || 'تعذّر تحميل بيانات الحضور']));
      }
    }

    // نشاط قادة الفريق (تسجيل دخول، عملاء أنشأهم، توزيعات، صفقات...) —
    // جزء من "كل حاجة عن الشركة" بردو، لكن بيتحدّث كل شوية مش لحظيًا زي
    // جدول الحضور، لأنه استعلام أثقل (تسعة أرقام لكل قائد فريق).
    const tlBox = el('div', { class: 'mt-16' });
    container.appendChild(el('div', { class: 'section-title mt-16 mb-8', style: 'font-weight:800' }, ['👑 نشاط حسابات قادة الفريق']));
    container.appendChild(tlBox);

    async function loadTeamLeaders() {
      try {
        const { teamLeaders } = await api('/employees/team-leader-performance');
        tlBox.innerHTML = '';
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
          tlBox.appendChild(card);
        });
        if (teamLeaders.length === 0) tlBox.appendChild(el('div', { class: 'empty-state' }, ['لا توجد حسابات قائد فريق.']));
      } catch (e) {
        tlBox.innerHTML = '';
        tlBox.appendChild(el('div', { class: 'error-text' }, [e.message]));
      }
    }

    // "لوحة التحكم" و"مركز التحكم المباشر" الجاهزتين — نفس صفحات قائد
    // الفريق، مضمّنتين هنا كما هما (نظرة عامة + تواجد الفريق + مبيعات
    // اليوم + قمع اليوم + يحتاج انتباه + جدول الموظفين المباشر).
    const dashboardWrap = el('div');
    const commandCenterWrap = el('div');
    container.appendChild(subCard(dashboardWrap));
    container.appendChild(subCard(commandCenterWrap));

    // -------------------------------------------------------------------
    // القسم ٢: تحليلات الفريق
    // -------------------------------------------------------------------
    container.appendChild(sectionHeading('📈', 'تحليلات الفريق', 'تحليل تفصيلي لكل موظف على حدة — اليوم / آخر ٧ أيام / آخر ٣٠ يوم.'));
    const analyticsWrap = el('div');
    const leaderboardWrap = el('div');
    container.appendChild(subCard(analyticsWrap));
    container.appendChild(subCard(leaderboardWrap));

    // -------------------------------------------------------------------
    // القسم ٣: باقي الأقسام (عرض فقط — بدون أي صفحة إدخال بيانات أو تنفيذ
    // إجراء، مثل استيراد العملاء أو توزيعهم أو إدارة الموظفين أو الإعدادات)
    // -------------------------------------------------------------------
    container.appendChild(sectionHeading('📋', 'باقي الأقسام', 'تقارير وسجل الأنشطة — عرض فقط.'));
    const reportsWrap = el('div');
    const activityWrap = el('div');
    container.appendChild(subCard(reportsWrap));
    container.appendChild(subCard(activityWrap));

    async function loadEmbeddedSections() {
      const [dashboardEl, commandCenterEl, analyticsEl, leaderboardEl, reportsEl, activityEl] = await Promise.all([
        embed('/dashboard'),
        embed('/command-center'),
        embed('/analytics'),
        embed('/leaderboard'),
        embed('/reports'),
        embed('/activity'),
      ]);
      dashboardWrap.innerHTML = ''; if (dashboardEl) dashboardWrap.appendChild(dashboardEl);
      commandCenterWrap.innerHTML = ''; if (commandCenterEl) commandCenterWrap.appendChild(commandCenterEl);
      analyticsWrap.innerHTML = ''; if (analyticsEl) analyticsWrap.appendChild(analyticsEl);
      leaderboardWrap.innerHTML = ''; if (leaderboardEl) leaderboardWrap.appendChild(leaderboardEl);
      reportsWrap.innerHTML = ''; if (reportsEl) reportsWrap.appendChild(reportsEl);
      activityWrap.innerHTML = ''; if (activityEl) activityWrap.appendChild(activityEl);
    }

    // تحديث لحظي: أي حدث حقيقي في الشركة (اتصال، ملاحظة، بصمة، عميل جديد،
    // صفقة، متابعة...) يوصل عن طريق نفس اتصال الـ WebSocket المستخدم في كل
    // الموقع، فنعيد تحميل الجدول فورًا — بدون أي "polling" أو طلبات زيادة
    // لما محدّش شغال. الـ debounce بسيط عشان لو حصلت أحداث كتير مع بعض
    // (استيراد عملاء مثلًا) نحمّل مرة واحدة مش عشرات المرات.
    let reloadTimer = null;
    function scheduleReload() {
      if (dateInput.value !== todayStr) return; // العرض على يوم فات ميتغيرش لوحده
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 400);
    }

    await load();
    await loadTeamLeaders();
    await loadEmbeddedSections();
    const tlInterval = setInterval(loadTeamLeaders, 2 * 60 * 1000);
    const offAny = App.on('rt:*', scheduleReload);
    container.cleanup = () => {
      offAny && offAny();
      clearInterval(tlInterval);
      if (tickInterval) clearInterval(tickInterval);
      clearTimeout(reloadTimer);
      embeddedCleanups.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    };
    return container;
  }, { roles: ['team_leader'] });
})();
