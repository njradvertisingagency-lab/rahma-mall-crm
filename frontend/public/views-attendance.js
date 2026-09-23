'use strict';
(function () {
  const { el, api, fmt } = App;

  // داش بورد أستاذ هاني الكبيرة — كل موظف (وقائد الفريق نفسه) في صفحة واحدة:
  // جه امتى، مشي امتى، عمل ايه (مكالمات/إغلاق اليوم)، عدد ساعات عمله، وحالة
  // التأخير/المخالفات هذا الشهر. مبني بالكامل من بيانات حقيقية (attendance
  // + call_attempts + customer_status_history) — لا شيء مُخترَع. مخصّص
  // لحساب المالك فقط، ولا يظهر رابطه في القائمة الجانبية لغير حسابه.
  App.route('/attendance-dashboard', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['🕒 حضور وانصراف الفريق'])]));

    if (!App.state.user.isOwner) {
      return el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['🚫']), 'هذه الصفحة مخصّصة لحساب المالك فقط.']);
    }

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

    async function load() {
      box.innerHTML = '';
      summaryGrid.innerHTML = '';
      box.appendChild(el('div', { class: 'muted' }, ['جارِ التحميل…']));
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
            el('td', {}, [p.checkInAt ? fmt.duration(p.hoursWorkedSeconds) : '—']),
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
      } catch (e) {
        box.innerHTML = '';
        box.appendChild(el('div', { class: 'error-text' }, [e.message || 'تعذّر تحميل بيانات الحضور']));
      }
    }

    await load();
    const offs = [
      App.on('rt:ATTENDANCE_CHECKED_IN', load),
      App.on('rt:ATTENDANCE_CHECKED_OUT', load),
      App.on('rt:ATTENDANCE_PENALTY', load),
    ];
    container.cleanup = () => offs.forEach((off) => off && off());
    return container;
  }, { roles: ['team_leader'] });
})();
