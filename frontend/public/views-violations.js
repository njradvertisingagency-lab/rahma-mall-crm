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

  const VIOLATION_TYPE_LABELS = { LATE: 'تأخير', ABSENCE: 'غياب', MISCONDUCT: 'مخالفة سلوك', POLICY_BREACH: 'مخالفة سياسة', PERFORMANCE: 'قصور في الأداء', OTHER: 'أخرى' };
  const SEVERITY_LABELS = { MINOR: 'بسيطة', MODERATE: 'متوسطة', SEVERE: 'جسيمة' };
  const SEVERITY_STYLE = {
    MINOR: 'background:var(--success-soft);color:var(--success)',
    MODERATE: 'background:var(--warning-soft);color:var(--warning)',
    SEVERE: 'background:var(--danger-soft);color:var(--danger)',
  };
  const ACTION_LABELS = { NONE: 'بدون إجراء', VERBAL_WARNING: 'إنذار شفهي', WRITTEN_WARNING: 'إنذار كتابي', SUSPENSION: 'إيقاف عن العمل', FINE: 'خصم/غرامة', TERMINATION_NOTICE: 'إخطار بإنهاء الخدمة' };
  const STATUS_LABELS = { OPEN: 'بانتظار الاطلاع', ACKNOWLEDGED: 'تم الاطلاع', RESOLVED: 'مغلقة' };
  const STATUS_STYLE = {
    OPEN: 'background:var(--warning-soft);color:var(--warning)',
    ACKNOWLEDGED: 'background:var(--info-soft, var(--surface-2));color:var(--info, var(--muted))',
    RESOLVED: 'background:var(--success-soft);color:var(--success)',
  };

  function statusBadge(s) { return el('span', { class: 'badge', style: STATUS_STYLE[s] || '' }, [STATUS_LABELS[s] || s]); }
  function severityBadge(s) { return el('span', { class: 'badge', style: SEVERITY_STYLE[s] || '' }, [SEVERITY_LABELS[s] || s]); }

  function newViolationModal(onDone) {
    const employeeSel = el('select', {}, [el('option', { value: '' }, ['جاري التحميل…'])]);
    api('/employees').then(({ employees }) => {
      employeeSel.innerHTML = '';
      employees.forEach((e) => employeeSel.appendChild(el('option', { value: e.id }, [e.nameAr || e.name])));
    }).catch(() => {});

    const type = el('select', {}, Object.entries(VIOLATION_TYPE_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
    const severity = el('select', {}, Object.entries(SEVERITY_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
    const occurredAt = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const description = el('textarea', { rows: 3 });
    const actionTaken = el('select', {}, Object.entries(ACTION_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
    const actionNote = el('textarea', { rows: 2, placeholder: 'تفاصيل الإجراء (اختياري)' });

    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['الموظف']), employeeSel]),
      el('div', { class: 'field' }, [el('label', {}, ['نوع المخالفة']), type]),
      el('div', { class: 'field' }, [el('label', {}, ['درجة الخطورة']), severity]),
      el('div', { class: 'field' }, [el('label', {}, ['تاريخ الواقعة']), occurredAt]),
      el('div', { class: 'field' }, [el('label', {}, ['وصف المخالفة']), description]),
      el('div', { class: 'field' }, [el('label', {}, ['الإجراء المتخذ']), actionTaken]),
      el('div', { class: 'field' }, [el('label', {}, ['ملاحظات الإجراء']), actionNote]),
    ]);
    const dlg = modal('⚠️ تسجيل مخالفة جديدة', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-danger', onclick: async () => {
        if (!employeeSel.value) { toast('اختر الموظف', 'error'); return; }
        if (!description.value.trim()) { toast('اكتب وصف المخالفة', 'error'); return; }
        try {
          await api('/violations', {
            method: 'POST',
            body: {
              employeeId: Number(employeeSel.value),
              violationType: type.value,
              severity: severity.value,
              occurredAt: occurredAt.value,
              description: description.value.trim(),
              actionTaken: actionTaken.value,
              actionNote: actionNote.value.trim(),
            },
          });
          toast('تم تسجيل المخالفة', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['تسجيل المخالفة'])
    );
  }

  function viewViolationModal(v, isTL, onDone) {
    const body = el('div', {}, [
      el('div', { class: 'flex', style: 'gap:8px;margin-bottom:12px' }, [severityBadge(v.severity), statusBadge(v.status)]),
      el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['النوع']), el('div', {}, [VIOLATION_TYPE_LABELS[v.violationType] || v.violationType])]),
      el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['تاريخ الواقعة']), el('div', {}, [fmt.date(v.occurredAt)])]),
      el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['الوصف']), el('div', {}, [v.description])]),
      el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['الإجراء المتخذ']), el('div', {}, [ACTION_LABELS[v.actionTaken] || v.actionTaken])]),
      v.actionNote ? el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['ملاحظات الإجراء']), el('div', {}, [v.actionNote])]) : null,
      !isTL && v.status === 'OPEN' ? el('div', { class: 'field' }, [el('label', {}, ['ردك / تعليقك (اختياري)']), el('textarea', { rows: 2, id: 'violation-comment' })]) : null,
      v.employeeComment ? el('div', { class: 'mb-16' }, [el('div', { class: 'muted' }, ['رد الموظف']), el('div', {}, [v.employeeComment])]) : null,
    ]);
    const dlg = modal('⚠️ تفاصيل المخالفة', body, []);
    const footer = dlg.el.querySelector('.modal-footer');
    footer.append(el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إغلاق']));
    if (!isTL && v.status === 'OPEN') {
      footer.append(el('button', { class: 'btn btn-primary', onclick: async () => {
        const commentEl = dlg.el.querySelector('#violation-comment');
        try {
          await api('/violations/' + v.id + '/acknowledge', { method: 'POST', body: { comment: commentEl ? commentEl.value.trim() : '' } });
          toast('تم تسجيل اطلاعك على المخالفة', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['تأكيد الاطلاع']));
    }
    if (isTL && v.status !== 'RESOLVED') {
      footer.append(el('button', { class: 'btn btn-success', onclick: async () => {
        try {
          await api('/violations/' + v.id + '/resolve', { method: 'POST', body: {} });
          toast('تم إغلاق المخالفة', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['إغلاق المخالفة']));
    }
  }

  App.route('/violations', async () => {
    const user = App.state.user;
    const isTL = user.role === 'team_leader' && (user.isHr || user.isOwner);
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['⚠️ ' + (isTL ? 'المخالفات والإجراءات التأديبية' : 'مخالفاتي')]),
      isTL ? el('button', { class: 'btn btn-danger btn-sm', onclick: () => newViolationModal(load) }, ['➕ تسجيل مخالفة']) : null,
    ]));

    const filterBar = el('div', { class: 'filters-bar' });
    const statusSel = el('select', {}, [['', 'كل الحالات'], ['OPEN', 'بانتظار الاطلاع'], ['ACKNOWLEDGED', 'تم الاطلاع'], ['RESOLVED', 'مغلقة']].map(([v, l]) => el('option', { value: v }, [l])));
    filterBar.appendChild(statusSel);
    filterBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: load }, ['تطبيق']));
    container.appendChild(filterBar);

    const box = el('div');
    container.appendChild(box);

    async function load() {
      const q = statusSel.value ? '?status=' + statusSel.value : '';
      const { violations } = await api('/violations' + q);
      box.innerHTML = '';
      if (violations.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد مخالفات مسجلة.'])); return; }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(isTL ? ['الموظف'] : []), 'النوع', 'الخطورة', 'التاريخ', 'الإجراء', 'الحالة', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, violations.map((v) => el('tr', {}, [
            ...(isTL ? [el('td', {}, [v.employeeNameAr || v.employeeName])] : []),
            el('td', {}, [VIOLATION_TYPE_LABELS[v.violationType] || v.violationType]),
            el('td', {}, [severityBadge(v.severity)]),
            el('td', {}, [fmt.date(v.occurredAt)]),
            el('td', {}, [ACTION_LABELS[v.actionTaken] || v.actionTaken]),
            el('td', {}, [statusBadge(v.status)]),
            el('td', {}, [el('button', { class: 'btn btn-sm btn-outline', onclick: () => viewViolationModal(v, isTL, load) }, ['عرض'])]),
          ]))),
        ]),
      ]));
    }
    await load();
    const off = App.on('rt:VIOLATION_LOGGED', load);
    const off2 = App.on('rt:VIOLATION_ACKNOWLEDGED', load);
    container.cleanup = () => { off(); off2(); };
    return container;
  });
})();
