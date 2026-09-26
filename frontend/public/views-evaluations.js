'use strict';
(function () {
  const { el, api, toast } = App;

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

  const CRITERIA = [
    ['quality', 'جودة العمل'],
    ['punctuality', 'الالتزام بالمواعيد'],
    ['teamwork', 'العمل الجماعي'],
    ['communication', 'مهارات التواصل'],
    ['sales', 'الأداء البيعي'],
  ];

  function scoreStars(v) {
    return '⭐'.repeat(v) + '☆'.repeat(5 - v);
  }

  function overallColor(score) {
    if (score >= 4) return 'var(--success)';
    if (score >= 2.5) return 'var(--warning)';
    return 'var(--danger)';
  }

  function scoreSelect(defaultVal) {
    return el('select', {}, [1, 2, 3, 4, 5].map((n) => el('option', { value: String(n), selected: n === (defaultVal || 3) }, [String(n) + ' — ' + scoreStars(n)])));
  }

  function newEvaluationModal(opts, onDone) {
    // opts: { pickEmployee: true } لقائد الفريق (لازم يختار الموظف).
    const period = el('input', { type: 'month', value: new Date().toISOString().slice(0, 7) });
    const employeeSel = opts.pickEmployee ? el('select', {}, [el('option', { value: '' }, ['جاري التحميل…'])]) : null;
    if (opts.pickEmployee) {
      api('/employees').then(({ employees }) => {
        employeeSel.innerHTML = '';
        employees.forEach((e) => employeeSel.appendChild(el('option', { value: e.id }, [e.nameAr || e.name])));
      }).catch(() => {});
    }
    const scoreInputs = {};
    const criteriaRows = CRITERIA.map(([key, label]) => {
      const sel = scoreSelect(3);
      scoreInputs[key] = sel;
      return el('div', { class: 'field' }, [el('label', {}, [label]), sel]);
    });
    const strengths = el('textarea', { rows: 2, placeholder: 'نقاط القوة (اختياري)' });
    const improvements = el('textarea', { rows: 2, placeholder: 'نقاط تحتاج تحسين (اختياري)' });

    const body = el('div', {}, [
      opts.pickEmployee ? el('div', { class: 'field' }, [el('label', {}, ['الموظف']), employeeSel]) : null,
      el('div', { class: 'field' }, [el('label', {}, ['الفترة']), period]),
      ...criteriaRows,
      el('div', { class: 'field' }, [el('label', {}, ['نقاط القوة']), strengths]),
      el('div', { class: 'field' }, [el('label', {}, ['نقاط للتحسين']), improvements]),
    ]);
    const dlg = modal('📝 تقييم أداء جديد', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        if (opts.pickEmployee && !employeeSel.value) { toast('اختر الموظف', 'error'); return; }
        if (!period.value) { toast('اختر الفترة', 'error'); return; }
        const scores = {};
        CRITERIA.forEach(([key]) => { scores[key] = Number(scoreInputs[key].value); });
        try {
          await api('/evaluations', {
            method: 'POST',
            body: {
              employeeId: opts.pickEmployee ? Number(employeeSel.value) : undefined,
              period: period.value,
              scores,
              strengths: strengths.value.trim(),
              improvements: improvements.value.trim(),
            },
          });
          toast('تم حفظ التقييم', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['حفظ التقييم'])
    );
  }

  function viewEvaluationModal(evaluation, isTL, onDone) {
    const rows = CRITERIA.map(([key, label]) =>
      el('div', { class: 'flex', style: 'justify-content:space-between;padding:4px 0' }, [
        el('span', {}, [label]),
        el('span', {}, [scoreStars(evaluation.scores[key])]),
      ])
    );
    const body = el('div', {}, [
      el('div', { class: 'card-pad', style: 'text-align:center;margin-bottom:12px' }, [
        el('div', { style: 'font-size:28px;font-weight:800;color:' + overallColor(evaluation.overallScore) }, [String(evaluation.overallScore) + ' / 5']),
        el('div', { class: 'muted' }, ['التقييم العام — ' + evaluation.period]),
      ]),
      ...rows,
      evaluation.strengths ? el('div', { class: 'mt-16' }, [el('div', { class: 'muted' }, ['نقاط القوة']), el('div', {}, [evaluation.strengths])]) : null,
      evaluation.improvements ? el('div', { class: 'mt-16' }, [el('div', { class: 'muted' }, ['نقاط للتحسين']), el('div', {}, [evaluation.improvements])]) : null,
      !isTL && evaluation.status !== 'ACKNOWLEDGED' ? el('div', { class: 'field mt-16' }, [el('label', {}, ['تعليقك (اختياري)']), el('textarea', { rows: 2, id: 'eval-comment' })]) : null,
      evaluation.employeeComment ? el('div', { class: 'mt-16' }, [el('div', { class: 'muted' }, ['تعليق الموظف']), el('div', {}, [evaluation.employeeComment])]) : null,
    ]);
    const dlg = modal('📝 تقييم أداء', body, []);
    const footer = dlg.el.querySelector('.modal-footer');
    footer.append(el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إغلاق']));
    if (!isTL && evaluation.status !== 'ACKNOWLEDGED') {
      footer.append(el('button', { class: 'btn btn-primary', onclick: async () => {
        const commentEl = dlg.el.querySelector('#eval-comment');
        try {
          await api('/evaluations/' + evaluation.id + '/acknowledge', { method: 'POST', body: { comment: commentEl ? commentEl.value.trim() : '' } });
          toast('تم تسجيل اطلاعك على التقييم', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['تأكيد الاطلاع']));
    }
  }

  App.route('/evaluations', async () => {
    const user = App.state.user;
    const isTL = user.role === 'team_leader';
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['📝 ' + (isTL ? 'الأداء والتقييم' : 'تقييماتي')]),
      isTL ? el('button', { class: 'btn btn-primary btn-sm', onclick: () => newEvaluationModal({ pickEmployee: true }, load) }, ['➕ تقييم جديد']) : null,
    ]));

    const box = el('div');
    container.appendChild(box);

    async function load() {
      const { evaluations } = await api('/evaluations');
      box.innerHTML = '';
      if (evaluations.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد تقييمات بعد.'])); return; }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(isTL ? ['الموظف'] : []), 'الفترة', 'التقييم العام', 'الحالة', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, evaluations.map((ev) => el('tr', {}, [
            ...(isTL ? [el('td', {}, [ev.employeeNameAr || ev.employeeName])] : []),
            el('td', {}, [ev.period]),
            el('td', { style: 'font-weight:700;color:' + overallColor(ev.overallScore) }, [String(ev.overallScore) + ' / 5']),
            el('td', {}, [el('span', { class: 'badge', style: ev.status === 'ACKNOWLEDGED' ? 'background:var(--success-soft);color:var(--success)' : 'background:var(--warning-soft);color:var(--warning)' }, [ev.status === 'ACKNOWLEDGED' ? 'تم الاطلاع' : 'بانتظار الاطلاع'])]),
            el('td', {}, [el('button', { class: 'btn btn-sm btn-outline', onclick: () => viewEvaluationModal(ev, isTL, load) }, ['عرض'])]),
          ]))),
        ]),
      ]));
    }
    await load();
    const off = App.on('rt:EVALUATION_CREATED', load);
    const off2 = App.on('rt:EVALUATION_ACKNOWLEDGED', load);
    container.cleanup = () => { off(); off2(); };
    return container;
  });
})();
