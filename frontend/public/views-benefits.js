'use strict';
(function () {
  const { el, api, toast, fmt } = App;

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

  const TYPE_LABELS = { BONUS: 'مكافأة', ALLOWANCE: 'بدل', DEDUCTION: 'خصم', ADVANCE: 'سلفة', OTHER: 'أخرى' };
  const TYPE_SIGN = { BONUS: '+', ALLOWANCE: '+', DEDUCTION: '-', ADVANCE: '-', OTHER: '' };
  const STATUS_LABELS = { PENDING: 'بانتظار الاعتماد', APPROVED: 'معتمدة', PAID: 'مصروفة', REJECTED: 'مرفوضة' };
  const STATUS_STYLE = {
    PENDING: 'background:var(--warning-soft);color:var(--warning)',
    APPROVED: 'background:var(--success-soft);color:var(--success)',
    PAID: 'background:var(--success-soft);color:var(--success)',
    REJECTED: 'background:var(--danger-soft);color:var(--danger)',
  };
  function statusBadge(s) { return el('span', { class: 'badge', style: STATUS_STYLE[s] || '' }, [STATUS_LABELS[s] || s]); }

  function newBenefitModal(onDone) {
    const employeeSel = el('select', {}, [el('option', { value: '' }, ['جاري التحميل…'])]);
    api('/employees').then(({ employees }) => {
      employeeSel.innerHTML = '';
      employees.forEach((e) => employeeSel.appendChild(el('option', { value: e.id }, [e.nameAr || e.name])));
    }).catch(() => {});

    const type = el('select', {}, Object.entries(TYPE_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
    const amount = el('input', { type: 'number', min: '0', step: '0.01', placeholder: 'المبلغ بالجنيه' });
    const effectiveDate = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const description = el('textarea', { rows: 2, placeholder: 'وصف مختصر (اختياري)' });

    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['الموظف']), employeeSel]),
      el('div', { class: 'field' }, [el('label', {}, ['النوع']), type]),
      el('div', { class: 'field' }, [el('label', {}, ['المبلغ (جنيه)']), amount]),
      el('div', { class: 'field' }, [el('label', {}, ['تاريخ السريان']), effectiveDate]),
      el('div', { class: 'field' }, [el('label', {}, ['الوصف']), description]),
    ]);
    const dlg = modal('💰 حركة مالية جديدة', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        if (!employeeSel.value) { toast('اختر الموظف', 'error'); return; }
        const amt = Number(amount.value);
        if (!amt || amt <= 0) { toast('أدخل مبلغ صحيح', 'error'); return; }
        try {
          await api('/benefits', {
            method: 'POST',
            body: { employeeId: Number(employeeSel.value), benefitType: type.value, amount: amt, effectiveDate: effectiveDate.value, description: description.value.trim() },
          });
          toast('تم تسجيل الحركة', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['تسجيل'])
    );
  }

  App.route('/benefits', async () => {
    const user = App.state.user;
    const isTL = user.role === 'team_leader' && (user.isHr || user.isOwner);
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['💰 ' + (isTL ? 'المزايا والمكافآت المالية' : 'مزاياي ومكافآتي')]),
      isTL ? el('button', { class: 'btn btn-primary btn-sm', onclick: () => newBenefitModal(load) }, ['➕ حركة جديدة']) : null,
    ]));
    const box = el('div');
    container.appendChild(box);

    async function load() {
      const { benefits } = await api('/benefits');
      box.innerHTML = '';
      if (benefits.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد حركات مالية مسجلة.'])); return; }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(isTL ? ['الموظف'] : []), 'النوع', 'المبلغ', 'التاريخ', 'الوصف', 'الحالة', ...(isTL ? [''] : [])].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, benefits.map((b) => el('tr', {}, [
            ...(isTL ? [el('td', {}, [b.employeeNameAr || b.employeeName])] : []),
            el('td', {}, [TYPE_LABELS[b.benefitType] || b.benefitType]),
            el('td', { style: 'font-weight:700;color:' + ((b.benefitType === 'DEDUCTION' || b.benefitType === 'ADVANCE') ? 'var(--danger)' : 'var(--success)') }, [(TYPE_SIGN[b.benefitType] || '') + Number(b.amount).toLocaleString('ar-EG') + ' ج.م']),
            el('td', {}, [fmt.date(b.effectiveDate)]),
            el('td', {}, [b.description || '—']),
            el('td', {}, [statusBadge(b.status)]),
            ...(isTL ? [el('td', { class: 'flex gap-8' }, [
              b.status === 'PENDING' ? el('button', { class: 'btn btn-sm btn-success', onclick: async () => { try { await api('/benefits/' + b.id + '/approve', { method: 'POST', body: {} }); load(); } catch (err) { toast(err.message, 'error'); } } }, ['اعتماد']) : null,
              b.status === 'PENDING' ? el('button', { class: 'btn btn-sm btn-danger', onclick: async () => { try { await api('/benefits/' + b.id + '/reject', { method: 'POST', body: {} }); load(); } catch (err) { toast(err.message, 'error'); } } }, ['رفض']) : null,
              b.status === 'APPROVED' ? el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { try { await api('/benefits/' + b.id + '/mark-paid', { method: 'POST', body: {} }); load(); } catch (err) { toast(err.message, 'error'); } } }, ['تسجيل الصرف']) : null,
            ])] : []),
          ]))),
        ]),
      ]));
    }
    await load();
    const off = App.on('rt:BENEFIT_LOGGED', load);
    container.cleanup = () => { off(); };
    return container;
  });
})();
