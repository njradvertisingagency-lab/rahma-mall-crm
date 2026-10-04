'use strict';
(function () {
  const { el, api, toast, fmt } = App;

  // ===== ثوابت =====
  const STATUS_MAP = {
    active_regular: { label: 'نشط — منتظم في الدفع', color: '#059669', bg: '#ecfdf5' },
    active_late:    { label: 'نشط — متأخر في الدفع', color: '#d97706', bg: '#fffbeb' },
    rejected:       { label: 'مرفوض',                color: '#dc2626', bg: '#fef2f2' },
    needs_review:   { label: 'يحتاج مراجعة',         color: '#7c3aed', bg: '#f5f3ff' },
  };
  const LOC_MAP = {
    office:     { label: 'المكتب (أ. هاني)', icon: '🏢' },
    accounting: { label: 'الحسابات',          icon: '🧮' },
    legal:      { label: 'الشئون القانونية',  icon: '⚖️' },
  };

  function statusBadge(s) {
    const info = STATUS_MAP[s] || { label: s, color: '#666', bg: '#f3f4f6' };
    return el('span', { style: `display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;color:${info.color};background:${info.bg};white-space:nowrap` }, [info.label]);
  }
  function locBadge(loc) {
    const info = LOC_MAP[loc] || { label: loc, icon: '📍' };
    return el('span', { style: 'display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:var(--surface-2,#f3f4f6);white-space:nowrap' }, [info.icon + ' ' + info.label]);
  }

  // ===== مودال عام =====
  function modal(title, bodyNode, footerNodes) {
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
    const m = el('div', { class: 'modal', style: 'max-width:560px' }, [
      el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title' }, [title]), el('button', { class: 'modal-close', onclick: () => close() }, ['✕'])]),
      el('div', { class: 'modal-body' }, [bodyNode]),
      el('div', { class: 'modal-footer' }, footerNodes || []),
    ]);
    backdrop.appendChild(m);
    document.body.appendChild(backdrop);
    function close() { backdrop.remove(); }
    return { close, el: backdrop };
  }

  // ===== هل المستخدم له صلاحية الملفات (حسابات / شئون قانونية / HR / المالك) =====
  function isAccountingUser() {
    const u = App.state.user;
    return u.isOwner || u.department === 'accounting' || u.department === 'legal' || u.isHr;
  }
  function canEdit() { return isAccountingUser(); }

  // ===== مودال إنشاء / تعديل ملف =====
  // تنسيق تاريخ قصير (YYYY-MM-DD → DD/MM/YYYY)
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Africa/Cairo' });
  }
  // هل تاريخ الاستحقاق فات؟
  function isOverdue(dueDate) {
    if (!dueDate) return false;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }); // YYYY-MM-DD
    return dueDate < today;
  }

  function paymentBadge(active, dueDate) {
    if (active === 0 || active === false) {
      return el('span', { style: 'display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;color:#dc2626;background:#fef2f2;white-space:nowrap' }, ['⛔ متوقف عن الدفع']);
    }
    if (isOverdue(dueDate)) {
      return el('span', { style: 'display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;color:#d97706;background:#fffbeb;white-space:nowrap' }, ['⚠️ متأخر']);
    }
    return el('span', { style: 'display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;color:#059669;background:#ecfdf5;white-space:nowrap' }, ['✅ نشط في الدفع']);
  }

  function fileFormModal(existing, onDone) {
    const isEdit = !!existing;
    const fileNumberInput = el('input', { type: 'text', value: existing?.file_number || '', placeholder: 'مثال: 001', disabled: isEdit });
    const clientNameInput = el('input', { type: 'text', value: existing?.client_name || '', placeholder: 'اسم العميل' });
    const clientPhoneInput = el('input', { type: 'tel', value: existing?.client_phone || '', placeholder: '01xxxxxxxxx' });
    const guarantorNameInput = el('input', { type: 'text', value: existing?.guarantor_name || '', placeholder: 'اسم الضامن' });
    const guarantorPhoneInput = el('input', { type: 'tel', value: existing?.guarantor_phone || '', placeholder: '01xxxxxxxxx' });
    const installmentInput = el('input', { type: 'number', value: existing?.installment_value || '', placeholder: '0', min: '0', step: '0.01' });
    const productTypeInput = el('input', { type: 'text', value: existing?.product_type || '', placeholder: 'نوع المنتج' });
    const salesRepInput = el('input', { type: 'text', value: existing?.sales_rep || '', placeholder: 'اسم مندوب البيع' });
    const investigationRepInput = el('input', { type: 'text', value: existing?.investigation_rep || '', placeholder: 'اسم مندوب التحري' });

    // حقول الدفع الجديدة
    const paymentActiveSelect = el('select', {}, [
      el('option', { value: '1', selected: existing?.payment_active !== 0 }, ['✅ نشط في الدفع']),
      el('option', { value: '0', selected: existing?.payment_active === 0 }, ['⛔ متوقف عن الدفع']),
    ]);
    const installmentDueDateInput = el('input', { type: 'date', value: existing?.installment_due_date || '' });

    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['رقم الملف *']), fileNumberInput]),
      el('div', { class: 'field' }, [el('label', {}, ['اسم العميل *']), clientNameInput]),
      el('div', { class: 'field' }, [el('label', {}, ['رقم هاتف العميل']), clientPhoneInput]),
      el('div', { class: 'field' }, [el('label', {}, ['اسم الضامن']), guarantorNameInput]),
      el('div', { class: 'field' }, [el('label', {}, ['رقم هاتف الضامن']), guarantorPhoneInput]),
      el('div', { class: 'field' }, [el('label', {}, ['قيمة القسط']), installmentInput]),
      el('div', { class: 'field' }, [el('label', {}, ['نوع المنتج']), productTypeInput]),
      el('div', { class: 'field' }, [el('label', {}, ['مندوب البيع']), salesRepInput]),
      el('div', { class: 'field' }, [el('label', {}, ['مندوب التحري']), investigationRepInput]),
      el('div', { style: 'border-top:1px solid var(--border,#e5e7eb);margin-top:12px;padding-top:12px' }),
      el('div', { class: 'field' }, [el('label', {}, ['💳 حالة الدفع']), paymentActiveSelect]),
      el('div', { class: 'field' }, [el('label', {}, ['📅 تاريخ استحقاق القسط']), installmentDueDateInput]),
    ]);

    const dlg = modal(isEdit ? '✏️ تعديل ملف' : '➕ ملف جديد', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        const payload = {
          clientName: clientNameInput.value.trim(),
          clientPhone: clientPhoneInput.value.trim() || null,
          guarantorName: guarantorNameInput.value.trim() || null,
          guarantorPhone: guarantorPhoneInput.value.trim() || null,
          installmentValue: installmentInput.value ? Number(installmentInput.value) : 0,
          productType: productTypeInput.value.trim() || null,
          salesRep: salesRepInput.value.trim() || null,
          investigationRep: investigationRepInput.value.trim() || null,
          paymentActive: paymentActiveSelect.value === '1',
          installmentDueDate: installmentDueDateInput.value || null,
        };
        if (!isEdit) payload.fileNumber = fileNumberInput.value.trim();
        if (!payload.clientName) { toast('اسم العميل مطلوب', 'error'); return; }
        if (!isEdit && !payload.fileNumber) { toast('رقم الملف مطلوب', 'error'); return; }
        try {
          if (isEdit) {
            await api('/accounting/files/' + existing.id, { method: 'PUT', body: payload });
            toast('تم تحديث الملف', 'success');
          } else {
            await api('/accounting/files', { method: 'POST', body: payload });
            toast('تم إنشاء الملف', 'success');
          }
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, [isEdit ? 'حفظ التعديلات' : 'إنشاء'])
    );
  }

  // ===== مودال حركة ملف =====
  function movementFormModal(file, onDone) {
    const locs = Object.entries(LOC_MAP).filter(([k]) => k !== file.current_location);
    const toSelect = el('select', {}, locs.map(([k, v]) => el('option', { value: k }, [v.icon + ' ' + v.label])));
    const takenByInput = el('input', { type: 'text', placeholder: 'اسم الموظف المستلم' });
    const reasonInput = el('textarea', { rows: 2, placeholder: 'سبب نقل الملف' });
    const notesInput = el('input', { type: 'text', placeholder: 'ملاحظات إضافية (اختياري)' });

    const body = el('div', {}, [
      el('div', { style: 'background:var(--surface-2,#f3f4f6);border-radius:8px;padding:12px;margin-bottom:16px' }, [
        el('div', { style: 'font-weight:700;margin-bottom:4px' }, ['📄 ملف رقم: ' + file.file_number]),
        el('div', { style: 'font-size:13px;color:var(--muted,#888)' }, ['العميل: ' + file.client_name]),
        el('div', { style: 'font-size:13px;margin-top:4px;display:flex;align-items:center;gap:6px' }, ['الموقع الحالي: ', locBadge(file.current_location)]),
      ]),
      el('div', { class: 'field' }, [el('label', {}, ['نقل إلى *']), toSelect]),
      el('div', { class: 'field' }, [el('label', {}, ['اسم الموظف المستلم *']), takenByInput]),
      el('div', { class: 'field' }, [el('label', {}, ['سبب النقل *']), reasonInput]),
      el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
    ]);

    const dlg = modal('🔄 إذن حركة ملف', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        const payload = {
          toLocation: toSelect.value,
          takenByName: takenByInput.value.trim(),
          reason: reasonInput.value.trim(),
          notes: notesInput.value.trim() || null,
        };
        if (!payload.takenByName) { toast('اسم الموظف المستلم مطلوب', 'error'); return; }
        if (!payload.reason) { toast('سبب النقل مطلوب', 'error'); return; }
        try {
          await api('/accounting/files/' + file.id + '/movements', { method: 'POST', body: payload });
          toast('تم تسجيل حركة الملف بنجاح', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['تسجيل الحركة'])
    );
  }

  // ===== مودال سجل حركة ملف واحد =====
  async function showFileMovements(fileId) {
    const { movements, file } = await api('/accounting/files/' + fileId + '/movements');
    const list = movements.length === 0
      ? el('div', { style: 'text-align:center;padding:24px;color:var(--muted,#888)' }, ['لا توجد حركات مسجّلة لهذا الملف.'])
      : el('div', {}, movements.map(m => {
          const from = LOC_MAP[m.from_location] || { label: m.from_location, icon: '📍' };
          const to = LOC_MAP[m.to_location] || { label: m.to_location, icon: '📍' };
          return el('div', { style: 'border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--surface,#fff)' }, [
            el('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px' }, [
              el('div', { style: 'display:flex;align-items:center;gap:6px;font-weight:700' }, [
                el('span', {}, [from.icon + ' ' + from.label]),
                el('span', { style: 'color:var(--brand,#0f766e);font-size:18px' }, ['←']),
                el('span', {}, [to.icon + ' ' + to.label]),
              ]),
              el('div', { style: 'font-size:12px;color:var(--muted,#888)' }, [fmt.dateTime(m.created_at)]),
            ]),
            el('div', { style: 'margin-top:8px;font-size:13px;display:flex;flex-wrap:wrap;gap:16px' }, [
              el('div', {}, [el('span', { style: 'color:var(--muted,#888)' }, ['المستلم: ']), el('strong', {}, [m.taken_by_name])]),
              el('div', {}, [el('span', { style: 'color:var(--muted,#888)' }, ['السبب: ']), m.reason]),
            ]),
            m.notes ? el('div', { style: 'margin-top:4px;font-size:12px;color:var(--muted,#888)' }, ['💬 ' + m.notes]) : null,
            el('div', { style: 'margin-top:4px;font-size:11px;color:var(--muted,#aaa)' }, ['بواسطة: ' + (m.created_by_name || '—')]),
          ]);
        }));

    modal('📋 سجل حركات ملف ' + file.file_number + ' — ' + file.client_name, list, []);
  }

  // ===== صفحة ملفات العملاء (الحسابات) =====
  App.route('/accounting-files', async () => {
    const user = App.state.user;
    if (!isAccountingUser()) { toast('غير مصرح', 'error'); App.navigate('#/dashboard'); return; }

    const container = el('div');
    // شريط العنوان
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['🗃️ ملفات العملاء — قسم الحسابات']),
      canEdit() ? el('button', { class: 'btn btn-primary btn-sm', onclick: () => fileFormModal(null, load) }, ['➕ ملف جديد']) : null,
    ]));

    // فلاتر
    const searchInput = el('input', { type: 'text', placeholder: 'ابحث برقم الملف، اسم العميل، الهاتف أو الضامن…', style: 'flex:1;min-width:180px' });
    const statusFilter = el('select', { style: 'min-width:160px' }, [
      el('option', { value: '' }, ['كل الحالات']),
      ...Object.entries(STATUS_MAP).map(([k, v]) => el('option', { value: k }, [v.label])),
    ]);
    const locFilter = el('select', { style: 'min-width:150px' }, [
      el('option', { value: '' }, ['كل المواقع']),
      ...Object.entries(LOC_MAP).map(([k, v]) => el('option', { value: k }, [v.icon + ' ' + v.label])),
    ]);
    const paymentFilter = el('select', { style: 'min-width:150px' }, [
      el('option', { value: '' }, ['كل حالات الدفع']),
      el('option', { value: 'active' }, ['✅ نشط في الدفع']),
      el('option', { value: 'inactive' }, ['⛔ متوقف عن الدفع']),
      el('option', { value: 'overdue' }, ['⚠️ متأخر']),
    ]);
    const filterBar = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center' }, [searchInput, statusFilter, locFilter, paymentFilter]);
    container.appendChild(filterBar);

    // إحصائيات
    const statsRow = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px' });
    container.appendChild(statsRow);

    const listBox = el('div');
    container.appendChild(listBox);

    let debounce;
    searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 350); });
    statusFilter.addEventListener('change', load);
    locFilter.addEventListener('change', load);
    paymentFilter.addEventListener('change', load);

    async function loadStats() {
      try {
        const data = await api('/accounting/stats');
        statsRow.innerHTML = '';
        const total = data.byStatus.reduce((s, r) => s + r.cnt, 0);
        const statCards = [
          { label: 'إجمالي الملفات', value: total, color: '#374151' },
          { label: '✅ نشط في الدفع', value: data.paymentActive || 0, color: '#059669' },
          { label: '⛔ متوقف عن الدفع', value: data.paymentInactive || 0, color: '#dc2626' },
          { label: '⚠️ متأخر (فات الاستحقاق)', value: data.overdueCount || 0, color: '#d97706' },
          { label: 'حركات اليوم', value: data.todayMovements, color: '#0891b2' },
        ];
        statCards.forEach(sc => {
          statsRow.appendChild(el('div', { style: `background:var(--surface,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;text-align:center` }, [
            el('div', { style: `font-size:22px;font-weight:800;color:${sc.color}` }, [String(sc.value)]),
            el('div', { style: 'font-size:12px;color:var(--muted,#888);margin-top:2px' }, [sc.label]),
          ]));
        });
      } catch (_) { /* silent */ }
    }

    async function load() {
      const params = new URLSearchParams();
      if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
      if (statusFilter.value) params.set('status', statusFilter.value);
      if (locFilter.value) params.set('location', locFilter.value);
      if (paymentFilter.value) params.set('payment', paymentFilter.value);
      const qs = params.toString() ? '?' + params.toString() : '';

      listBox.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted,#888)">جاري التحميل…</div>';
      try {
        const data = await api('/accounting/files' + qs);
        listBox.innerHTML = '';
        if (data.files.length === 0) {
          listBox.appendChild(el('div', { class: 'empty-state' }, ['لا توجد ملفات مطابقة.']));
          return;
        }
        // جدول الملفات
        const table = el('div', { style: 'overflow-x:auto' }, [
          el('table', { class: 'data-table', style: 'width:100%' }, [
            el('thead', {}, [el('tr', {}, [
              el('th', {}, ['رقم الملف']),
              el('th', {}, ['اسم العميل']),
              el('th', {}, ['هاتف العميل']),
              el('th', {}, ['حالة الدفع']),
              el('th', {}, ['تاريخ الملف']),
              el('th', {}, ['استحقاق القسط']),
              el('th', {}, ['قيمة القسط']),
              el('th', {}, ['الضامن']),
              el('th', {}, ['نوع المنتج']),
              el('th', {}, ['مندوب البيع']),
              el('th', {}, ['الإجراءات']),
            ])]),
            el('tbody', {}, data.files.map(f => {
              const overdue = f.payment_active && isOverdue(f.installment_due_date);
              const rowStyle = f.payment_active === 0 ? 'background:rgba(220,38,38,0.04)' : overdue ? 'background:rgba(217,119,6,0.04)' : '';
              return el('tr', { style: rowStyle }, [
                el('td', { style: 'font-weight:700;white-space:nowrap' }, [f.file_number]),
                el('td', {}, [f.client_name]),
                el('td', { style: 'direction:ltr;text-align:right' }, [f.client_phone || '—']),
                el('td', {}, [paymentBadge(f.payment_active, f.installment_due_date)]),
                el('td', { style: 'white-space:nowrap;font-size:12px' }, [fmtDate(f.created_at)]),
                el('td', { style: 'white-space:nowrap;font-size:12px' + (overdue ? ';color:#dc2626;font-weight:700' : '') }, [
                  f.installment_due_date ? fmtDate(f.installment_due_date) : '—',
                ]),
                el('td', {}, [f.installment_value ? String(f.installment_value) : '—']),
                el('td', {}, [f.guarantor_name || '—']),
                el('td', {}, [f.product_type || '—']),
                el('td', {}, [f.sales_rep || '—']),
                el('td', { style: 'white-space:nowrap' }, [
                  el('button', { class: 'btn btn-outline btn-xs', style: 'margin-left:4px', title: 'سجل الحركات', onclick: () => showFileMovements(f.id) }, ['📋']),
                  canEdit() ? el('button', { class: 'btn btn-outline btn-xs', style: 'margin-left:4px', title: 'تعديل', onclick: () => fileFormModal(f, () => { load(); loadStats(); }) }, ['✏️']) : null,
                  canEdit() ? el('button', { class: 'btn btn-primary btn-xs', title: 'إذن حركة', onclick: () => movementFormModal(f, () => { load(); loadStats(); }) }, ['🔄']) : null,
                ]),
              ]);
            })),
          ]),
        ]);
        listBox.appendChild(table);
        if (data.total > data.limit) {
          listBox.appendChild(el('div', { style: 'text-align:center;padding:8px;color:var(--muted,#888);font-size:13px' }, ['عرض ' + data.files.length + ' من ' + data.total]));
        }
      } catch (err) { listBox.innerHTML = ''; toast(err.message, 'error'); }
    }

    load();
    loadStats();
    return container;
  });

  // ===== صفحة حركة الملفات (مشتركة — قراءة لقائد الفريق/HR، كاملة للحسابات) =====
  App.route('/file-movements', async () => {
    const user = App.state.user;
    const canView = user.isOwner || user.department === 'accounting' || user.department === 'legal' || user.role === 'team_leader' || user.isHr;
    if (!canView) { toast('غير مصرح', 'error'); App.navigate('#/dashboard'); return; }

    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['📂 سجل حركة الملفات']),
    ]));

    const searchInput = el('input', { type: 'text', placeholder: 'ابحث برقم الملف أو اسم العميل أو المستلم…', style: 'width:100%;max-width:400px;margin-bottom:16px' });
    container.appendChild(searchInput);

    const listBox = el('div');
    container.appendChild(listBox);

    let debounce;
    searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 350); });

    async function load() {
      const params = new URLSearchParams();
      if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
      const qs = params.toString() ? '?' + params.toString() : '';

      listBox.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted,#888)">جاري التحميل…</div>';
      try {
        const data = await api('/accounting/movements' + qs);
        listBox.innerHTML = '';
        if (data.movements.length === 0) {
          listBox.appendChild(el('div', { class: 'empty-state' }, ['لا توجد حركات مسجّلة.']));
          return;
        }
        data.movements.forEach(m => {
          const from = LOC_MAP[m.from_location] || { label: m.from_location, icon: '📍' };
          const toBase = LOC_MAP[m.to_location] || { label: m.to_location, icon: '📍' };
          // عند النقل للشئون القانونية: إظهار اسم الموظف المستلم بجانب القسم
          const toLabel = m.to_location === 'legal' && m.taken_by_name
            ? toBase.label + ' (' + m.taken_by_name + ')'
            : toBase.label;
          listBox.appendChild(el('div', { class: 'card card-pad mb-12', style: 'border-right:4px solid var(--brand,#0f766e)' }, [
            el('div', { style: 'display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:8px' }, [
              el('div', {}, [
                el('div', { style: 'font-weight:800;font-size:15px;margin-bottom:4px' }, ['📄 ملف ' + m.file_number + ' — ' + m.client_name]),
                el('div', { style: 'display:flex;align-items:center;gap:6px;font-size:14px;font-weight:600' }, [
                  el('span', {}, [from.icon + ' ' + from.label]),
                  el('span', { style: 'color:var(--brand,#0f766e);font-size:20px' }, ['←']),
                  el('span', {}, [toBase.icon + ' ' + toLabel]),
                ]),
              ]),
              el('div', { style: 'text-align:left;font-size:12px;color:var(--muted,#888);white-space:nowrap' }, [fmt.dateTime(m.created_at)]),
            ]),
            el('div', { style: 'margin-top:8px;font-size:13px;display:flex;flex-wrap:wrap;gap:16px' }, [
              el('div', {}, [el('span', { style: 'color:var(--muted,#888)' }, ['المستلم: ']), el('strong', {}, [m.taken_by_name])]),
              el('div', {}, [el('span', { style: 'color:var(--muted,#888)' }, ['السبب: ']), m.reason]),
              el('div', {}, [el('span', { style: 'color:var(--muted,#888)' }, ['بواسطة: ']), m.created_by_name || '—']),
            ]),
            m.notes ? el('div', { style: 'margin-top:4px;font-size:12px;color:var(--muted,#888)' }, ['💬 ' + m.notes]) : null,
          ]));
        });
        if (data.total > data.limit) {
          listBox.appendChild(el('div', { style: 'text-align:center;padding:8px;color:var(--muted,#888);font-size:13px' }, ['عرض ' + data.movements.length + ' من ' + data.total]));
        }
      } catch (err) { listBox.innerHTML = ''; toast(err.message, 'error'); }
    }

    load();
    return container;
  });
})();
