'use strict';
(function () {
  const { el, api, toast, fmt } = App;

  App.route('/complaints', async () => {
    const user = App.state.user;
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['🚩 سجل الشكاوى'])]));

    let employees = [];
    if (user.role === 'team_leader') {
      try { employees = (await api('/employees')).employees; } catch {}
    }

    if (user.role === 'team_leader') {
      const statsBox = el('div', { class: 'kpi-grid' });
      container.appendChild(el('div', { class: 'section-title' }, ['نسبة الشكاوى لكل موظف']));
      container.appendChild(statsBox);
      try {
        const { stats } = await api('/complaints/stats');
        stats.forEach((s) => {
          statsBox.appendChild(el('div', { class: 'kpi-card' + (s.complaints > 0 ? ' accent-danger' : ' accent-success') }, [
            el('div', { class: 'kpi-value' }, [String(s.complaints)]),
            el('div', { class: 'kpi-label' }, [`${s.employeeName} — ${s.rate}% من عملائه`]),
          ]));
        });
        if (stats.length === 0) statsBox.appendChild(el('div', { class: 'muted' }, ['لا يوجد موظفون نشطون بعد.']));
      } catch (e) { toast(e.message, 'error'); }
    }

    const filterBar = el('div', { class: 'filters-bar' });
    let empSel = null;
    if (user.role === 'team_leader') {
      empSel = el('select', {}, [el('option', { value: '' }, ['كل الموظفين']), ...employees.map((e) => el('option', { value: e.id }, [e.name]))]);
      filterBar.appendChild(empSel);
      filterBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: load }, ['تصفية']));
    }
    container.appendChild(el('div', { class: 'section-title' }, ['كل الشكاوى']));
    container.appendChild(filterBar);
    const box = el('div');
    container.appendChild(box);

    async function load() {
      const q = new URLSearchParams();
      if (empSel && empSel.value) q.set('employeeId', empSel.value);
      const { complaints } = await api('/complaints?' + q.toString());
      box.innerHTML = '';
      if (complaints.length === 0) {
        box.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['🚩']), 'لا توجد شكاوى مسجّلة.']));
        return;
      }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(user.role === 'team_leader' ? ['الموظف'] : []), 'العميل', 'النص', 'بواسطة', 'التاريخ', ...(user.role === 'team_leader' ? [''] : [])].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, complaints.map((cp) => el('tr', {}, [
            ...(user.role === 'team_leader' ? [el('td', {}, [cp.employeeName || '—'])] : []),
            el('td', {}, [el('a', { href: '#/customers/' + cp.customerId }, [cp.customerName || cp.customerId])]),
            el('td', { style: 'max-width:320px;white-space:pre-wrap' }, [cp.text]),
            el('td', {}, [cp.createdByName || '—']),
            el('td', {}, [fmt.dateTime(cp.createdAt)]),
            ...(user.role === 'team_leader' ? [el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', onclick: async () => { if (!confirm('حذف هذه الشكوى؟')) return; await api('/complaints/' + cp.id, { method: 'DELETE' }); load(); } }, ['حذف'])])] : []),
          ]))),
        ]),
      ]));
    }
    await load();
    const off = App.on('rt:COMPLAINT_LOGGED', load);
    container.cleanup = () => off();
    return container;
  });
})();
