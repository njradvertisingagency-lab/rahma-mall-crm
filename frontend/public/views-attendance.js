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

        const checkedIn = data.people.filter((p) => p.checkInAt).length;
        const lateToday = data.people.filter((p) => p.isLate).length;
        const penalties = data.people.reduce((s, p) => s + p.penaltyCountThisMonth, 0);
        summaryGrid.appendChild(kpi('حضروا اليوم', `${checkedIn}/${data.people.length}`, 'brand'));
        summaryGrid.appendChild(kpi('متأخرون اليوم', lateToday, lateToday > 0 ? 'danger' : 'success'));
        summaryGrid.appendChild(kpi('مخالفات هذا الشهر', penalties, penalties > 0 ? 'warning' : 'success'));

        box.appendChild(el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['الاسم', 'الدور', 'الحضور', 'الانصراف', 'ساعات العمل', 'الحالة', 'مكالمات اليوم', 'مغلق اليوم', 'تأخيرات الشهر', 'مخالفات الشهر'].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, data.people.map((p) => el('tr', {}, [
              el('td', { style: 'font-weight:700' }, [p.isOwner ? '👑 ' : '', p.name]),
              el('td', {}, [p.role === 'team_leader' ? 'قائد الفريق' : 'موظف']),
              el('td', {}, [p.checkInAt ? fmt.dateTime(p.checkInAt) : '—']),
              el('td', {}, [p.checkOutAt ? fmt.dateTime(p.checkOutAt) : (p.checkInAt ? 'لا يزال في العمل' : '—')]),
              el('td', {}, [p.checkInAt ? fmt.duration(p.hoursWorkedSeconds) : '—']),
              el('td', {}, [
                !p.checkInAt
                  ? el('span', { class: 'badge', style: 'background:var(--danger-soft);color:var(--danger)' }, ['لم يحضر'])
                  : p.isLate
                  ? el('span', { class: 'badge', style: 'background:var(--warning-soft);color:var(--warning)' }, [`متأخر ${p.lateMinutes} د`])
                  : el('span', { class: 'badge', style: 'background:var(--success-soft);color:var(--success)' }, ['في الميعاد']),
              ]),
              el('td', {}, [String(p.callsToday)]),
              el('td', {}, [String(p.closedToday)]),
              el('td', {}, [String(p.lateCountThisMonth)]),
              el('td', {}, [p.penaltyCountThisMonth > 0 ? el('span', { class: 'badge', style: 'background:var(--danger-soft);color:var(--danger)' }, [String(p.penaltyCountThisMonth)]) : '0']),
            ]))),
          ]),
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
