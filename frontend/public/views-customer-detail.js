'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;
  const STATUSES = ['NEW', 'CALLING', 'NO_ANSWER', 'BUSY', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'CLOSED'];
  const STATUS_LABELS = App.labels.status;
  const SLA_LEVEL_LABELS = { OK: 'ضمن الموعد', WARNING: 'اقترب الموعد', BREACHED: 'تم تجاوز الموعد' };
  const PAYMENT_METHOD_LABELS = { CASH: 'نقدًا', CARD: 'بطاقة', INSTALLMENT: 'تقسيط', OTHER: 'أخرى' };
  const CLOSED_REASONS = [
    ['Purchased', 'تم الشراء'],
    ['Not Interested', 'غير مهتم'],
    ['Wrong Number', 'رقم خاطئ'],
    ['Already Purchased', 'اشترى مسبقًا'],
    ['Price', 'السعر'],
    ['Unavailable Product', 'المنتج غير متوفر'],
    ['Other', 'أخرى'],
  ];
  const CALL_OUTCOMES = [
    ['ANSWERED', 'تم الرد'],
    ['NO_ANSWER', 'لا يوجد رد'],
    ['BUSY', 'مشغول'],
    ['WRONG_NUMBER', 'رقم خاطئ'],
    ['SWITCHED_OFF', 'مغلق'],
    ['REJECTED', 'تم الرفض'],
  ];
  const CALL_OUTCOME_LABELS = Object.fromEntries(CALL_OUTCOMES);
  const FOLLOWUP_STATUS_LABELS = { UPCOMING: 'قادمة', DUE: 'مستحقة', OVERDUE: 'متأخرة', COMPLETED: 'مكتملة', CANCELLED: 'ملغاة' };

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

  App.route('/customers/:id', async ({ id }) => {
    const user = App.state.user;
    const container = el('div');
    let data;
    let isFavorite = false;
    async function load() {
      data = await api('/customers/' + id);
      try { isFavorite = (await api('/favorites/' + id + '/check')).isFavorite; } catch {}
    }
    await load();

    async function toggleFavorite() {
      try {
        if (isFavorite) { await api('/favorites/' + id, { method: 'DELETE' }); isFavorite = false; }
        else { await api('/favorites/' + id, { method: 'POST' }); isFavorite = true; }
        render();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function toggleVip() {
      try {
        await api('/customers/' + id + '/vip', { method: 'POST', body: { isVip: !data.customer.isVip } });
        toast(data.customer.isVip ? 'تم إلغاء تمييز VIP' : '👑 تم تمييز العميل كـ VIP', 'success');
        await load();
        render();
      } catch (e) { toast(e.message, 'error'); }
    }
    function logComplaint() {
      const textInput = el('textarea', { placeholder: 'تفاصيل الشكوى…' });
      const body = el('div', {}, [el('div', { class: 'field' }, [el('label', {}, ['نص الشكوى']), textInput])]);
      const dlg = modal('🚩 تسجيل شكوى', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
        el('button', { class: 'btn btn-danger', onclick: async () => {
          if (!textInput.value.trim()) { toast('نص الشكوى مطلوب', 'error'); return; }
          try {
            await api('/complaints/customers/' + id, { method: 'POST', body: { text: textInput.value.trim() } });
            toast('تم تسجيل الشكوى', 'success');
            dlg.close();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['تسجيل الشكوى'])
      );
    }

    function render() {
      container.innerHTML = '';
      const c = data.customer;
      container.appendChild(el('div', { class: 'page-header' }, [
        el('div', {}, [
          el('div', { class: 'page-title' }, [c.isVip ? '👑 ' : '', c.id, ' ', badges.status(c.status), ' ', badges.dealStatus(c.dealStatus)]),
          el('div', { class: 'muted mono' }, [c.phone]),
        ]),
        el('div', { class: 'page-actions' }, [
          el('button', { class: 'btn btn-outline', title: isFavorite ? 'إزالة من المفضلة' : 'إضافة للمفضلة', onclick: toggleFavorite }, [isFavorite ? '⭐ في المفضلة' : '☆ إضافة للمفضلة']),
          user.role === 'team_leader' ? el('button', { class: 'btn btn-outline', onclick: toggleVip }, [c.isVip ? '👑 إلغاء VIP' : '👑 تمييز VIP']) : null,
          el('button', { class: 'btn btn-outline', onclick: () => App.navigate('#/customers') }, ['← رجوع']),
        ]),
      ]));

      container.appendChild(renderCustomer360Strip(c));

      const grid = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:18px' }, []);
      if (window.innerWidth < 880) grid.style.gridTemplateColumns = '1fr';

      const left = el('div', { style: 'min-width:0' });
      left.appendChild(renderInfoCard(c));
      left.appendChild(el('div', { class: 'section-title' }, ['اهتمام بالمنتجات']));
      left.appendChild(renderProducts());
      left.appendChild(el('div', { class: 'section-title' }, ['محاولات الاتصال']));
      left.appendChild(renderCallAttempts());
      left.appendChild(el('div', { class: 'section-title' }, ['زيارات الفرع والمشتريات']));
      left.appendChild(renderSalesSection());
      left.appendChild(el('div', { class: 'section-title' }, ['الملاحظات']));
      left.appendChild(renderNotes());
      left.appendChild(el('div', { class: 'section-title' }, ['المتابعات']));
      left.appendChild(renderFollowups());
      left.appendChild(el('div', { class: 'section-title' }, ['سجل النشاط']));
      left.appendChild(renderTimeline());

      const right = el('div', { style: 'min-width:0' });
      right.appendChild(renderActionsCard(c));

      grid.appendChild(left);
      grid.appendChild(right);
      container.appendChild(grid);
    }

    // --- شريط 360: تقييم العميل (قابل للتفسير)، حالة الموعد، من رآه ---
    function renderCustomer360Strip(c) {
      const card = el('div', { class: 'card card-pad mb-16', style: 'display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start' });

      const scoreBox = el('div', {}, [
        el('div', { class: 'faint' }, ['تقييم العميل']),
        el('div', { style: 'font-size:24px;font-weight:800' }, [String(c.leadScore)]),
      ]);
      const reasonsBtn = el('button', { class: 'link-btn', style: 'font-size:11px' }, ['السبب؟ ▾']);
      const reasonsBox = el('div', { class: 'faint', style: 'display:none;font-size:11px;max-width:260px' },
        c.leadScoreReasons.length === 0 ? ['لا توجد إشارات تقييم بعد.'] :
        c.leadScoreReasons.map((r) => el('div', {}, [`${r.points > 0 ? '+' : ''}${r.points} — ${r.label}`])));
      reasonsBtn.onclick = () => { reasonsBox.style.display = reasonsBox.style.display === 'none' ? 'block' : 'none'; };
      scoreBox.appendChild(reasonsBtn);
      scoreBox.appendChild(reasonsBox);
      card.appendChild(scoreBox);

      const slaBox = el('div', {}, [el('div', { class: 'faint' }, ['حالة الموعد']), badges.sla(c.sla?.worst)]);
      if (c.sla) {
        const details = [];
        if (c.sla.seen) details.push(`المشاهدة: ${SLA_LEVEL_LABELS[c.sla.seen.level] || c.sla.seen.level} (${c.sla.seen.elapsedMinutes}/${c.sla.seen.thresholdMinutes} د)`);
        if (c.sla.contact) details.push(`التواصل: ${SLA_LEVEL_LABELS[c.sla.contact.level] || c.sla.contact.level} (${c.sla.contact.elapsedMinutes}/${c.sla.contact.thresholdMinutes} د)`);
        if (c.sla.interestedFollowup) details.push(`المتابعة: ${SLA_LEVEL_LABELS[c.sla.interestedFollowup.level] || c.sla.interestedFollowup.level} (${c.sla.interestedFollowup.elapsedMinutes}/${c.sla.interestedFollowup.thresholdMinutes} د)`);
        if (details.length) slaBox.appendChild(el('div', { class: 'faint', style: 'font-size:11px;margin-top:4px' }, details.map((d) => el('div', {}, [d]))));
      }
      card.appendChild(slaBox);

      if (data.seenHistory && data.seenHistory.length > 0) {
        const seenBox = el('div', {}, [
          el('div', { class: 'faint' }, ['تمت رؤيته بواسطة']),
          ...data.seenHistory.map((s) => el('div', { style: 'font-size:12.5px' }, [`${s.employeeName} — ${fmt.dateTime(s.seenAt)}`])),
        ]);
        card.appendChild(seenBox);
      } else {
        card.appendChild(el('div', {}, [el('div', { class: 'faint' }, ['تمت رؤيته بواسطة']), el('div', { class: 'faint' }, ['لم تتم رؤيته بعد'])]));
      }

      if (data.lifetimeValue) {
        const lv = data.lifetimeValue;
        card.appendChild(el('div', {}, [
          el('div', { class: 'faint' }, ['القيمة الدائمة']),
          el('div', { style: 'font-size:12.5px' }, [`${lv.orders} طلب · صافي ${lv.netRevenue.toLocaleString()} · متوسط الطلب ${lv.averageOrderValue.toLocaleString()}`]),
        ]));
      }
      return card;
    }

    // --- اهتمام بالمنتجات ---
    function renderProducts() {
      const wrap = el('div', { class: 'card card-pad' });
      const list = el('div', { class: 'flex gap-8 mb-12', style: 'flex-wrap:wrap' },
        data.products.length === 0 ? [el('div', { class: 'muted' }, ['لا يوجد اهتمام بمنتجات مسجّل.'])] :
        data.products.map((p) => el('span', { class: 'badge', style: 'background:var(--surface-2)' }, [
          p, ' ', el('button', { class: 'link-btn', style: 'font-size:10px;margin-inline-start:4px', onclick: async () => { await api('/customers/' + data.customer.id + '/products/' + encodeURIComponent(p), { method: 'DELETE' }); await load(); render(); } }, ['✕']),
        ])));
      const input = el('input', { placeholder: 'أضف منتجًا…', style: 'max-width:220px' });
      wrap.appendChild(list);
      wrap.appendChild(el('div', { class: 'flex gap-8 wrap' }, [input, el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
        if (!input.value.trim()) return;
        await api('/customers/' + data.customer.id + '/products', { method: 'POST', body: { product: input.value.trim() } });
        input.value = '';
        await load();
        render();
      } }, ['إضافة'])]));
      return wrap;
    }

    // --- محاولات الاتصال (يدوية دائمًا — لا يُفترض شيء) ---
    function renderCallAttempts() {
      const wrap = el('div', { class: 'card card-pad' });
      wrap.appendChild(el('div', { class: 'flex-between mb-8' }, [
        el('div', { class: 'muted', style: 'font-size:12px' }, ['يتم تسجيلها يدويًا — لا يوجد ربط بمقسم هاتف، فلا يُفترض أي نتيجة تلقائيًا.']),
        el('button', { class: 'btn btn-sm btn-primary', onclick: () => logCallAttempt() }, ['📞 تسجيل محاولة اتصال']),
      ]));
      if (data.callAttempts.length === 0) {
        wrap.appendChild(el('div', { class: 'muted' }, ['لا توجد محاولات اتصال مسجّلة بعد.']));
        return wrap;
      }
      wrap.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['الوقت', 'النتيجة', 'بواسطة', 'ملاحظات'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, data.callAttempts.map((a) => el('tr', {}, [
            el('td', {}, [fmt.dateTime(a.created_at)]),
            el('td', {}, [CALL_OUTCOME_LABELS[a.outcome] || a.outcome]),
            el('td', {}, [a.attempted_by_name || '—']),
            el('td', {}, [a.notes || '—']),
          ]))),
        ]),
      ]));
      return wrap;
    }

    function logCallAttempt() {
      const outcomeSel = el('select', {}, CALL_OUTCOMES.map(([v, l]) => el('option', { value: v }, [l])));
      const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });
      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['النتيجة']), outcomeSel]),
        el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
      ]);
      const dlg = modal('تسجيل محاولة اتصال', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await api('/customers/' + data.customer.id + '/call-attempts', { method: 'POST', body: { outcome: outcomeSel.value, notes: notesInput.value } });
            toast('تم تسجيل محاولة الاتصال', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['حفظ'])
      );
    }

    // --- زيارات الفرع والمشتريات (تمت الصفقة) — حالة الصفقة نظام مستقل عن حالة العميل. ---
    function renderSalesSection() {
      const wrap = el('div', { class: 'card card-pad' });
      const canRecordPurchase = App.state.user.role === 'team_leader';
      wrap.appendChild(el('div', { class: 'flex gap-8 mb-12 wrap' }, [
        el('button', { class: 'btn btn-sm btn-outline', onclick: () => logBranchVisit() }, ['🏪 زيارة فرع']),
        canRecordPurchase ? el('button', { class: 'btn btn-sm btn-success', onclick: () => openDealDoneModal() }, ['✓ تمت الصفقة']) : null,
      ]));

      if (data.branchVisits.length > 0) {
        wrap.appendChild(el('div', { style: 'font-weight:700;font-size:12.5px;margin-bottom:6px' }, ['زيارات الفرع']));
        data.branchVisits.forEach((v) => wrap.appendChild(el('div', { class: 'faint mb-4', style: 'font-size:12px' }, [`${fmt.dateTime(v.visit_at)} — ${v.branch_name}${v.employee_name ? ' — ' + v.employee_name : ''}`])));
      }

      if (data.purchases.length === 0) {
        wrap.appendChild(el('div', { class: 'muted mt-8' }, ['لا توجد مشتريات مسجّلة بعد.']));
        return wrap;
      }
      wrap.appendChild(el('div', { style: 'font-weight:700;font-size:12.5px;margin:10px 0 6px' }, ['المشتريات']));
      data.purchases.forEach((p) => wrap.appendChild(renderPurchaseCard(p)));
      return wrap;
    }

    function renderPurchaseCard(p) {
      const netAmount = round2(p.total_amount - p.refunded_amount);
      const card = el('div', { class: 'card-pad mb-8', style: 'border:1px solid var(--border);border-radius:8px' });
      card.appendChild(el('div', { class: 'flex-between' }, [
        el('div', { style: 'font-weight:700' }, [`#${p.id} — ${p.total_amount.toLocaleString()} ج.م`]),
        badges.dealStatus(p.status),
      ]));
      card.appendChild(el('div', { class: 'faint', style: 'font-size:12px' }, [
        `${fmt.dateTime(p.purchase_at)} — ${p.branch_name} — ${PAYMENT_METHOD_LABELS[p.payment_method] || p.payment_method}`,
        p.employee_name ? ` — منسوبة إلى ${p.employee_name}` : ' — غير منسوبة',
        p.invoice_number ? ` — فاتورة ${p.invoice_number}` : '',
      ]));
      if (p.refunded_amount > 0) {
        card.appendChild(el('div', { class: 'faint', style: 'font-size:12px;color:var(--danger)' }, [`المسترجع: ${p.refunded_amount.toLocaleString()} — الصافي: ${netAmount.toLocaleString()}`]));
      }
      const itemsList = el('ul', { style: 'margin:6px 0 0;padding-inline-start:18px;font-size:12px' }, (p.items || []).map((it) => el('li', {}, [`${it.product_name} × ${it.quantity} @ ${it.unit_price} = ${it.subtotal}`])));
      card.appendChild(itemsList);
      if (App.state.user.role === 'team_leader' && p.status !== 'CANCELLED') {
        const actions = el('div', { class: 'flex gap-8 mt-8 wrap' });
        if (p.status === 'COMPLETED' || p.status === 'PARTIALLY_REFUNDED') {
          actions.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: () => openRefundModal(p) }, ['↩ استرجاع']));
        }
        actions.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: () => openAttributionModal(p) }, ['إعادة نسب الصفقة']));
        actions.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: () => cancelPurchase(p) }, ['إبطال']));
        card.appendChild(actions);
      }
      return card;
    }

    function round2(n) { return Math.round(n * 100) / 100; }

    async function logBranchVisit() {
      let branches = [];
      try { branches = (await api('/sales/branches')).branches; } catch (e) { toast(e.message, 'error'); return; }
      const branchSel = el('select', {}, branches.map((b) => el('option', { value: b.id }, [b.name])));
      const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });
      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['الفرع']), branchSel]),
        el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
      ]);
      const dlg = modal('تسجيل زيارة فرع', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await api('/sales/customers/' + data.customer.id + '/branch-visits', { method: 'POST', body: { branchId: Number(branchSel.value), notes: notesInput.value } });
            toast('تم تسجيل زيارة الفرع', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['حفظ'])
      );
    }

    async function openDealDoneModal() {
      let branches = [], settings = { paymentMethods: ['CASH'] }, employees = [];
      try {
        [branches, settings, employees] = await Promise.all([
          api('/sales/branches').then((r) => r.branches),
          api('/sales/settings').then((r) => r.settings),
          api('/employees').then((r) => r.employees).catch(() => []),
        ]);
      } catch (e) { toast(e.message, 'error'); return; }

      const branchSel = el('select', {}, branches.map((b) => el('option', { value: b.id }, [b.name])));
      const dateInput = el('input', { type: 'datetime-local', value: new Date().toISOString().slice(0, 16) });
      const invoiceInput = el('input', { placeholder: 'رقم الفاتورة (اختياري)' });
      const orderInput = el('input', { placeholder: 'رقم الطلب (اختياري)' });
      const paymentSel = el('select', {}, settings.paymentMethods.map((m) => el('option', { value: m }, [PAYMENT_METHOD_LABELS[m] || m])));
      const attribSel = el('select', {}, [
        el('option', { value: '', selected: !data.customer.assignedEmployeeId || undefined }, ['— غير منسوبة —']),
        ...employees.map((e) => el('option', { value: e.id, selected: e.id === data.customer.assignedEmployeeId || undefined }, [e.name])),
      ]);
      const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });

      const itemsBox = el('div');
      const items = [];
      function addItemRow() {
        const row = { productName: el('input', { placeholder: 'المنتج' }), sku: el('input', { placeholder: 'SKU (اختياري)', style: 'max-width:100px' }), qty: el('input', { type: 'number', value: '1', min: '1', style: 'max-width:70px' }), price: el('input', { type: 'number', value: '0', step: '0.01', style: 'max-width:100px' }), discount: el('input', { type: 'number', value: '0', step: '0.01', style: 'max-width:90px' }) };
        items.push(row);
        itemsBox.appendChild(el('div', { class: 'flex gap-8 mb-8 wrap', style: 'align-items:center' }, [
          row.productName, row.sku, row.qty, row.price, row.discount,
          el('button', { class: 'btn btn-sm', onclick: () => { const idx = items.indexOf(row); if (idx > -1) items.splice(idx, 1); rowEl.remove(); recalc(); } }, ['✕']),
        ]));
        const rowEl = itemsBox.lastChild;
        [row.qty, row.price, row.discount].forEach((inp) => inp.addEventListener('input', recalc));
      }
      const totalsBox = el('div', { class: 'flex-between mt-8', style: 'font-weight:700' }, [el('span', {}, ['الإجمالي']), el('span', { id: 'deal-total' }, ['0.00'])]);
      function recalc() {
        const settings2 = settings;
        const lineItems = items.map((r) => ({ quantity: Number(r.qty.value || 0), unitPrice: Number(r.price.value || 0), discount: Number(r.discount.value || 0) }));
        const subtotal = lineItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
        const discountTotal = lineItems.reduce((s, it) => s + it.discount, 0);
        const afterDiscount = Math.max(0, subtotal - discountTotal);
        const tax = round2(afterDiscount * ((settings2.taxRatePercent || 0) / 100));
        const total = round2(afterDiscount + tax);
        totalsBox.querySelector('#deal-total').textContent = total.toLocaleString() + ' ج.م';
      }
      addItemRow();

      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['الفرع (مطلوب)']), branchSel]),
        el('div', { class: 'field' }, [el('label', {}, ['تاريخ ووقت الشراء']), dateInput]),
        el('div', { class: 'field' }, [el('label', {}, ['رقم الفاتورة']), invoiceInput]),
        el('div', { class: 'field' }, [el('label', {}, ['رقم الطلب']), orderInput]),
        el('div', { class: 'field' }, [el('label', {}, ['طريقة الدفع']), paymentSel]),
        el('div', { class: 'field' }, [el('label', {}, ['الموظف المنسوب إليه']), attribSel]),
        el('div', { class: 'field' }, [el('label', {}, ['الأصناف']), itemsBox, el('button', { class: 'btn btn-sm btn-outline', onclick: addItemRow }, ['+ إضافة صنف'])]),
        totalsBox,
        el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
      ]);
      const dlg = modal('تأكيد إتمام الصفقة', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
        el('button', { class: 'btn btn-success', onclick: async () => {
          const payloadItems = items.map((r) => ({ productName: r.productName.value.trim(), sku: r.sku.value.trim() || null, quantity: Number(r.qty.value || 1), unitPrice: Number(r.price.value || 0), discount: Number(r.discount.value || 0) })).filter((it) => it.productName);
          if (payloadItems.length === 0) { toast('مطلوب صنف واحد على الأقل', 'error'); return; }
          if (!confirm(`تأكيد هذه الصفقة للعميل ${data.customer.id}؟ سيتم تسجيلها كإيراد.`)) return;
          try {
            await api('/sales/customers/' + data.customer.id + '/purchases', {
              method: 'POST',
              body: {
                branchId: Number(branchSel.value),
                purchaseAt: new Date(dateInput.value).toISOString(),
                invoiceNumber: invoiceInput.value.trim() || null,
                orderId: orderInput.value.trim() || null,
                items: payloadItems,
                paymentMethod: paymentSel.value,
                attributedEmployeeId: attribSel.value ? Number(attribSel.value) : null,
                notes: notesInput.value,
              },
            });
            toast('🎉 تم تسجيل الصفقة', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['تأكيد إتمام الصفقة'])
      );
    }

    function openRefundModal(p) {
      const remaining = round2(p.total_amount - p.refunded_amount);
      const amountInput = el('input', { type: 'number', step: '0.01', value: String(remaining) });
      const reasonInput = el('input', { placeholder: 'السبب' });
      const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });
      const body = el('div', {}, [
        el('div', { class: 'faint mb-8' }, [`الرصيد القابل للاسترجاع: ${remaining.toLocaleString()} ج.م`]),
        el('div', { class: 'field' }, [el('label', {}, ['مبلغ الاسترجاع']), amountInput]),
        el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
        el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
      ]);
      const dlg = modal('استرجاع الصفقة رقم ' + p.id, body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
        el('button', { class: 'btn btn-danger', onclick: async () => {
          try {
            await api('/sales/purchases/' + p.id + '/refunds', { method: 'POST', body: { refundAmount: Number(amountInput.value), refundReason: reasonInput.value, refundNotes: notesInput.value } });
            toast('تم تسجيل الاسترجاع', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['تأكيد الاسترجاع'])
      );
    }

    async function openAttributionModal(p) {
      let employees = [];
      try { employees = (await api('/employees')).employees; } catch {}
      const sel = el('select', {}, [el('option', { value: '' }, ['— غير منسوبة —']), ...employees.map((e) => el('option', { value: e.id, selected: e.id === p.attributed_employee_id || undefined }, [e.name]))]);
      const reasonInput = el('input', { placeholder: 'سبب التغيير (مطلوب)' });
      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['الموظف الجديد المنسوب إليه']), sel]),
        el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
      ]);
      const dlg = modal('إعادة نسب الصفقة', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          if (!reasonInput.value.trim()) { toast('السبب مطلوب — تغييرات النسب تُسجَّل دائمًا في السجل', 'error'); return; }
          try {
            await api('/sales/purchases/' + p.id + '/attribution', { method: 'POST', body: { newEmployeeId: sel.value || null, reason: reasonInput.value.trim() } });
            toast('تم تحديث النسب', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['حفظ'])
      );
    }

    async function cancelPurchase(p) {
      const reason = prompt('سبب إبطال هذه الصفقة:');
      if (reason === null) return;
      try {
        await api('/sales/purchases/' + p.id + '/cancel', { method: 'POST', body: { reason } });
        toast('تم إبطال الصفقة', 'success');
        await load();
        render();
      } catch (e) { toast(e.message, 'error'); }
    }

    function renderInfoCard(c) {
      const rows = [
        ['كود العميل', c.id], ['الاسم', c.name || '—'], ['الأولوية', null],
        ['المصدر', c.source || '—'], ['الحملة', c.campaign || '—'], ['المنتج', c.product || '—'],
        ['تاريخ الإنشاء', fmt.dateTime(c.createdAt)], ['تاريخ التعيين', fmt.dateTime(c.assignedAt)], ['آخر تحديث', fmt.dateTime(c.updatedAt)],
        ['المتابعة القادمة', c.nextFollowUpAt ? fmt.dateTime(c.nextFollowUpAt) : '—'],
      ];
      if (c.closedAt) rows.push(['تاريخ الإغلاق', fmt.dateTime(c.closedAt) + ' — ' + (CLOSED_REASONS.find(([v]) => v === c.closedReason)?.[1] || c.closedReason)]);
      const card = el('div', { class: 'card card-pad' });
      rows.forEach(([label, value]) => {
        const row = el('div', { class: 'flex-between mb-8', style: 'font-size:13.5px' }, [el('span', { class: 'muted' }, [label]), value === null ? badges.priority(c.priority) : el('span', {}, [value])]);
        card.appendChild(row);
      });
      return card;
    }

    function renderActionsCard(c) {
      const card = el('div', { class: 'card card-pad' });
      card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:12px' }, ['الإجراءات']));

      card.appendChild(el('a', { class: 'btn btn-outline btn-block mb-8', href: 'tel:' + c.normalizedPhone, onclick: () => api('/customers/' + c.id + '/call', { method: 'POST' }).catch(() => {}) }, ['📞 اتصال بالعميل']));
      card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => { navigator.clipboard?.writeText(c.phone); toast('تم نسخ رقم الهاتف', 'success'); } }, ['📋 نسخ الرقم']));

      // --- زر واتساب ---
      const waBtn = el('button', {
        class: 'btn btn-block mb-8 ' + (c.whatsappContactStatus === 'NOT_CONTACTED' ? 'btn-whatsapp' : 'btn-whatsapp done'),
        onclick: () => openWhatsAppModal(c),
      }, [c.whatsappContactStatus === 'NOT_CONTACTED' ? '💬 إرسال واتساب' : '✓ تم التواصل واتساب']);
      card.appendChild(waBtn);
      if (c.whatsappContactStatus !== 'NOT_CONTACTED') {
        card.appendChild(el('div', { class: 'faint mb-4' }, [
          'وقت التواصل: ',
          el('span', { class: 'mono' }, [fmt.dateTime(c.whatsappContactedAt)]),
        ]));
        if (c.whatsappContactedByName) {
          card.appendChild(el('div', { class: 'faint mb-12' }, [`تم بواسطة: ${c.whatsappContactedByName}`]));
        }
      }

      card.appendChild(el('hr', { style: 'border-color:var(--border);margin:14px 0' }));
      card.appendChild(el('div', { class: 'field' }, [
        el('label', {}, ['تغيير الحالة']),
        el('select', { id: 'status-select' }, STATUSES.map((s) => el('option', { value: s, selected: s === c.status || undefined }, [STATUS_LABELS[s] || s]))),
      ]));
      card.appendChild(el('button', { class: 'btn btn-primary btn-block mb-8', onclick: () => changeStatus(c) }, ['تحديث الحالة']));

      if (c.status === 'CLOSED') {
        card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => reopenCustomer(c) }, ['إعادة فتح العميل']));
      }

      card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => scheduleFollowup(c) }, ['📅 جدولة متابعة']));
      card.appendChild(el('button', { class: 'btn btn-outline btn-block', style: 'color:var(--danger)', onclick: () => logComplaint() }, ['🚩 تسجيل شكوى']));
      return card;
    }

    async function changeStatus(c) {
      const status = document.getElementById('status-select').value;
      if (status === c.status) return;
      let body = { status };
      if (status === 'CLOSED') {
        const reason = await pickClosedReason();
        if (!reason) return;
        Object.assign(body, reason);
      }
      try {
        await api('/customers/' + c.id + '/status', { method: 'PATCH', body });
        toast('تم تحديث الحالة', 'success');
        await load();
        render();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    function pickClosedReason() {
      return new Promise((resolve) => {
        const sel = el('select', {}, CLOSED_REASONS.map(([v, l]) => el('option', { value: v }, [l])));
        const other = el('input', { placeholder: 'سبب مخصص…', style: 'display:none;margin-top:10px' });
        sel.addEventListener('change', () => { other.style.display = sel.value === 'Other' ? 'block' : 'none'; });
        const body = el('div', {}, [el('div', { class: 'field' }, [el('label', {}, ['سبب الإغلاق (مطلوب)']), sel, other])]);
        const dlg = modal('إغلاق العميل', body, []);
        dlg.el.querySelector('.modal-footer').append(
          el('button', { class: 'btn btn-outline', onclick: () => { dlg.close(); resolve(null); } }, ['إلغاء']),
          el('button', { class: 'btn btn-danger', onclick: () => {
            if (sel.value === 'Other' && !other.value.trim()) { toast('النص المخصص مطلوب عند اختيار "أخرى"', 'error'); return; }
            dlg.close();
            resolve({ closedReason: sel.value, closedReasonText: other.value.trim() });
          } }, ['تأكيد الإغلاق'])
        );
      });
    }

    async function reopenCustomer(c) {
      if (!confirm('إعادة فتح هذا العميل؟')) return;
      await api('/customers/' + c.id + '/reopen', { method: 'POST' });
      toast('تم إعادة فتح العميل', 'success');
      await load();
      render();
    }

    function scheduleFollowup(c) {
      const dateInput = el('input', { type: 'datetime-local' });
      const reasonInput = el('input', { placeholder: 'السبب (اختياري)' });
      const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });
      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['التاريخ والوقت']), dateInput]),
        el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
        el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
      ]);
      const dlg = modal('جدولة متابعة', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          if (!dateInput.value) { toast('اختر التاريخ والوقت', 'error'); return; }
          await api('/followups/customers/' + c.id, { method: 'POST', body: { scheduledFor: new Date(dateInput.value).toISOString(), reason: reasonInput.value, notes: notesInput.value } });
          toast('تم جدولة المتابعة', 'success');
          dlg.close();
          await load();
          render();
        } }, ['جدولة'])
      );
    }

    // --- نافذة مراجعة رسالة واتساب ---
    async function openWhatsAppModal(c) {
      let preview;
      try {
        preview = await api('/whatsapp/customers/' + c.id + '/preview');
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
      if (!preview.phoneValid) {
        const body = el('div', {}, ['لا يمكن التواصل عبر واتساب — رقم الهاتف غير صالح.']);
        const dlg = modal('واتساب', body, []);
        dlg.el.querySelector('.modal-footer').append(
          el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
          el('button', { class: 'btn btn-outline', onclick: () => { navigator.clipboard?.writeText(c.phone); toast('تم نسخ الرقم', 'success'); } }, ['نسخ الرقم'])
        );
        return;
      }

      async function showComposer() {
        if (c.whatsappContactStatus !== 'NOT_CONTACTED') {
          const proceed = confirm(`تم التواصل مع هذا العميل عبر واتساب بالفعل بتاريخ ${fmt.dateTime(c.whatsappContactedAt)}. هل تريد فتح واتساب مرة أخرى؟`);
          if (!proceed) return;
        }
        const originalMessage = preview.message;
        const textarea = el('textarea', { style: 'min-height:160px' }, [originalMessage]);
        textarea.value = originalMessage;
        const body = el('div', {}, [
          el('div', { class: 'mb-8', style: 'font-size:13px' }, [el('b', {}, ['العميل: ']), c.name || '—', ' — ', el('span', { class: 'mono' }, [c.phone])]),
          el('div', { class: 'mb-12', style: 'font-size:13px' }, [el('b', {}, ['الموظف: ']), App.state.user.displayName]),
          el('div', { class: 'field' }, [el('label', {}, ['الرسالة المقترحة']), textarea]),
          el('button', { class: 'link-btn', onclick: () => { textarea.value = originalMessage; } }, ['↺ إعادة الرسالة الافتراضية']),
        ]);
        const dlg = modal('التواصل عبر واتساب', body, []);
        dlg.el.querySelector('.modal-footer').append(
          el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
          el('button', { class: 'btn btn-whatsapp', onclick: async () => {
            try {
              const res = await api('/whatsapp/customers/' + c.id + '/initiate', { method: 'POST', body: { message: textarea.value } });
              window.open(res.url, '_blank');
              toast('تم بدء التواصل عبر واتساب', 'success');
              dlg.close();
              await load();
              render();
            } catch (e) {
              toast(e.message, 'error');
            }
          } }, ['فتح واتساب'])
        );
      }
      await showComposer();
    }

    function renderNotes() {
      const wrap = el('div', { class: 'card card-pad' });
      const list = el('div', {}, data.notes.length === 0 ? [el('div', { class: 'muted' }, ['لا توجد ملاحظات بعد.'])] : data.notes.map((n) =>
        el('div', { class: 'mb-12' }, [
          el('div', { style: 'font-size:13.5px' }, [n.note]),
          el('div', { class: 'faint' }, [`${n.author_name} · ${fmt.dateTime(n.created_at)}`]),
        ])
      ));
      const input = el('textarea', { placeholder: 'أضف ملاحظة…' });
      wrap.appendChild(list);
      wrap.appendChild(el('div', { class: 'field mt-12' }, [input]));
      wrap.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
        if (!input.value.trim()) return;
        await api('/customers/' + data.customer.id + '/notes', { method: 'POST', body: { note: input.value.trim() } });
        input.value = '';
        await load();
        render();
      } }, ['إضافة ملاحظة']));
      return wrap;
    }

    function renderFollowups() {
      if (data.followups.length === 0) return el('div', { class: 'empty-state' }, ['لا توجد متابعات مجدولة.']);
      return el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['الموعد', 'السبب', 'الحالة', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, data.followups.map((f) => el('tr', {}, [
            el('td', {}, [fmt.dateTime(f.scheduled_for)]),
            el('td', {}, [f.reason || '—']),
            el('td', {}, [FOLLOWUP_STATUS_LABELS[f.status] || f.status]),
            el('td', {}, [f.status === 'UPCOMING' || f.status === 'OVERDUE' ? el('button', { class: 'btn btn-sm btn-success', onclick: async () => { await api('/followups/' + f.id + '/complete', { method: 'POST' }); await load(); render(); } }, ['إنجاز']) : '']),
          ]))),
        ]),
      ]);
    }

    function renderTimeline() {
      if (data.timeline.length === 0) return el('div', { class: 'empty-state' }, ['لا يوجد نشاط بعد.']);
      return el('div', { class: 'timeline' }, data.timeline.map((t) =>
        el('div', { class: 'timeline-item' }, [
          el('div', { class: 'timeline-time' }, [fmt.dateTime(t.created_at)]),
          el('div', { class: 'timeline-text' }, [`${t.actor_name || 'النظام'} — ${describeAction(t)}`]),
        ])
      ));
    }
    function describeAction(t) {
      const meta = t.metadata ? JSON.parse(t.metadata) : {};
      switch (t.action) {
        case 'CUSTOMER_CREATED': return 'تم إنشاء العميل';
        case 'STATUS_CHANGED': return `تغيير الحالة ${STATUS_LABELS[meta.from] || meta.from} ← ${STATUS_LABELS[meta.to] || meta.to}`;
        case 'NOTE_ADDED': return 'تمت إضافة ملاحظة';
        case 'CALL_INITIATED': return 'تم بدء اتصال';
        case 'WHATSAPP_CONTACT_INITIATED': return 'تم بدء التواصل عبر واتساب';
        case 'FOLLOWUP_CREATED': return 'تم جدولة متابعة';
        case 'FOLLOWUP_COMPLETED': return 'تم إنجاز المتابعة';
        case 'CUSTOMER_REOPENED': return 'تم إعادة فتح العميل';
        case 'PRIORITY_CHANGED': return `تغيير الأولوية ${meta.from} ← ${meta.to}`;
        case 'CALL_ATTEMPT_CREATED': return 'تم تسجيل محاولة اتصال';
        case 'BRANCH_VISIT_CREATED': return `زيارة فرع — ${meta.branchName || ''}`;
        case 'DEAL_DONE_CREATED': return `🎉 تمت الصفقة — ${meta.amount ? meta.amount + ' ج.م' : ''} في ${meta.branchName || ''}`;
        case 'PURCHASE_UPDATED': return 'تم تعديل تفاصيل الشراء';
        case 'PURCHASE_CANCELLED': return `تم إبطال الشراء${meta.reason ? ' — ' + meta.reason : ''}`;
        case 'REFUND_CREATED': return `تم تسجيل استرجاع — ${meta.amount || ''}${meta.reason ? ' — ' + meta.reason : ''}`;
        case 'ATTRIBUTION_CHANGED': return 'تم إعادة نسب الصفقة';
        case 'COMPLAINT_LOGGED': return '🚩 تم تسجيل شكوى';
        case 'CUSTOMER_MARKED_VIP': return '👑 تم تمييز العميل كـ VIP';
        case 'CUSTOMER_UNMARKED_VIP': return 'تم إلغاء تمييز VIP';
        default: return t.action.replace(/_/g, ' ').toLowerCase();
      }
    }

    render();
    const off = App.on('rt:*', async (evt) => { await load(); render(); });
    container.cleanup = () => off();
    return container;
  });
})();
