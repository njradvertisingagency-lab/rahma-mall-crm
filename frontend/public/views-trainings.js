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

  const TYPE_LABELS = { COURSE: 'دورة تدريبية', WORKSHOP: 'ورشة عمل', CERTIFICATION: 'شهادة احترافية', ONLINE: 'تدريب أونلاين', OTHER: 'أخرى' };
  const STATUS_LABELS = { PLANNED: 'مخطط له', IN_PROGRESS: 'جاري', COMPLETED: 'مكتمل', CANCELLED: 'ملغى' };
  const STATUS_STYLE = {
    PLANNED: 'background:var(--surface-2);color:var(--muted)',
    IN_PROGRESS: 'background:var(--warning-soft);color:var(--warning)',
    COMPLETED: 'background:var(--success-soft);color:var(--success)',
    CANCELLED: 'background:var(--danger-soft);color:var(--danger)',
  };
  function statusBadge(s) { return el('span', { class: 'badge', style: STATUS_STYLE[s] || '' }, [STATUS_LABELS[s] || s]); }

  function newTrainingModal(onDone) {
    const employeeSel = el('select', {}, [el('option', { value: '' }, ['جاري التحميل…'])]);
    api('/employees').then(({ employees }) => {
      employeeSel.innerHTML = '';
      employees.forEach((e) => employeeSel.appendChild(el('option', { value: e.id }, [e.nameAr || e.name])));
    }).catch(() => {});

    const title = el('input', { type: 'text', placeholder: 'مثال: دورة مهارات البيع' });
    const type = el('select', {}, Object.entries(TYPE_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
    const provider = el('input', { type: 'text', placeholder: 'الجهة المنظمة (اختياري)' });
    const startDate = el('input', { type: 'date' });
    const endDate = el('input', { type: 'date' });
    const notes = el('textarea', { rows: 2, placeholder: 'ملاحظات (اختياري)' });

    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['الموظف']), employeeSel]),
      el('div', { class: 'field' }, [el('label', {}, ['عنوان التدريب']), title]),
      el('div', { class: 'field' }, [el('label', {}, ['النوع']), type]),
      el('div', { class: 'field' }, [el('label', {}, ['الجهة المنظمة']), provider]),
      el('div', { class: 'field' }, [el('label', {}, ['تاريخ البداية']), startDate]),
      el('div', { class: 'field' }, [el('label', {}, ['تاريخ النهاية']), endDate]),
      el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notes]),
    ]);
    const dlg = modal('🎓 تدريب جديد', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        if (!employeeSel.value) { toast('اختر الموظف', 'error'); return; }
        if (!title.value.trim()) { toast('اكتب عنوان التدريب', 'error'); return; }
        try {
          await api('/trainings', {
            method: 'POST',
            body: {
              employeeId: Number(employeeSel.value),
              title: title.value.trim(),
              trainingType: type.value,
              provider: provider.value.trim(),
              startDate: startDate.value || null,
              endDate: endDate.value || null,
              notes: notes.value.trim(),
            },
          });
          toast('تم إضافة التدريب', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['إضافة'])
    );
  }

  function editTrainingModal(t, isTL, onDone) {
    const statusSel = el('select', {}, Object.entries(STATUS_LABELS).map(([v, l]) => el('option', { value: v, selected: v === t.status }, [l])));
    const certNote = el('textarea', { rows: 2, value: t.certificateNote || '' });
    certNote.value = t.certificateNote || '';
    const body = el('div', {}, [
      el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['النوع']), el('div', {}, [TYPE_LABELS[t.trainingType] || t.trainingType])]),
      t.provider ? el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['الجهة المنظمة']), el('div', {}, [t.provider])]) : null,
      (t.startDate || t.endDate) ? el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['المدة']), el('div', {}, [(t.startDate ? fmt.date(t.startDate) : '؟') + ' → ' + (t.endDate ? fmt.date(t.endDate) : '؟')])]) : null,
      t.notes ? el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['ملاحظات']), el('div', {}, [t.notes])]) : null,
      isTL ? el('div', { class: 'field' }, [el('label', {}, ['الحالة']), statusSel]) : el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['الحالة']), statusBadge(t.status)]),
      isTL ? el('div', { class: 'field' }, [el('label', {}, ['ملاحظة الشهادة (اختياري)']), certNote]) : (t.certificateNote ? el('div', {}, [el('div', { class: 'muted' }, ['ملاحظة الشهادة']), el('div', {}, [t.certificateNote])]) : null),
    ]);
    const dlg = modal('🎓 ' + t.title, body, []);
    const footer = dlg.el.querySelector('.modal-footer');
    footer.append(el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إغلاق']));
    if (isTL) {
      footer.append(el('button', { class: 'btn btn-primary', onclick: async () => {
        try {
          await api('/trainings/' + t.id, { method: 'PATCH', body: { status: statusSel.value, certificateNote: certNote.value.trim() } });
          toast('تم التحديث', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['حفظ']));
    }
  }

  App.route('/trainings', async () => {
    const user = App.state.user;
    const isTL = user.role === 'team_leader' && (user.isHr || user.isOwner);
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['🎓 ' + (isTL ? 'التدريب والتطوير' : 'تدريباتي')]),
      isTL ? el('button', { class: 'btn btn-primary btn-sm', onclick: () => newTrainingModal(load) }, ['➕ تدريب جديد']) : null,
    ]));
    const box = el('div');
    container.appendChild(box);

    async function load() {
      const { trainings } = await api('/trainings');
      box.innerHTML = '';
      if (trainings.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد تدريبات مسجلة.'])); return; }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(isTL ? ['الموظف'] : []), 'العنوان', 'النوع', 'الفترة', 'الحالة', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, trainings.map((t) => el('tr', {}, [
            ...(isTL ? [el('td', {}, [t.employeeNameAr || t.employeeName])] : []),
            el('td', {}, [t.title]),
            el('td', {}, [TYPE_LABELS[t.trainingType] || t.trainingType]),
            el('td', {}, [t.startDate ? fmt.date(t.startDate) : '—']),
            el('td', {}, [statusBadge(t.status)]),
            el('td', {}, [el('button', { class: 'btn btn-sm btn-outline', onclick: () => editTrainingModal(t, isTL, load) }, ['عرض'])]),
          ]))),
        ]),
      ]));
    }
    await load();
    const off = App.on('rt:TRAINING_ADDED', load);
    container.cleanup = () => { off(); };
    return container;
  }, { denyIfPlainSalesLead: true });
})();
