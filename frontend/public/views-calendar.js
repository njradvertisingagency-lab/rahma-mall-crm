'use strict';
(function () {
  const { el, api, toast, fmt } = App;
  const WEEKDAYS_AR = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
  const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const FOLLOWUP_STATUS_LABELS = { UPCOMING: 'قادمة', DUE: 'مستحقة', OVERDUE: 'متأخرة', COMPLETED: 'مكتملة', CANCELLED: 'ملغاة' };
  const STATUS_DOT = { OVERDUE: 'var(--danger)', DUE: 'var(--warning)', UPCOMING: 'var(--info)', COMPLETED: 'var(--success)', CANCELLED: 'var(--gray)' };

  function dateKey(d) { return d.toISOString().slice(0, 10); }

  App.route('/calendar', async () => {
    const user = App.state.user;
    const container = el('div');
    let cursor = new Date();
    cursor.setDate(1);
    let followups = [];
    let selectedDay = null;

    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['🗓️ تقويم المتابعات']),
      el('div', { class: 'flex gap-8' }, [
        el('button', { class: 'btn btn-sm btn-outline', onclick: () => { cursor.setMonth(cursor.getMonth() - 1); render(); } }, ['‹ السابق']),
        el('button', { class: 'btn btn-sm btn-outline', onclick: () => { cursor = new Date(); cursor.setDate(1); render(); } }, ['اليوم']),
        el('button', { class: 'btn btn-sm btn-outline', onclick: () => { cursor.setMonth(cursor.getMonth() + 1); render(); } }, ['التالي ›']),
      ]),
    ]));

    const monthLabel = el('div', { style: 'font-weight:800;font-size:16px;margin-bottom:12px' });
    container.appendChild(monthLabel);
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:18px' });
    container.appendChild(grid);
    const dayPanel = el('div');
    container.appendChild(dayPanel);

    async function loadFollowups() {
      const { followups: all } = await api('/followups');
      followups = all;
    }

    function render() {
      monthLabel.textContent = `${MONTHS_AR[cursor.getMonth()]} ${cursor.getFullYear()}`;
      grid.innerHTML = '';
      WEEKDAYS_AR.forEach((w) => grid.appendChild(el('div', { style: 'text-align:center;font-size:11.5px;font-weight:700;color:var(--text-muted);padding:4px' }, [w])));

      const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const startOffset = firstDay.getDay();
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const todayKey = dateKey(new Date());

      const byDay = {};
      followups.forEach((f) => {
        const k = (f.scheduledFor || '').slice(0, 10);
        (byDay[k] = byDay[k] || []).push(f);
      });

      for (let i = 0; i < startOffset; i++) grid.appendChild(el('div'));
      for (let d = 1; d <= daysInMonth; d++) {
        const dObj = new Date(cursor.getFullYear(), cursor.getMonth(), d);
        const k = dateKey(dObj);
        const items = byDay[k] || [];
        const isToday = k === todayKey;
        const cell = el('div', {
          style: `min-height:74px;border:1px solid var(--border);border-radius:8px;padding:6px;cursor:pointer;background:${isToday ? 'var(--brand-soft)' : 'var(--surface)'};${selectedDay === k ? 'outline:2px solid var(--brand)' : ''}`,
          onclick: () => { selectedDay = k; renderDayPanel(); },
        }, [
          el('div', { style: 'font-size:12px;font-weight:700' }, [String(d)]),
        ]);
        const dotsRow = el('div', { style: 'display:flex;gap:3px;flex-wrap:wrap;margin-top:4px' });
        items.slice(0, 6).forEach((f) => dotsRow.appendChild(el('span', { style: `width:7px;height:7px;border-radius:50%;background:${STATUS_DOT[f.status] || 'var(--gray)'}` })));
        cell.appendChild(dotsRow);
        if (items.length > 6) cell.appendChild(el('div', { class: 'faint', style: 'font-size:10px' }, [`+${items.length - 6}`]));
        grid.appendChild(cell);
      }
      renderDayPanel();
    }

    function renderDayPanel() {
      dayPanel.innerHTML = '';
      if (!selectedDay) {
        dayPanel.appendChild(el('div', { class: 'muted' }, ['اختر يومًا من التقويم لعرض متابعاته.']));
        return;
      }
      const items = followups.filter((f) => (f.scheduledFor || '').slice(0, 10) === selectedDay);
      dayPanel.appendChild(el('div', { class: 'section-title' }, [`متابعات يوم ${fmt.date(selectedDay + 'T00:00:00.000Z')}`]));
      if (items.length === 0) {
        dayPanel.appendChild(el('div', { class: 'empty-state' }, ['لا توجد متابعات في هذا اليوم.']));
        return;
      }
      dayPanel.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(user.role === 'team_leader' ? ['الموظف'] : []), 'العميل', 'الوقت', 'السبب', 'الحالة', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, items.map((f) => el('tr', {}, [
            ...(user.role === 'team_leader' ? [el('td', {}, [f.employeeName || '—'])] : []),
            el('td', {}, [el('a', { href: '#/customers/' + f.customerId }, [f.customerName || f.customerId])]),
            el('td', {}, [fmt.dateTime(f.scheduledFor).split('،').pop()]),
            el('td', {}, [f.reason || '—']),
            el('td', {}, [el('span', { class: 'badge badge-' + (f.status === 'OVERDUE' ? 'overdue' : f.status.toLowerCase()) }, [FOLLOWUP_STATUS_LABELS[f.status] || f.status])]),
            el('td', {}, [f.status === 'UPCOMING' || f.status === 'DUE' || f.status === 'OVERDUE' ? el('button', { class: 'btn btn-sm btn-success', onclick: async () => { await api('/followups/' + f.id + '/complete', { method: 'POST' }); await loadFollowups(); render(); } }, ['إنجاز']) : '']),
          ]))),
        ]),
      ]));
    }

    await loadFollowups();
    render();
    const off = App.onRealtime(async () => { await loadFollowups(); render(); }, 8000);
    container.cleanup = () => off();
    return container;
  }, { denyIfPlainSalesLead: true });
})();
