'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  function parseQuery() {
    const hash = location.hash.split('?')[1] || '';
    return Object.fromEntries(new URLSearchParams(hash));
  }

  function statusOptions() {
    return ['', 'NEW', 'CALLING', 'NO_ANSWER', 'BUSY', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'CLOSED'];
  }

  const SEGMENTS = ['', 'NEW', 'INTERESTED', 'FOLLOW_UP', 'NO_ANSWER', 'HIGH_PRIORITY', 'OVERDUE', 'WHATSAPP_CONTACTED', 'NOT_SEEN', 'HOT', 'SLA_BREACHED'];
  const SEGMENT_LABELS = { '': 'All segments', NEW: 'New', INTERESTED: 'Interested', FOLLOW_UP: 'Follow-up', NO_ANSWER: 'No Answer', HIGH_PRIORITY: 'High Priority', OVERDUE: 'Overdue Follow-up', WHATSAPP_CONTACTED: 'WhatsApp Contacted', NOT_SEEN: 'Not Seen', HOT: '🔥 Hot', SLA_BREACHED: '🔴 SLA Breached' };

  async function customersListView() {
    const user = App.state.user;
    const q = parseQuery();
    const state = {
      page: Number(q.page) || 1, pageSize: 25, status: q.status || '', priority: q.priority || '', employeeId: q.employeeId || '',
      q: q.q || '', whatsappStatus: q.whatsappStatus || '', segment: q.segment || '', seen: q.seen || '', followup: q.followup || '',
      selected: new Set(),
    };

    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, [user.role === 'team_leader' ? 'Customers' : 'My Customers']),
      user.role === 'team_leader'
        ? el('div', { class: 'page-actions' }, [
            el('button', { class: 'btn btn-outline', onclick: () => App.navigate('#/import') }, ['📥 Import']),
            el('button', { class: 'btn btn-primary', onclick: () => App.navigate('#/distribute') }, ['🔀 Distribute']),
          ])
        : null,
    ]));

    let employees = [];
    if (user.role === 'team_leader') {
      try { employees = (await api('/employees')).employees; } catch {}
    }

    const filtersBar = el('div', { class: 'filters-bar' });
    const searchInput = el('input', { placeholder: 'Search…', value: state.q, style: 'min-width:180px' });
    const statusSel = el('select', {}, statusOptions().map((s) => el('option', { value: s, selected: s === state.status || undefined }, [s || 'All statuses'])));
    const prioritySel = el('select', {}, ['', 'LOW', 'NORMAL', 'HIGH', 'URGENT'].map((s) => el('option', { value: s, selected: s === state.priority || undefined }, [s || 'All priorities'])));
    const waSel = el('select', {}, [['', 'All WhatsApp'], ['NOT_CONTACTED', 'لم يتم التواصل'], ['CONTACT_INITIATED', 'تم التواصل واتساب']].map(([v, l]) => el('option', { value: v, selected: v === state.whatsappStatus || undefined }, [l])));
    const segmentSel = el('select', {}, SEGMENTS.map((s) => el('option', { value: s, selected: s === state.segment || undefined }, [SEGMENT_LABELS[s]])));
    const seenSel = el('select', {}, [['', 'Seen: Any'], ['seen', 'Seen'], ['not_seen', 'Not Seen']].map(([v, l]) => el('option', { value: v, selected: v === state.seen || undefined }, [l])));
    const followupSel = el('select', {}, [['', 'Follow-up: Any'], ['overdue', 'Overdue'], ['upcoming', 'Upcoming']].map(([v, l]) => el('option', { value: v, selected: v === state.followup || undefined }, [l])));
    filtersBar.appendChild(searchInput);
    filtersBar.appendChild(statusSel);
    filtersBar.appendChild(prioritySel);
    filtersBar.appendChild(waSel);
    filtersBar.appendChild(segmentSel);
    filtersBar.appendChild(seenSel);
    filtersBar.appendChild(followupSel);
    let empSel = null;
    if (user.role === 'team_leader') {
      empSel = el('select', {}, [el('option', { value: '' }, ['All employees']), el('option', { value: 'unassigned', selected: state.employeeId === 'unassigned' || undefined }, ['Unassigned']), ...employees.map((e) => el('option', { value: e.id, selected: String(e.id) === state.employeeId || undefined }, [e.name]))]);
      filtersBar.appendChild(empSel);
    }
    const applyBtn = el('button', { class: 'btn btn-sm btn-outline', onclick: applyFilters }, ['Apply']);
    const clearBtn = el('button', { class: 'btn btn-sm', onclick: () => App.navigate('#/customers') }, ['Clear Filters']);
    filtersBar.appendChild(applyBtn);
    filtersBar.appendChild(clearBtn);
    container.appendChild(filtersBar);

    // --- Saved Filters (per-user) ---
    const savedBar = el('div', { class: 'filters-bar', style: 'margin-top:-6px' });
    const savedSel = el('select', {}, [el('option', { value: '' }, ['Load a saved filter…'])]);
    savedBar.appendChild(savedSel);
    savedBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: applySavedFilter }, ['Load']));
    savedBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: saveCurrentFilter }, ['💾 Save Current Filter']));
    savedBar.appendChild(el('button', { class: 'btn btn-sm', onclick: deleteSavedFilter }, ['Delete Selected']));
    container.appendChild(savedBar);
    let savedFilters = [];
    async function loadSavedFilters() {
      try {
        const { filters } = await api('/saved-filters');
        savedFilters = filters;
        savedSel.innerHTML = '';
        savedSel.appendChild(el('option', { value: '' }, ['Load a saved filter…']));
        filters.forEach((f) => savedSel.appendChild(el('option', { value: f.id }, [f.name])));
      } catch {}
    }
    function applySavedFilter() {
      const f = savedFilters.find((x) => String(x.id) === savedSel.value);
      if (!f) return;
      const params = new URLSearchParams(f.query);
      App.navigate('#/customers' + (params.toString() ? '?' + params.toString() : ''));
    }
    async function saveCurrentFilter() {
      const name = prompt('Name this filter:');
      if (!name || !name.trim()) return;
      const query = {};
      if (statusSel.value) query.status = statusSel.value;
      if (prioritySel.value) query.priority = prioritySel.value;
      if (waSel.value) query.whatsappStatus = waSel.value;
      if (segmentSel.value) query.segment = segmentSel.value;
      if (seenSel.value) query.seen = seenSel.value;
      if (followupSel.value) query.followup = followupSel.value;
      if (empSel && empSel.value) query.employeeId = empSel.value;
      if (searchInput.value.trim()) query.q = searchInput.value.trim();
      await api('/saved-filters', { method: 'POST', body: { name: name.trim(), query } });
      toast('Filter saved', 'success');
      await loadSavedFilters();
    }
    async function deleteSavedFilter() {
      if (!savedSel.value) return;
      await api('/saved-filters/' + savedSel.value, { method: 'DELETE' });
      toast('Filter deleted', 'success');
      await loadSavedFilters();
    }
    loadSavedFilters();

    const bulkBar = el('div', { class: 'filters-bar', style: 'display:none' });
    container.appendChild(bulkBar);

    const tableWrap = el('div', { class: 'table-wrap responsive-cards' });
    const cardsWrap = el('div', { class: 'customer-cards' });
    container.appendChild(tableWrap);
    container.appendChild(cardsWrap);
    const pagination = el('div', { class: 'pagination' });
    container.appendChild(pagination);

    function applyFilters() {
      const params = new URLSearchParams();
      if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
      if (statusSel.value) params.set('status', statusSel.value);
      if (prioritySel.value) params.set('priority', prioritySel.value);
      if (waSel.value) params.set('whatsappStatus', waSel.value);
      if (segmentSel.value) params.set('segment', segmentSel.value);
      if (seenSel.value) params.set('seen', seenSel.value);
      if (followupSel.value) params.set('followup', followupSel.value);
      if (empSel && empSel.value) params.set('employeeId', empSel.value);
      App.navigate('#/customers' + (params.toString() ? '?' + params.toString() : ''));
    }
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });

    async function load() {
      const params = new URLSearchParams();
      params.set('page', state.page);
      params.set('pageSize', state.pageSize);
      if (state.status) params.set('status', state.status);
      if (state.priority) params.set('priority', state.priority);
      if (state.whatsappStatus) params.set('whatsappStatus', state.whatsappStatus);
      if (state.segment) params.set('segment', state.segment);
      if (state.seen) params.set('seen', state.seen);
      if (state.followup) params.set('followup', state.followup);
      if (state.employeeId) params.set('employeeId', state.employeeId);
      if (state.q) params.set('q', state.q);
      const data = await api('/customers?' + params.toString());
      renderTable(data.customers, data.pagination);
    }

    function renderTable(customers, pg) {
      tableWrap.innerHTML = '';
      cardsWrap.innerHTML = '';
      if (customers.length === 0) {
        tableWrap.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['📭']), 'No customers match your filters.']));
        pagination.innerHTML = '';
        return;
      }
      const showBulk = user.role === 'team_leader';
      const headers = [showBulk ? el('input', { type: 'checkbox', onchange: (e) => toggleAll(e.target.checked, customers) }) : null, 'ID', 'Phone', 'Name', ...(user.role === 'team_leader' ? ['Employee'] : []), 'Status', 'Priority', 'WhatsApp', 'Next Follow-up', 'Updated', ''];
      const table = el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, headers.map((h) => el('th', {}, [h])))]),
        el('tbody', {}, customers.map((c) => renderRow(c, showBulk))),
      ]);
      tableWrap.appendChild(table);
      customers.forEach((c) => cardsWrap.appendChild(renderCard(c)));

      const totalPages = Math.max(1, Math.ceil(pg.total / pg.pageSize));
      pagination.innerHTML = '';
      pagination.appendChild(el('span', { class: 'muted' }, [`${pg.total} customers · page ${pg.page}/${totalPages}`]));
      pagination.appendChild(el('button', { class: 'btn btn-sm', disabled: pg.page <= 1, onclick: () => { state.page--; load(); } }, ['‹ Prev']));
      pagination.appendChild(el('button', { class: 'btn btn-sm', disabled: pg.page >= totalPages, onclick: () => { state.page++; load(); } }, ['Next ›']));

      if (showBulk) updateBulkBar(customers);
    }

    function toggleAll(checked, customers) {
      customers.forEach((c) => (checked ? state.selected.add(c.id) : state.selected.delete(c.id)));
      updateBulkBar(customers);
      load();
    }

    function renderRow(c, showBulk) {
      const cells = [];
      if (showBulk) {
        cells.push(el('input', { type: 'checkbox', checked: state.selected.has(c.id) || undefined, onchange: (e) => { e.target.checked ? state.selected.add(c.id) : state.selected.delete(c.id); updateBulkBar(); } }));
      }
      cells.push(el('a', { href: '#/customers/' + c.id, style: 'font-weight:700' }, [c.id]));
      cells.push(el('span', { class: 'mono' }, [c.phone]));
      cells.push(c.name || '—');
      if (user.role === 'team_leader') cells.push(c.assignedEmployeeName || el('span', { class: 'faint' }, ['Unassigned']));
      cells.push(badges.status(c.status));
      cells.push(badges.priority(c.priority));
      cells.push(badges.whatsapp(c.whatsappContactStatus));
      cells.push(c.nextFollowUpAt ? fmt.date(c.nextFollowUpAt) : '—');
      cells.push(fmt.ago(c.updatedAt));
      cells.push(el('button', { class: 'btn btn-sm btn-outline', onclick: () => App.navigate('#/customers/' + c.id) }, ['Open']));
      return el('tr', {}, cells.map((c2) => el('td', {}, [c2])));
    }

    function renderCard(c) {
      return el('div', { class: 'customer-card' }, [
        el('div', { class: 'flex-between' }, [el('div', { class: 'phone mono' }, [c.phone]), badges.status(c.status)]),
        el('div', { class: 'row' }, [el('span', { class: 'muted' }, [c.name || c.id]), badges.priority(c.priority)]),
        user.role === 'team_leader' ? el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['Employee']), c.assignedEmployeeName || 'Unassigned']) : null,
        el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['WhatsApp']), badges.whatsapp(c.whatsappContactStatus)]),
        el('div', { class: 'actions' }, [
          el('a', { class: 'btn btn-sm btn-outline', href: 'tel:' + c.normalizedPhone }, ['📞 Call']),
          el('button', { class: 'btn btn-sm btn-primary', onclick: () => App.navigate('#/customers/' + c.id) }, ['Open']),
        ]),
      ]);
    }

    function updateBulkBar(customers) {
      if (state.selected.size === 0) {
        bulkBar.style.display = 'none';
        return;
      }
      bulkBar.style.display = 'flex';
      bulkBar.innerHTML = '';
      bulkBar.appendChild(el('span', { class: 'muted' }, [`${state.selected.size} selected`]));
      bulkBar.appendChild(el('button', { class: 'btn btn-sm', onclick: () => bulkStatus() }, ['Change Status']));
      bulkBar.appendChild(el('button', { class: 'btn btn-sm', onclick: () => bulkPriority() }, ['Change Priority']));
      bulkBar.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: () => bulkArchive() }, ['Archive']));
      bulkBar.appendChild(el('a', { class: 'btn btn-sm btn-outline', href: App.apiBase + '/api/reports/customers', target: '_blank' }, ['Export CSV']));
    }

    async function bulkStatus() {
      const status = prompt('New status (NEW, CALLING, NO_ANSWER, BUSY, FOLLOW_UP, INTERESTED, NOT_INTERESTED):');
      if (!status) return;
      await api('/customers/bulk', { method: 'POST', body: { customerIds: [...state.selected], action: 'STATUS', status: status.toUpperCase() } });
      toast('Bulk status updated', 'success');
      state.selected.clear();
      load();
    }
    async function bulkPriority() {
      const p = prompt('New priority (LOW, NORMAL, HIGH, URGENT):');
      if (!p) return;
      await api('/customers/bulk', { method: 'POST', body: { customerIds: [...state.selected], action: 'PRIORITY', priority: p.toUpperCase() } });
      toast('Bulk priority updated', 'success');
      state.selected.clear();
      load();
    }
    async function bulkArchive() {
      if (!confirm(`Archive ${state.selected.size} customers?`)) return;
      await api('/customers/bulk', { method: 'POST', body: { customerIds: [...state.selected], action: 'ARCHIVE' } });
      toast('Customers archived', 'success');
      state.selected.clear();
      load();
    }

    await load();
    const off = App.on('rt:*', () => load());
    container.cleanup = () => off();
    return container;
  }

  App.route('/customers', customersListView);
  App.route('/my-customers', customersListView);
})();
