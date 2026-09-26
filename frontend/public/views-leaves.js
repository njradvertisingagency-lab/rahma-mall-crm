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

  const LEAVE_TYPE_LABELS = { ANNUAL: 'سنوية', SICK: 'مرضية', EMERGENCY: 'طارئة', UNPAID: 'بدون راتب' };
  const LEAVE_STATUS_LABELS = { PENDING: 'معلّقة', APPROVED: 'معتمدة', REJECTED: 'مرفوضة', CANCELLED: 'ملغاة' };
  const LEAVE_STATUS_BADGE_STYLE = {
    PENDING: 'background:var(--warning-soft);color:var(--warning)',
    APPROVED: 'background:var(--success-soft);color:var(--success)',
    REJECTED: 'background:var(--danger-soft);color:var(--danger)',
    CANCELLED: 'background:var(--surface-2);color:var(--muted)',
  };
  function statusBadge(s) { return el('span', { class: 'badge', style: LEAVE_STATUS_BADGE_STYLE[s] || '' }, [LEAVE_STATUS_LABELS[s] || s]); }

  function newLeaveRequestModal(opts, onDone) {
    // opts: { pickEmployee: true } لقائد الفريق (لازم يختار الموظف)، أو {} للموظف نفسه.
    const type = el('select', {}, Object.entries(LEAVE_TYPE_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
    const startDate = el('input', { type: 'date' });
    const endDate = el('input', { type: 'date' });
    const reason = el('textarea', { rows: 2 });
    const employeeSel = opts.pickEmployee ? el('select', {}, [el('option', { value: '' }, ['جارِ التحميل…'])]) : null;
    if (opts.pickEmployee) {
      api('/employees').then(({ employees }) => {
        employeeSel.innerHTML = '';
        employees.forEach((e) => employeeSel.appendChild(el('option', { value: e.id }, [e.nameAr || e.name])));
      }).catch(() => {});
    }
    const body = el('div', {}, [
      opts.pickEmployee ? el('div', { class: 'field' }, [el('label', {}, ['الموظف']), employeeSel]) : null,
      el('div', { class: 'field' }, [el('label', {}, ['نوع الإجازة']), type]),
      el('div', { class: 'field' }, [el('label', {}, ['من تاريخ']), startDate]),
      el('div', { class: 'field' }, [el('label', {}, ['إلى تاريخ']), endDate]),
      el('div', { class: 'field' }, [el('label', {}, ['السبب (اختياري)']), reason]),
    ]);
    const dlg = modal('📝 طلب إجازة جديد', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        if (!startDate.value || !endDate.value) { toast('اختر تاريخ البداية والنهاية', 'error'); return; }
        if (opts.pickEmployee && !employeeSel.value) { toast('اختر الموظف', 'error'); return; }
        try {
          const res = await api('/leaves', {
            method: 'POST',
            body: {
              employeeId: opts.pickEmployee ? Number(employeeSel.value) : undefined,
              leaveType: type.value,
              startDate: startDate.value,
              endDate: endDate.value,
              reason: reason.value.trim(),
            },
          });
          toast('تم تقديم طلب الإجازة', 'success');
          if (res.overlapWarning && res.overlapWarning.length) {
            toast('⚠️ تنبيه: يوجد موظف آخر (' + res.overlapWarning[0].employeeName + ') له إجازة متداخلة في نفس الفترة', 'warn');
          }
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['إرسال الطلب'])
    );
  }

  function rejectModal(reqId, onDone) {
    const note = el('textarea', { rows: 3, placeholder: 'سبب الرفض (مطلوب)' });
    const dlg = modal('رفض طلب الإجازة', el('div', { class: 'field' }, [el('label', {}, ['السبب']), note]), []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-danger', onclick: async () => {
        if (!note.value.trim()) { toast('سبب الرفض مطلوب', 'error'); return; }
        try {
          await api('/leaves/' + reqId + '/reject', { method: 'POST', body: { decisionNote: note.value.trim() } });
          toast('تم رفض الطلب', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['تأكيد الرفض'])
    );
  }

  async function approveRequest(reqId, onDone) {
    try {
      await api('/leaves/' + reqId + '/approve', { method: 'POST', body: {} });
      toast('تمت الموافقة على الإجازة', 'success');
      if (onDone) onDone();
    } catch (err) {
      if (err.message && err.message.includes('رصيد')) {
        if (confirm(err.message + '\n\nهل تريد الموافقة رغم ذلك؟')) {
          try {
            await api('/leaves/' + reqId + '/approve', { method: 'POST', body: { force: true } });
            toast('تمت الموافقة على الإجازة (تجاوز الرصيد)', 'success');
            if (onDone) onDone();
          } catch (err2) { toast(err2.message, 'error'); }
        }
      } else {
        toast(err.message, 'error');
      }
    }
  }

  function balanceModal(employee) {
    const body = el('div', {}, [el('div', { class: 'muted', style: 'text-align:center;padding:16px' }, ['جارِ التحميل…'])]);
    const dlg = modal('🗓️ رصيد الإجازة السنوية — ' + employee.name, body, []);
    api('/leaves/balance/' + employee.id).then(({ balance: b }) => {
      const allocationInput = el('input', { type: 'number', min: '0', value: b.allocation });
      const carriedInput = el('input', { type: 'number', min: '0', value: b.carriedOver });
      body.innerHTML = '';
      body.appendChild(el('div', {}, [
        el('div', { class: 'card-pad', style: 'text-align:center;margin-bottom:12px' }, [
          el('div', { style: 'font-size:26px;font-weight:800;color:' + (b.remaining >= 0 ? 'var(--success)' : 'var(--danger)') }, [String(b.remaining) + ' يوم متبقي']),
          el('div', { class: 'muted' }, [`من إجمالي ${b.total} يوم (${b.used} مستخدم لعام ${b.year})`]),
        ]),
        el('div', { class: 'field' }, [el('label', {}, ['الرصيد السنوي المخصص']), allocationInput]),
        el('div', { class: 'field' }, [el('label', {}, ['أيام مرحّلة من عام سابق']), carriedInput]),
      ]));
      dlg.el.querySelector('.modal-footer').append(
        el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إغلاق']),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await api('/leaves/balance/' + employee.id, {
              method: 'PATCH',
              body: { annualAllocation: Number(allocationInput.value), carriedOver: Number(carriedInput.value) },
            });
            toast('تم تحديث الرصيد', 'success');
            dlg.close();
          } catch (err) { toast(err.message, 'error'); }
        } }, ['حفظ'])
      );
    }).catch((err) => {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'error-text' }, [err.message || 'تعذّر تحميل الرصيد']));
    });
  }

  App.route('/leaves', async () => {
    const user = App.state.user;
    const isTL = user.role === 'team_leader' && (user.isHr || user.isOwner);
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['🗓️ ' + (isTL ? 'الإجازات والغياب' : 'إجازاتي')]),
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => newLeaveRequestModal({ pickEmployee: isTL }, load) }, ['➕ طلب إجازة جديد']),
    ]));

    const myBalanceBox = el('div');
    if (!isTL) container.appendChild(myBalanceBox);

    const filterBar = el('div', { class: 'filters-bar' });
    const statusSel = el('select', {}, [['', 'كل الحالات'], ['PENDING', 'معلّقة'], ['APPROVED', 'معتمدة'], ['REJECTED', 'مرفوضة'], ['CANCELLED', 'ملغاة']].map(([v, l]) => el('option', { value: v }, [l])));
    filterBar.appendChild(statusSel);
    filterBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: load }, ['تطبيق']));
    container.appendChild(filterBar);

    const box = el('div');
    container.appendChild(box);

    async function load() {
      if (!isTL) {
        api('/leaves/balance/' + user.employeeId).then(({ balance: b }) => {
          myBalanceBox.innerHTML = '';
          myBalanceBox.appendChild(el('div', { class: 'card card-pad mb-16', style: 'text-align:center' }, [
            el('div', { style: 'font-size:22px;font-weight:800;color:' + (b.remaining >= 0 ? 'var(--success)' : 'var(--danger)') }, [String(b.remaining) + ' يوم متبقي من رصيدك السنوي']),
            el('div', { class: 'muted' }, [`إجمالي ${b.total} يوم — استخدمت ${b.used} يوم في ${b.year}`]),
          ]));
        }).catch(() => {});
      }
      const q = statusSel.value ? '?status=' + statusSel.value : '';
      const { requests } = await api('/leaves' + q);
      box.innerHTML = '';
      if (requests.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد طلبات إجازة.'])); return; }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(isTL ? ['الموظف'] : []), 'النوع', 'من', 'إلى', 'الأيام', 'السبب', 'الحالة', 'ملاحظة القرار', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, requests.map((r) => el('tr', {}, [
            ...(isTL ? [el('td', {}, [
              el('a', { href: '#', onclick: (e) => { e.preventDefault(); balanceModal({ id: r.employeeId, name: r.employeeNameAr || r.employeeName }); } }, [r.employeeNameAr || r.employeeName]),
            ])] : []),
            el('td', {}, [LEAVE_TYPE_LABELS[r.leaveType] || r.leaveType]),
            el('td', {}, [fmt.date(r.startDate)]),
            el('td', {}, [fmt.date(r.endDate)]),
            el('td', {}, [String(r.daysCount)]),
            el('td', {}, [r.reason || '—']),
            el('td', {}, [statusBadge(r.status)]),
            el('td', { class: 'faint' }, [r.decisionNote || '—']),
            el('td', { class: 'flex gap-8' }, [
              isTL && r.status === 'PENDING' ? el('button', { class: 'btn btn-sm btn-success', onclick: () => approveRequest(r.id, load) }, ['✓ موافقة']) : null,
              isTL && r.status === 'PENDING' ? el('button', { class: 'btn btn-sm btn-danger', onclick: () => rejectModal(r.id, load) }, ['✕ رفض']) : null,
              (r.status === 'PENDING' && (isTL || user.employeeId === r.employeeId)) ? el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { if (confirm('تأكيد إلغاء الطلب؟')) { try { await api('/leaves/' + r.id + '/cancel', { method: 'POST' }); load(); } catch (err) { toast(err.message, 'error'); } } } }, ['إلغاء']) : null,
            ]),
          ]))),
        ]),
      ]));
    }
    await load();
    const off1 = App.on('rt:LEAVE_REQUESTED', load);
    const off2 = App.on('rt:LEAVE_DECIDED', load);
    container.cleanup = () => { off1(); off2(); };
    return container;
  });
})();
