'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;
  const STATUS_LABELS = App.labels.status;
  const PRIORITY_LABELS = App.labels.priority;

  function parseQuery() {
    const hash = location.hash.split('?')[1] || '';
    return Object.fromEntries(new URLSearchParams(hash));
  }

  function statusOptions() {
    return ['', 'NEW', 'CALLING', 'NO_ANSWER', 'BUSY', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'CLOSED'];
  }

  const SEGMENTS = ['', 'NEW', 'INTERESTED', 'FOLLOW_UP', 'NO_ANSWER', 'HIGH_PRIORITY', 'OVERDUE', 'WHATSAPP_CONTACTED', 'NOT_SEEN', 'HOT', 'SLA_BREACHED', 'VIP'];
  const SEGMENT_LABELS = { '': 'كل الفئات', NEW: 'جديد', INTERESTED: 'مهتم', FOLLOW_UP: 'متابعة', NO_ANSWER: 'لا يوجد رد', HIGH_PRIORITY: 'أولوية عالية', OVERDUE: 'متابعة متأخرة', WHATSAPP_CONTACTED: 'تم التواصل واتساب', NOT_SEEN: 'لم تتم رؤيته', HOT: '🔥 مهم', SLA_BREACHED: '🔴 تجاوز الموعد', VIP: '👑 عملاء VIP' };
  const BULK_STATUSES = ['NEW', 'CALLING', 'NO_ANSWER', 'BUSY', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED'];
  const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

  function modal(title, bodyNode, footerNodes) {
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
    const m = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title' }, [title]), el('button', { class: 'modal-close', onclick: () => close() }, ['✕'])]),
      el('div', { class: 'modal-body' }, [bodyNode]),
      el('div', { class: 'modal-footer' }, footerNodes || []),
    ]);
    backdrop.appendChild(m);
    document.body.appendChild(backdrop);
    function close() { backdrop.remove(); }
    return { close, el: backdrop };
  }

  function pickFromList(title, label, options, labels) {
    return new Promise((resolve) => {
      const sel = el('select', {}, options.map((v) => el('option', { value: v }, [labels[v] || v])));
      const body = el('div', { class: 'field' }, [el('label', {}, [label]), sel]);
      const dlg = modal(title, body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => { dlg.close(); resolve(null); } }, ['إلغاء']),
        el('button', { class: 'btn btn-primary', onclick: () => { const v = sel.value; dlg.close(); resolve(v); } }, ['تطبيق'])
      );
    });
  }

  async function customersListView() {
    const user = App.state.user;
    const q = parseQuery();
    const state = {
      page: Number(q.page) || 1, pageSize: 25, status: q.status || '', priority: q.priority || '', employeeId: q.employeeId || '',
      q: q.q || '', whatsappStatus: q.whatsappStatus || '', segment: q.segment || '', seen: q.seen || '', followup: q.followup || '',
      archived: q.archived === 'true',
      selected: new Set(),
    };

    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, [user.role === 'team_leader' ? 'العملاء' : 'عملائي']),
      user.role === 'team_leader'
        ? el('div', { class: 'page-actions' }, [
            el('button', { class: 'btn btn-outline', onclick: () => App.navigate('#/import') }, ['📥 استيراد']),
            el('button', { class: 'btn btn-primary', onclick: () => App.navigate('#/distribute') }, ['🔀 توزيع']),
          ])
        : null,
    ]));

    let employees = [];
    if (user.role === 'team_leader') {
      try { employees = (await api('/employees')).employees; } catch {}
    }
    let favoriteIds = new Set();
    async function loadFavorites() {
      try { favoriteIds = new Set((await api('/favorites')).favorites.map((f) => f.customerId)); } catch {}
    }
    await loadFavorites();
    async function toggleFavorite(c) {
      try {
        if (favoriteIds.has(c.id)) { await api('/favorites/' + c.id, { method: 'DELETE' }); favoriteIds.delete(c.id); }
        else { await api('/favorites/' + c.id, { method: 'POST' }); favoriteIds.add(c.id); }
        load();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function toggleVip(c) {
      try {
        await api('/customers/' + c.id + '/vip', { method: 'POST', body: { isVip: !c.isVip } });
        toast(c.isVip ? 'تم إلغاء تمييز VIP' : '👑 تم تمييز العميل كـ VIP', 'success');
        load();
      } catch (e) { toast(e.message, 'error'); }
    }

    const filtersBar = el('div', { class: 'filters-bar' });
    const searchInput = el('input', { placeholder: 'بحث…', value: state.q, style: 'min-width:180px' });
    const statusSel = el('select', {}, statusOptions().map((s) => el('option', { value: s, selected: s === state.status || undefined }, [s ? STATUS_LABELS[s] : 'كل الحالات'])));
    const prioritySel = el('select', {}, ['', 'LOW', 'NORMAL', 'HIGH', 'URGENT'].map((s) => el('option', { value: s, selected: s === state.priority || undefined }, [s ? PRIORITY_LABELS[s] : 'كل الأولويات'])));
    const waSel = el('select', {}, [['', 'كل حالات واتساب'], ['NOT_CONTACTED', 'لم يتم التواصل'], ['CONTACT_INITIATED', 'تم التواصل واتساب']].map(([v, l]) => el('option', { value: v, selected: v === state.whatsappStatus || undefined }, [l])));
    const segmentSel = el('select', {}, SEGMENTS.map((s) => el('option', { value: s, selected: s === state.segment || undefined }, [SEGMENT_LABELS[s]])));
    const seenSel = el('select', {}, [['', 'المشاهدة: الكل'], ['seen', 'تمت رؤيته'], ['not_seen', 'لم تتم رؤيته']].map(([v, l]) => el('option', { value: v, selected: v === state.seen || undefined }, [l])));
    const followupSel = el('select', {}, [['', 'المتابعة: الكل'], ['overdue', 'متأخرة'], ['upcoming', 'قادمة']].map(([v, l]) => el('option', { value: v, selected: v === state.followup || undefined }, [l])));
    filtersBar.appendChild(searchInput);
    filtersBar.appendChild(statusSel);
    filtersBar.appendChild(prioritySel);
    filtersBar.appendChild(waSel);
    filtersBar.appendChild(segmentSel);
    filtersBar.appendChild(seenSel);
    filtersBar.appendChild(followupSel);
    let empSel = null;
    let archivedCheckbox = null;
    if (user.role === 'team_leader') {
      empSel = el('select', {}, [el('option', { value: '' }, ['كل الموظفين']), el('option', { value: 'unassigned', selected: state.employeeId === 'unassigned' || undefined }, ['غير موزّع']), ...employees.map((e) => el('option', { value: e.id, selected: String(e.id) === state.employeeId || undefined }, [e.name]))]);
      filtersBar.appendChild(empSel);
      archivedCheckbox = el('input', { type: 'checkbox', checked: state.archived || undefined });
      filtersBar.appendChild(el('label', { class: 'checkbox-row' }, [archivedCheckbox, '🗄 إظهار المؤرشفين فقط']));
    }
    const applyBtn = el('button', { class: 'btn btn-sm btn-outline', onclick: applyFilters }, ['تطبيق']);
    const clearBtn = el('button', { class: 'btn btn-sm', onclick: () => App.navigate('#/customers') }, ['مسح الفلاتر']);
    filtersBar.appendChild(applyBtn);
    filtersBar.appendChild(clearBtn);
    container.appendChild(filtersBar);

    // --- الفلاتر المحفوظة (لكل مستخدم) ---
    const savedBar = el('div', { class: 'filters-bar', style: 'margin-top:-6px' });
    const savedSel = el('select', {}, [el('option', { value: '' }, ['تحميل فلتر محفوظ…'])]);
    savedBar.appendChild(savedSel);
    savedBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: applySavedFilter }, ['تحميل']));
    savedBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: saveCurrentFilter }, ['💾 حفظ الفلتر الحالي']));
    savedBar.appendChild(el('button', { class: 'btn btn-sm', onclick: deleteSavedFilter }, ['حذف المحدد']));
    container.appendChild(savedBar);
    let savedFilters = [];
    async function loadSavedFilters() {
      try {
        const { filters } = await api('/saved-filters');
        savedFilters = filters;
        savedSel.innerHTML = '';
        savedSel.appendChild(el('option', { value: '' }, ['تحميل فلتر محفوظ…']));
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
      const name = prompt('اسم هذا الفلتر:');
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
      toast('تم حفظ الفلتر', 'success');
      await loadSavedFilters();
    }
    async function deleteSavedFilter() {
      if (!savedSel.value) return;
      await api('/saved-filters/' + savedSel.value, { method: 'DELETE' });
      toast('تم حذف الفلتر', 'success');
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
      if (archivedCheckbox && archivedCheckbox.checked) params.set('archived', 'true');
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
      if (state.archived) params.set('archived', 'true');
      const data = await api('/customers?' + params.toString());
      renderTable(data.customers, data.pagination);
    }

    function renderTable(customers, pg) {
      tableWrap.innerHTML = '';
      cardsWrap.innerHTML = '';
      if (customers.length === 0) {
        tableWrap.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['📭']), state.archived ? 'لا يوجد عملاء مؤرشفون حاليًا.' : 'لا يوجد عملاء مطابقون للفلاتر.']));
        pagination.innerHTML = '';
        return;
      }
      const showBulk = user.role === 'team_leader';
      const headers = [showBulk ? el('input', { type: 'checkbox', onchange: (e) => toggleAll(e.target.checked, customers) }) : null, 'الكود', 'الهاتف', 'الاسم', ...(user.role === 'team_leader' ? ['الموظف'] : []), 'الحالة', 'الأولوية', 'واتساب', 'المتابعة القادمة', 'آخر تحديث', ''];
      const table = el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, headers.map((h) => el('th', {}, [h])))]),
        el('tbody', {}, customers.map((c) => renderRow(c, showBulk))),
      ]);
      tableWrap.appendChild(table);
      customers.forEach((c) => cardsWrap.appendChild(renderCard(c)));

      const totalPages = Math.max(1, Math.ceil(pg.total / pg.pageSize));
      pagination.innerHTML = '';
      pagination.appendChild(el('span', { class: 'muted' }, [`${pg.total} عميل · صفحة ${pg.page}/${totalPages}`]));
      pagination.appendChild(el('button', { class: 'btn btn-sm', disabled: pg.page <= 1, onclick: () => { state.page--; load(); } }, ['‹ السابق']));
      pagination.appendChild(el('button', { class: 'btn btn-sm', disabled: pg.page >= totalPages, onclick: () => { state.page++; load(); } }, ['التالي ›']));

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
      cells.push(el('a', { href: '#/customers/' + c.id, style: 'font-weight:700' }, [c.isVip ? '👑 ' : '', c.id]));
      cells.push(el('span', { class: 'mono' }, [c.phone]));
      cells.push(c.name || '—');
      if (user.role === 'team_leader') cells.push(c.assignedEmployeeName || el('span', { class: 'faint' }, ['غير موزّع']));
      cells.push(badges.status(c.status));
      cells.push(badges.priority(c.priority));
      cells.push(badges.whatsapp(c.whatsappContactStatus));
      cells.push(c.nextFollowUpAt ? fmt.date(c.nextFollowUpAt) : '—');
      cells.push(fmt.ago(c.updatedAt));
      const rowActions = [
        el('button', { class: 'btn btn-sm btn-outline', title: favoriteIds.has(c.id) ? 'إزالة من المفضلة' : 'إضافة للمفضلة', onclick: () => toggleFavorite(c) }, [favoriteIds.has(c.id) ? '⭐' : '☆']),
        el('button', { class: 'btn btn-sm btn-outline', onclick: () => App.navigate('#/customers/' + c.id) }, ['فتح']),
      ];
      if (user.role === 'team_leader') {
        rowActions.push(el('button', { class: 'btn btn-sm btn-outline', title: c.isVip ? 'إلغاء VIP' : 'تمييز كـ VIP', onclick: () => toggleVip(c) }, [c.isVip ? '👑 VIP' : 'تمييز VIP']));
      }
      if (state.archived && user.role === 'team_leader') {
        rowActions.push(el('button', { class: 'btn btn-sm btn-success', onclick: () => restoreCustomer(c) }, ['↺ استعادة']));
      }
      cells.push(el('div', { class: 'flex gap-8 wrap' }, rowActions));
      // العميل اتفتح ولسه متكتبلوش ملاحظة — يفضل أحمر لحد ما الملاحظة تتكتب.
      return el('tr', c.needsNote ? { class: 'row-needs-note', title: 'تم فتح العميل ولم تُكتب ملاحظة بعد' } : {}, cells.map((c2) => el('td', {}, [c2])));
    }

    async function restoreCustomer(c) {
      if (!confirm(`استعادة العميل ${c.id} من الأرشيف؟`)) return;
      try {
        await api('/customers/' + c.id + '/restore', { method: 'POST' });
        toast('تم استعادة العميل', 'success');
        load();
      } catch (e) { toast(e.message, 'error'); }
    }

    function renderCard(c) {
      return el('div', { class: 'customer-card' + (c.needsNote ? ' needs-note' : '') }, [
        c.needsNote ? el('div', { class: 'needs-note-tag' }, ['📝 محتاج ملاحظة']) : null,
        el('div', { class: 'flex-between' }, [el('div', { class: 'phone mono' }, [c.isVip ? '👑 ' : '', c.phone]), badges.status(c.status)]),
        el('div', { class: 'row' }, [el('span', { class: 'muted' }, [c.name || c.id]), badges.priority(c.priority)]),
        user.role === 'team_leader' ? el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['الموظف']), c.assignedEmployeeName || 'غير موزّع']) : null,
        el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['واتساب']), badges.whatsapp(c.whatsappContactStatus)]),
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn btn-sm btn-outline', onclick: () => toggleFavorite(c) }, [favoriteIds.has(c.id) ? '⭐' : '☆']),
          el('a', { class: 'btn btn-sm btn-outline', href: 'tel:' + c.normalizedPhone }, ['📞 اتصال']),
          state.archived && user.role === 'team_leader'
            ? el('button', { class: 'btn btn-sm btn-success', onclick: () => restoreCustomer(c) }, ['↺ استعادة'])
            : el('button', { class: 'btn btn-sm btn-primary', onclick: () => App.navigate('#/customers/' + c.id) }, ['فتح']),
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
      bulkBar.appendChild(el('span', { class: 'muted' }, [`تم تحديد ${state.selected.size}`]));
      bulkBar.appendChild(el('button', { class: 'btn btn-sm', onclick: () => bulkStatus() }, ['تغيير الحالة']));
      bulkBar.appendChild(el('button', { class: 'btn btn-sm', onclick: () => bulkPriority() }, ['تغيير الأولوية']));
      bulkBar.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: () => bulkArchive() }, ['أرشفة']));
      bulkBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
        try {
          await App.downloadFile('/reports/customers', 'customers.csv');
        } catch (err) {
          App.toast(err.message || 'فشل تصدير التقرير', 'error');
        }
      } }, ['تصدير CSV']));
    }

    async function bulkStatus() {
      const status = await pickFromList('تغيير الحالة للمحدد', `الحالة الجديدة (${state.selected.size} عميل)`, BULK_STATUSES, STATUS_LABELS);
      if (!status) return;
      await api('/customers/bulk', { method: 'POST', body: { customerIds: [...state.selected], action: 'STATUS', status } });
      toast('تم تحديث الحالة للمحدد', 'success');
      state.selected.clear();
      load();
    }
    async function bulkPriority() {
      const p = await pickFromList('تغيير الأولوية للمحدد', `الأولوية الجديدة (${state.selected.size} عميل)`, PRIORITIES, PRIORITY_LABELS);
      if (!p) return;
      await api('/customers/bulk', { method: 'POST', body: { customerIds: [...state.selected], action: 'PRIORITY', priority: p } });
      toast('تم تحديث الأولوية للمحدد', 'success');
      state.selected.clear();
      load();
    }
    async function bulkArchive() {
      if (!confirm(`أرشفة ${state.selected.size} عميل؟`)) return;
      await api('/customers/bulk', { method: 'POST', body: { customerIds: [...state.selected], action: 'ARCHIVE' } });
      toast('تم أرشفة العملاء', 'success');
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

  // --- قائمة "المفضلة الخاصة بي" — الموظف/قائد الفريق يعلّم عملاء مهمين للرجوع إليهم بسرعة ---
  App.route('/favorites', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['⭐ المفضلة الخاصة بي'])]));
    const box = el('div');
    container.appendChild(box);

    async function load() {
      const { favorites } = await api('/favorites');
      box.innerHTML = '';
      if (favorites.length === 0) {
        box.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['☆']), 'لا يوجد عملاء في المفضلة بعد — اضغط ☆ بجانب أي عميل لإضافته هنا.']));
        return;
      }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['الكود', 'الاسم', 'الهاتف', 'الحالة', 'الأولوية', ...(App.state.user.role === 'team_leader' ? ['الموظف'] : []), ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, favorites.map((f) => el('tr', {}, [
            el('td', {}, [el('a', { href: '#/customers/' + f.customerId, style: 'font-weight:700' }, [f.customerId])]),
            el('td', {}, [f.name || '—']),
            el('td', { class: 'mono' }, [f.phone || '']),
            el('td', {}, [badges.status(f.status)]),
            el('td', {}, [badges.priority(f.priority)]),
            ...(App.state.user.role === 'team_leader' ? [el('td', {}, [f.assignedEmployeeName || '—'])] : []),
            el('td', {}, [
              el('div', { class: 'flex gap-8 wrap' }, [
                el('button', { class: 'btn btn-sm btn-outline', onclick: () => App.navigate('#/customers/' + f.customerId) }, ['فتح']),
                el('button', { class: 'btn btn-sm btn-danger', onclick: async () => { await api('/favorites/' + f.customerId, { method: 'DELETE' }); load(); } }, ['إزالة']),
              ]),
            ]),
          ]))),
        ]),
      ]));
    }
    await load();
    const off = App.on('rt:*', load);
    container.cleanup = () => off();
    return container;
  });
})();
