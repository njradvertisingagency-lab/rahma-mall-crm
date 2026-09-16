'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;
  const STATUSES = ['NEW', 'CALLING', 'NO_ANSWER', 'BUSY', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'CLOSED'];
  const CLOSED_REASONS = ['Purchased', 'Not Interested', 'Wrong Number', 'Already Purchased', 'Price', 'Unavailable Product', 'Other'];
  const CALL_OUTCOMES = ['ANSWERED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SWITCHED_OFF', 'REJECTED'];

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
    async function load() {
      data = await api('/customers/' + id);
    }
    await load();

    function render() {
      container.innerHTML = '';
      const c = data.customer;
      container.appendChild(el('div', { class: 'page-header' }, [
        el('div', {}, [
          el('div', { class: 'page-title' }, [c.id, ' ', badges.status(c.status), ' ', badges.dealStatus(c.dealStatus)]),
          el('div', { class: 'muted mono' }, [c.phone]),
        ]),
        el('div', { class: 'page-actions' }, [
          el('button', { class: 'btn btn-outline', onclick: () => App.navigate('#/customers') }, ['← Back']),
        ]),
      ]));

      container.appendChild(renderCustomer360Strip(c));

      const grid = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:18px' }, []);
      if (window.innerWidth < 880) grid.style.gridTemplateColumns = '1fr';

      const left = el('div');
      left.appendChild(renderInfoCard(c));
      left.appendChild(el('div', { class: 'section-title' }, ['Product Interest']));
      left.appendChild(renderProducts());
      left.appendChild(el('div', { class: 'section-title' }, ['Call Attempts']));
      left.appendChild(renderCallAttempts());
      left.appendChild(el('div', { class: 'section-title' }, ['Branch Visits & Purchases']));
      left.appendChild(renderSalesSection());
      left.appendChild(el('div', { class: 'section-title' }, ['Notes']));
      left.appendChild(renderNotes());
      left.appendChild(el('div', { class: 'section-title' }, ['Follow-ups']));
      left.appendChild(renderFollowups());
      left.appendChild(el('div', { class: 'section-title' }, ['Activity Timeline']));
      left.appendChild(renderTimeline());

      const right = el('div');
      right.appendChild(renderActionsCard(c));

      grid.appendChild(left);
      grid.appendChild(right);
      container.appendChild(grid);
    }

    // --- Customer 360 strip: Lead Score (explainable), SLA state, Seen status ---
    function renderCustomer360Strip(c) {
      const card = el('div', { class: 'card card-pad mb-16', style: 'display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start' });

      const scoreBox = el('div', {}, [
        el('div', { class: 'faint' }, ['Lead Score']),
        el('div', { style: 'font-size:24px;font-weight:800' }, [String(c.leadScore)]),
      ]);
      const reasonsBtn = el('button', { class: 'link-btn', style: 'font-size:11px' }, ['Why? ▾']);
      const reasonsBox = el('div', { class: 'faint', style: 'display:none;font-size:11px;max-width:260px' },
        c.leadScoreReasons.length === 0 ? ['No scoring signals yet.'] :
        c.leadScoreReasons.map((r) => el('div', {}, [`${r.points > 0 ? '+' : ''}${r.points} — ${r.label}`])));
      reasonsBtn.onclick = () => { reasonsBox.style.display = reasonsBox.style.display === 'none' ? 'block' : 'none'; };
      scoreBox.appendChild(reasonsBtn);
      scoreBox.appendChild(reasonsBox);
      card.appendChild(scoreBox);

      const slaBox = el('div', {}, [el('div', { class: 'faint' }, ['SLA Status']), badges.sla(c.sla?.worst)]);
      if (c.sla) {
        const details = [];
        if (c.sla.seen) details.push(`Seen: ${c.sla.seen.level} (${c.sla.seen.elapsedMinutes}/${c.sla.seen.thresholdMinutes}m)`);
        if (c.sla.contact) details.push(`Contact: ${c.sla.contact.level} (${c.sla.contact.elapsedMinutes}/${c.sla.contact.thresholdMinutes}m)`);
        if (c.sla.interestedFollowup) details.push(`Follow-up: ${c.sla.interestedFollowup.level} (${c.sla.interestedFollowup.elapsedMinutes}/${c.sla.interestedFollowup.thresholdMinutes}m)`);
        if (details.length) slaBox.appendChild(el('div', { class: 'faint', style: 'font-size:11px;margin-top:4px' }, details.map((d) => el('div', {}, [d]))));
      }
      card.appendChild(slaBox);

      if (data.seenHistory && data.seenHistory.length > 0) {
        const seenBox = el('div', {}, [
          el('div', { class: 'faint' }, ['Seen By']),
          ...data.seenHistory.map((s) => el('div', { style: 'font-size:12.5px' }, [`${s.employeeName} — ${fmt.dateTime(s.seenAt)}`])),
        ]);
        card.appendChild(seenBox);
      } else {
        card.appendChild(el('div', {}, [el('div', { class: 'faint' }, ['Seen By']), el('div', { class: 'faint' }, ['Not seen yet'])]));
      }

      if (data.lifetimeValue) {
        const lv = data.lifetimeValue;
        card.appendChild(el('div', {}, [
          el('div', { class: 'faint' }, ['Lifetime Value']),
          el('div', { style: 'font-size:12.5px' }, [`${lv.orders} order(s) · Net ${lv.netRevenue.toLocaleString()} · AOV ${lv.averageOrderValue.toLocaleString()}`]),
        ]));
      }
      return card;
    }

    // --- Product Interest ---
    function renderProducts() {
      const wrap = el('div', { class: 'card card-pad' });
      const list = el('div', { class: 'flex gap-8 mb-12', style: 'flex-wrap:wrap' },
        data.products.length === 0 ? [el('div', { class: 'muted' }, ['No product interest recorded.'])] :
        data.products.map((p) => el('span', { class: 'badge', style: 'background:var(--surface-2)' }, [
          p, ' ', el('button', { class: 'link-btn', style: 'font-size:10px;margin-inline-start:4px', onclick: async () => { await api('/customers/' + data.customer.id + '/products/' + encodeURIComponent(p), { method: 'DELETE' }); await load(); render(); } }, ['✕']),
        ])));
      const input = el('input', { placeholder: 'Add a product…', style: 'max-width:220px' });
      wrap.appendChild(list);
      wrap.appendChild(el('div', { class: 'flex gap-8' }, [input, el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
        if (!input.value.trim()) return;
        await api('/customers/' + data.customer.id + '/products', { method: 'POST', body: { product: input.value.trim() } });
        input.value = '';
        await load();
        render();
      } }, ['Add'])]));
      return wrap;
    }

    // --- Call Attempts (explicit only — never inferred) ---
    function renderCallAttempts() {
      const wrap = el('div', { class: 'card card-pad' });
      wrap.appendChild(el('div', { class: 'flex-between mb-8' }, [
        el('div', { class: 'muted', style: 'font-size:12px' }, ['Logged manually — there is no telephony integration, so outcomes are never inferred.']),
        el('button', { class: 'btn btn-sm btn-primary', onclick: () => logCallAttempt() }, ['📞 Log Call Attempt']),
      ]));
      if (data.callAttempts.length === 0) {
        wrap.appendChild(el('div', { class: 'muted' }, ['No call attempts logged yet.']));
        return wrap;
      }
      wrap.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['When', 'Outcome', 'By', 'Notes'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, data.callAttempts.map((a) => el('tr', {}, [
            el('td', {}, [fmt.dateTime(a.created_at)]),
            el('td', {}, [a.outcome]),
            el('td', {}, [a.attempted_by_name || '—']),
            el('td', {}, [a.notes || '—']),
          ]))),
        ]),
      ]));
      return wrap;
    }

    function logCallAttempt() {
      const outcomeSel = el('select', {}, CALL_OUTCOMES.map((o) => el('option', { value: o }, [o])));
      const notesInput = el('textarea', { placeholder: 'Notes (optional)' });
      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['Outcome']), outcomeSel]),
        el('div', { class: 'field' }, [el('label', {}, ['Notes']), notesInput]),
      ]);
      const dlg = modal('Log Call Attempt', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['Cancel']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await api('/customers/' + data.customer.id + '/call-attempts', { method: 'POST', body: { outcome: outcomeSel.value, notes: notesInput.value } });
            toast('Call attempt logged', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['Save'])
      );
    }

    // --- Branch Visits & Purchases (Deal Done) — Deal Status is a separate system from Customer Status. ---
    function renderSalesSection() {
      const wrap = el('div', { class: 'card card-pad' });
      const canRecordPurchase = App.state.user.role === 'team_leader';
      wrap.appendChild(el('div', { class: 'flex gap-8 mb-12' }, [
        el('button', { class: 'btn btn-sm btn-outline', onclick: () => logBranchVisit() }, ['🏪 Branch Visit']),
        canRecordPurchase ? el('button', { class: 'btn btn-sm btn-success', onclick: () => openDealDoneModal() }, ['✓ Deal Done']) : null,
      ]));

      if (data.branchVisits.length > 0) {
        wrap.appendChild(el('div', { style: 'font-weight:700;font-size:12.5px;margin-bottom:6px' }, ['Branch Visits']));
        data.branchVisits.forEach((v) => wrap.appendChild(el('div', { class: 'faint mb-4', style: 'font-size:12px' }, [`${fmt.dateTime(v.visit_at)} — ${v.branch_name}${v.employee_name ? ' — ' + v.employee_name : ''}`])));
      }

      if (data.purchases.length === 0) {
        wrap.appendChild(el('div', { class: 'muted mt-8' }, ['No purchases recorded yet.']));
        return wrap;
      }
      wrap.appendChild(el('div', { style: 'font-weight:700;font-size:12.5px;margin:10px 0 6px' }, ['Purchases']));
      data.purchases.forEach((p) => wrap.appendChild(renderPurchaseCard(p)));
      return wrap;
    }

    function renderPurchaseCard(p) {
      const netAmount = round2(p.total_amount - p.refunded_amount);
      const card = el('div', { class: 'card-pad mb-8', style: 'border:1px solid var(--border);border-radius:8px' });
      card.appendChild(el('div', { class: 'flex-between' }, [
        el('div', { style: 'font-weight:700' }, [`#${p.id} — ${p.total_amount.toLocaleString()} EGP`]),
        badges.dealStatus(p.status),
      ]));
      card.appendChild(el('div', { class: 'faint', style: 'font-size:12px' }, [
        `${fmt.dateTime(p.purchase_at)} — ${p.branch_name} — ${p.payment_method}`,
        p.employee_name ? ` — attributed to ${p.employee_name}` : ' — unattributed',
        p.invoice_number ? ` — Invoice ${p.invoice_number}` : '',
      ]));
      if (p.refunded_amount > 0) {
        card.appendChild(el('div', { class: 'faint', style: 'font-size:12px;color:#991b1b' }, [`Refunded: ${p.refunded_amount.toLocaleString()} — Net: ${netAmount.toLocaleString()}`]));
      }
      const itemsList = el('ul', { style: 'margin:6px 0 0;padding-inline-start:18px;font-size:12px' }, (p.items || []).map((it) => el('li', {}, [`${it.product_name} × ${it.quantity} @ ${it.unit_price} = ${it.subtotal}`])));
      card.appendChild(itemsList);
      if (App.state.user.role === 'team_leader' && p.status !== 'CANCELLED') {
        const actions = el('div', { class: 'flex gap-8 mt-8' });
        if (p.status === 'COMPLETED' || p.status === 'PARTIALLY_REFUNDED') {
          actions.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: () => openRefundModal(p) }, ['↩ Refund']));
        }
        actions.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: () => openAttributionModal(p) }, ['Reassign Attribution']));
        actions.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: () => cancelPurchase(p) }, ['Void']));
        card.appendChild(actions);
      }
      return card;
    }

    function round2(n) { return Math.round(n * 100) / 100; }

    async function logBranchVisit() {
      let branches = [];
      try { branches = (await api('/sales/branches')).branches; } catch (e) { toast(e.message, 'error'); return; }
      const branchSel = el('select', {}, branches.map((b) => el('option', { value: b.id }, [b.name])));
      const notesInput = el('textarea', { placeholder: 'Notes (optional)' });
      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['Branch']), branchSel]),
        el('div', { class: 'field' }, [el('label', {}, ['Notes']), notesInput]),
      ]);
      const dlg = modal('Log Branch Visit', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['Cancel']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await api('/sales/customers/' + data.customer.id + '/branch-visits', { method: 'POST', body: { branchId: Number(branchSel.value), notes: notesInput.value } });
            toast('Branch visit recorded', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['Save'])
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
      const invoiceInput = el('input', { placeholder: 'Invoice number (optional)' });
      const orderInput = el('input', { placeholder: 'Order ID (optional)' });
      const paymentSel = el('select', {}, settings.paymentMethods.map((m) => el('option', { value: m }, [m])));
      const attribSel = el('select', {}, [
        el('option', { value: '', selected: !data.customer.assignedEmployeeId || undefined }, ['— Unattributed —']),
        ...employees.map((e) => el('option', { value: e.id, selected: e.id === data.customer.assignedEmployeeId || undefined }, [e.name])),
      ]);
      const notesInput = el('textarea', { placeholder: 'Notes (optional)' });

      const itemsBox = el('div');
      const items = [];
      function addItemRow() {
        const row = { productName: el('input', { placeholder: 'Product' }), sku: el('input', { placeholder: 'SKU (optional)', style: 'max-width:100px' }), qty: el('input', { type: 'number', value: '1', min: '1', style: 'max-width:70px' }), price: el('input', { type: 'number', value: '0', step: '0.01', style: 'max-width:100px' }), discount: el('input', { type: 'number', value: '0', step: '0.01', style: 'max-width:90px' }) };
        items.push(row);
        itemsBox.appendChild(el('div', { class: 'flex gap-8 mb-8', style: 'align-items:center' }, [
          row.productName, row.sku, row.qty, row.price, row.discount,
          el('button', { class: 'btn btn-sm', onclick: () => { const idx = items.indexOf(row); if (idx > -1) items.splice(idx, 1); rowEl.remove(); recalc(); } }, ['✕']),
        ]));
        const rowEl = itemsBox.lastChild;
        [row.qty, row.price, row.discount].forEach((inp) => inp.addEventListener('input', recalc));
      }
      const totalsBox = el('div', { class: 'flex-between mt-8', style: 'font-weight:700' }, [el('span', {}, ['Total']), el('span', { id: 'deal-total' }, ['0.00'])]);
      function recalc() {
        const settings2 = settings;
        const lineItems = items.map((r) => ({ quantity: Number(r.qty.value || 0), unitPrice: Number(r.price.value || 0), discount: Number(r.discount.value || 0) }));
        const subtotal = lineItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
        const discountTotal = lineItems.reduce((s, it) => s + it.discount, 0);
        const afterDiscount = Math.max(0, subtotal - discountTotal);
        const tax = round2(afterDiscount * ((settings2.taxRatePercent || 0) / 100));
        const total = round2(afterDiscount + tax);
        totalsBox.querySelector('#deal-total').textContent = total.toLocaleString() + ' EGP';
      }
      addItemRow();

      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['Branch (required)']), branchSel]),
        el('div', { class: 'field' }, [el('label', {}, ['Purchase Date & Time']), dateInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Invoice Number']), invoiceInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Order ID']), orderInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Payment Method']), paymentSel]),
        el('div', { class: 'field' }, [el('label', {}, ['Attributed Employee']), attribSel]),
        el('div', { class: 'field' }, [el('label', {}, ['Items']), itemsBox, el('button', { class: 'btn btn-sm btn-outline', onclick: addItemRow }, ['+ Add Line'])]),
        totalsBox,
        el('div', { class: 'field' }, [el('label', {}, ['Notes']), notesInput]),
      ]);
      const dlg = modal('Confirm Deal Done', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['Cancel']),
        el('button', { class: 'btn btn-success', onclick: async () => {
          const payloadItems = items.map((r) => ({ productName: r.productName.value.trim(), sku: r.sku.value.trim() || null, quantity: Number(r.qty.value || 1), unitPrice: Number(r.price.value || 0), discount: Number(r.discount.value || 0) })).filter((it) => it.productName);
          if (payloadItems.length === 0) { toast('At least one product line is required', 'error'); return; }
          if (!confirm(`Confirm this purchase for ${data.customer.id}? This will be recorded as revenue.`)) return;
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
            toast('🎉 Deal Done recorded', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['Confirm Deal Done'])
      );
    }

    function openRefundModal(p) {
      const remaining = round2(p.total_amount - p.refunded_amount);
      const amountInput = el('input', { type: 'number', step: '0.01', value: String(remaining) });
      const reasonInput = el('input', { placeholder: 'Reason' });
      const notesInput = el('textarea', { placeholder: 'Notes (optional)' });
      const body = el('div', {}, [
        el('div', { class: 'faint mb-8' }, [`Refundable balance: ${remaining.toLocaleString()} EGP`]),
        el('div', { class: 'field' }, [el('label', {}, ['Refund Amount']), amountInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Reason']), reasonInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Notes']), notesInput]),
      ]);
      const dlg = modal('Refund Purchase #' + p.id, body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['Cancel']),
        el('button', { class: 'btn btn-danger', onclick: async () => {
          try {
            await api('/sales/purchases/' + p.id + '/refunds', { method: 'POST', body: { refundAmount: Number(amountInput.value), refundReason: reasonInput.value, refundNotes: notesInput.value } });
            toast('Refund recorded', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['Confirm Refund'])
      );
    }

    async function openAttributionModal(p) {
      let employees = [];
      try { employees = (await api('/employees')).employees; } catch {}
      const sel = el('select', {}, [el('option', { value: '' }, ['— Unattributed —']), ...employees.map((e) => el('option', { value: e.id, selected: e.id === p.attributed_employee_id || undefined }, [e.name]))]);
      const reasonInput = el('input', { placeholder: 'Reason for change (required)' });
      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['New Attributed Employee']), sel]),
        el('div', { class: 'field' }, [el('label', {}, ['Reason']), reasonInput]),
      ]);
      const dlg = modal('Reassign Sales Attribution', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['Cancel']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          if (!reasonInput.value.trim()) { toast('A reason is required — attribution changes are always audited', 'error'); return; }
          try {
            await api('/sales/purchases/' + p.id + '/attribution', { method: 'POST', body: { newEmployeeId: sel.value || null, reason: reasonInput.value.trim() } });
            toast('Attribution updated', 'success');
            dlg.close();
            await load();
            render();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['Save'])
      );
    }

    async function cancelPurchase(p) {
      const reason = prompt('Reason for voiding this purchase:');
      if (reason === null) return;
      try {
        await api('/sales/purchases/' + p.id + '/cancel', { method: 'POST', body: { reason } });
        toast('Purchase voided', 'success');
        await load();
        render();
      } catch (e) { toast(e.message, 'error'); }
    }

    function renderInfoCard(c) {
      const rows = [
        ['Customer ID', c.id], ['Name', c.name || '—'], ['Priority', null],
        ['Source', c.source || '—'], ['Campaign', c.campaign || '—'], ['Product', c.product || '—'],
        ['Created', fmt.dateTime(c.createdAt)], ['Assigned', fmt.dateTime(c.assignedAt)], ['Last Updated', fmt.dateTime(c.updatedAt)],
        ['Next Follow-up', c.nextFollowUpAt ? fmt.dateTime(c.nextFollowUpAt) : '—'],
      ];
      if (c.closedAt) rows.push(['Closed', fmt.dateTime(c.closedAt) + ' — ' + c.closedReason]);
      const card = el('div', { class: 'card card-pad' });
      rows.forEach(([label, value]) => {
        const row = el('div', { class: 'flex-between mb-8', style: 'font-size:13.5px' }, [el('span', { class: 'muted' }, [label]), value === null ? badges.priority(c.priority) : el('span', {}, [value])]);
        card.appendChild(row);
      });
      return card;
    }

    function renderActionsCard(c) {
      const card = el('div', { class: 'card card-pad' });
      card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:12px' }, ['Actions']));

      card.appendChild(el('a', { class: 'btn btn-outline btn-block mb-8', href: 'tel:' + c.normalizedPhone, onclick: () => api('/customers/' + c.id + '/call', { method: 'POST' }).catch(() => {}) }, ['📞 Call Customer']));
      card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => { navigator.clipboard?.writeText(c.phone); toast('Phone number copied', 'success'); } }, ['📋 Copy Number']));

      // --- WhatsApp button ---
      const waBtn = el('button', {
        class: 'btn btn-block mb-8 ' + (c.whatsappContactStatus === 'NOT_CONTACTED' ? 'btn-whatsapp' : 'btn-whatsapp done'),
        onclick: () => openWhatsAppModal(c),
      }, [c.whatsappContactStatus === 'NOT_CONTACTED' ? '💬 إرسال واتساب' : '✓ تم التواصل واتساب']);
      card.appendChild(waBtn);
      if (c.whatsappContactStatus !== 'NOT_CONTACTED') {
        card.appendChild(el('div', { class: 'faint mb-4', dir: 'rtl', style: 'text-align:right' }, [
          'وقت التواصل: ',
          el('span', { dir: 'ltr', style: 'unicode-bidi:isolate' }, [fmt.dateTime(c.whatsappContactedAt)]),
        ]));
        if (c.whatsappContactedByName) {
          card.appendChild(el('div', { class: 'faint mb-12', dir: 'rtl', style: 'text-align:right' }, [`تم بواسطة: ${c.whatsappContactedByName}`]));
        }
      }

      card.appendChild(el('hr', { style: 'border-color:var(--border);margin:14px 0' }));
      card.appendChild(el('div', { class: 'field' }, [
        el('label', {}, ['Change Status']),
        el('select', { id: 'status-select' }, STATUSES.map((s) => el('option', { value: s, selected: s === c.status || undefined }, [s]))),
      ]));
      card.appendChild(el('button', { class: 'btn btn-primary btn-block mb-8', onclick: () => changeStatus(c) }, ['Update Status']));

      if (c.status === 'CLOSED') {
        card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => reopenCustomer(c) }, ['Reopen Customer']));
      }

      card.appendChild(el('button', { class: 'btn btn-outline btn-block', onclick: () => scheduleFollowup(c) }, ['📅 Schedule Follow-up']));
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
        toast('Status updated', 'success');
        await load();
        render();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    function pickClosedReason() {
      return new Promise((resolve) => {
        const sel = el('select', {}, CLOSED_REASONS.map((r) => el('option', { value: r }, [r])));
        const other = el('input', { placeholder: 'Custom reason…', style: 'display:none;margin-top:10px' });
        sel.addEventListener('change', () => { other.style.display = sel.value === 'Other' ? 'block' : 'none'; });
        const body = el('div', {}, [el('div', { class: 'field' }, [el('label', {}, ['Closed reason (required)']), sel, other])]);
        const dlg = modal('Close Customer', body, []);
        dlg.el.querySelector('.modal-footer').append(
          el('button', { class: 'btn btn-outline', onclick: () => { dlg.close(); resolve(null); } }, ['Cancel']),
          el('button', { class: 'btn btn-danger', onclick: () => {
            if (sel.value === 'Other' && !other.value.trim()) { toast('Custom text is required for "Other"', 'error'); return; }
            dlg.close();
            resolve({ closedReason: sel.value, closedReasonText: other.value.trim() });
          } }, ['Confirm Close'])
        );
      });
    }

    async function reopenCustomer(c) {
      if (!confirm('Reopen this customer?')) return;
      await api('/customers/' + c.id + '/reopen', { method: 'POST' });
      toast('Customer reopened', 'success');
      await load();
      render();
    }

    function scheduleFollowup(c) {
      const dateInput = el('input', { type: 'datetime-local' });
      const reasonInput = el('input', { placeholder: 'Reason (optional)' });
      const notesInput = el('textarea', { placeholder: 'Notes (optional)' });
      const body = el('div', {}, [
        el('div', { class: 'field' }, [el('label', {}, ['Date & Time']), dateInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Reason']), reasonInput]),
        el('div', { class: 'field' }, [el('label', {}, ['Notes']), notesInput]),
      ]);
      const dlg = modal('Schedule Follow-up', body, []);
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['Cancel']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          if (!dateInput.value) { toast('Pick a date/time', 'error'); return; }
          await api('/followups/customers/' + c.id, { method: 'POST', body: { scheduledFor: new Date(dateInput.value).toISOString(), reason: reasonInput.value, notes: notesInput.value } });
          toast('Follow-up scheduled', 'success');
          dlg.close();
          await load();
          render();
        } }, ['Schedule'])
      );
    }

    // --- WhatsApp review modal ---
    async function openWhatsAppModal(c) {
      let preview;
      try {
        preview = await api('/whatsapp/customers/' + c.id + '/preview');
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
      if (!preview.phoneValid) {
        const body = el('div', { dir: 'rtl', style: 'text-align:right' }, ['لا يمكن التواصل عبر واتساب — رقم الهاتف غير صالح.']);
        const dlg = modal('واتساب', body, []);
        dlg.el.querySelector('.modal-footer').append(
          el('button', { class: 'btn btn-outline', onclick: () => { navigator.clipboard?.writeText(c.phone); toast('تم نسخ الرقم', 'success'); } }, ['نسخ الرقم']),
          el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء'])
        );
        return;
      }

      async function showComposer() {
        if (c.whatsappContactStatus !== 'NOT_CONTACTED') {
          const proceed = confirm(`تم التواصل مع هذا العميل عبر واتساب بالفعل بتاريخ ${fmt.dateTime(c.whatsappContactedAt)}. هل تريد فتح واتساب مرة أخرى؟`);
          if (!proceed) return;
        }
        const originalMessage = preview.message;
        const textarea = el('textarea', { dir: 'rtl', style: 'min-height:160px;text-align:right' }, [originalMessage]);
        textarea.value = originalMessage;
        const body = el('div', { dir: 'rtl', style: 'text-align:right' }, [
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
      const list = el('div', {}, data.notes.length === 0 ? [el('div', { class: 'muted' }, ['No notes yet.'])] : data.notes.map((n) =>
        el('div', { class: 'mb-12' }, [
          el('div', { style: 'font-size:13.5px' }, [n.note]),
          el('div', { class: 'faint' }, [`${n.author_name} · ${fmt.dateTime(n.created_at)}`]),
        ])
      ));
      const input = el('textarea', { placeholder: 'Add a note…' });
      wrap.appendChild(list);
      wrap.appendChild(el('div', { class: 'field mt-12' }, [input]));
      wrap.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
        if (!input.value.trim()) return;
        await api('/customers/' + data.customer.id + '/notes', { method: 'POST', body: { note: input.value.trim() } });
        input.value = '';
        await load();
        render();
      } }, ['Add Note']));
      return wrap;
    }

    function renderFollowups() {
      if (data.followups.length === 0) return el('div', { class: 'empty-state' }, ['No follow-ups scheduled.']);
      return el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Scheduled', 'Reason', 'Status', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, data.followups.map((f) => el('tr', {}, [
            el('td', {}, [fmt.dateTime(f.scheduled_for)]),
            el('td', {}, [f.reason || '—']),
            el('td', {}, [f.status]),
            el('td', {}, [f.status === 'UPCOMING' || f.status === 'OVERDUE' ? el('button', { class: 'btn btn-sm btn-success', onclick: async () => { await api('/followups/' + f.id + '/complete', { method: 'POST' }); await load(); render(); } }, ['Complete']) : '']),
          ]))),
        ]),
      ]);
    }

    function renderTimeline() {
      if (data.timeline.length === 0) return el('div', { class: 'empty-state' }, ['No activity yet.']);
      return el('div', { class: 'timeline' }, data.timeline.map((t) =>
        el('div', { class: 'timeline-item' }, [
          el('div', { class: 'timeline-time' }, [fmt.dateTime(t.created_at)]),
          el('div', { class: 'timeline-text' }, [`${t.actor_name || 'System'} — ${describeAction(t)}`]),
        ])
      ));
    }
    function describeAction(t) {
      const meta = t.metadata ? JSON.parse(t.metadata) : {};
      switch (t.action) {
        case 'CUSTOMER_CREATED': return 'Customer created';
        case 'STATUS_CHANGED': return `Status ${meta.from} → ${meta.to}`;
        case 'NOTE_ADDED': return 'Note added';
        case 'CALL_INITIATED': return 'Call initiated';
        case 'WHATSAPP_CONTACT_INITIATED': return 'تم بدء التواصل عبر واتساب';
        case 'FOLLOWUP_CREATED': return 'Follow-up scheduled';
        case 'FOLLOWUP_COMPLETED': return 'Follow-up completed';
        case 'CUSTOMER_REOPENED': return 'Customer reopened';
        case 'PRIORITY_CHANGED': return `Priority ${meta.from} → ${meta.to}`;
        case 'CALL_ATTEMPT_CREATED': return 'Call attempt logged';
        case 'BRANCH_VISIT_CREATED': return `Branch visit — ${meta.branchName || ''}`;
        case 'DEAL_DONE_CREATED': return `🎉 Deal Done — ${meta.amount ? meta.amount + ' EGP' : ''} at ${meta.branchName || ''}`;
        case 'PURCHASE_UPDATED': return 'Purchase details updated';
        case 'PURCHASE_CANCELLED': return `Purchase voided${meta.reason ? ' — ' + meta.reason : ''}`;
        case 'REFUND_CREATED': return `Refund recorded — ${meta.amount || ''}${meta.reason ? ' — ' + meta.reason : ''}`;
        case 'ATTRIBUTION_CHANGED': return 'Sales attribution reassigned';
        default: return t.action.replace(/_/g, ' ').toLowerCase();
      }
    }

    render();
    const off = App.on('rt:*', async (evt) => { await load(); render(); });
    container.cleanup = () => off();
    return container;
  });
})();
