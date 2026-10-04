'use strict';
(function () {
  const { el, api, fmt } = App;

  function money(v) {
    return Number(v || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';
  }

  const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

  function monthLabel(m) {
    if (!m) return '';
    const [y, mo] = m.split('-');
    return MONTH_NAMES[Number(mo) - 1] + ' ' + y;
  }

  // ====================================================================
  //  صفحة تكوين الرواتب — Salary Configuration
  // ====================================================================
  App.route('/payroll-salaries', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('div', { class: 'page-title' }, ['تكوين الرواتب']),
        el('div', { class: 'muted' }, ['تحديد الراتب الأساسي لكل موظف (الكوميشن يُحسب تلقائيًا)']),
      ]),
    ]));

    const tableWrap = el('div');
    container.appendChild(tableWrap);

    async function load() {
      const { employees } = await api('/accounting/payroll/salaries');
      tableWrap.innerHTML = '';

      if (!employees || employees.length === 0) {
        tableWrap.appendChild(el('div', { class: 'empty-state' }, ['لا يوجد موظفون نشطون.']));
        return;
      }

      const table = el('table', { class: 'data-table' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        'الموظف', 'الوظيفة', 'الراتب الأساسي', 'الحالة', ''
      ].map(h => el('th', {}, [h])))]));

      const tbody = el('tbody');
      employees.forEach(emp => {
        const base = emp.base_salary || 0;
        const configured = base > 0;

        tbody.appendChild(el('tr', {}, [
          el('td', { style: 'font-weight:700' }, [emp.name_ar || emp.name]),
          el('td', { class: 'muted' }, [emp.job_title || '—']),
          el('td', { class: 'mono', style: 'font-size:15px;font-weight:700' }, [configured ? money(base) : el('span', { class: 'muted' }, ['—'])]),
          el('td', {}, [configured ? el('span', { class: 'badge badge-success' }, ['محدد']) : el('span', { class: 'badge badge-danger' }, ['غير محدد'])]),
          el('td', {}, [
            el('button', { class: 'btn btn-sm ' + (configured ? 'btn-outline' : 'btn-brand'), onclick: () => openSalaryDialog(emp, load) }, [configured ? 'تعديل' : 'تحديد الراتب']),
          ]),
        ]));
      });
      table.appendChild(tbody);
      tableWrap.appendChild(el('div', { class: 'table-wrap' }, [table]));
    }

    await load();
    return container;
  });

  function openSalaryDialog(emp, onSave) {
    const overlay = el('div', { class: 'modal-overlay active' });
    const dialog = el('div', { class: 'modal', style: 'max-width:440px' });

    const inBase = el('input', { type: 'number', class: 'form-input', value: emp.base_salary || '', placeholder: '0', min: '0', step: '100', style: 'font-size:18px;font-weight:700;text-align:center' });
    const inNotes = el('input', { type: 'text', class: 'form-input', value: emp.salary_notes || '', placeholder: 'ملاحظات (اختياري)' });

    const saveBtn = el('button', { class: 'btn btn-brand' }, ['حفظ']);
    const cancelBtn = el('button', { class: 'btn btn-outline' }, ['إلغاء']);

    cancelBtn.onclick = () => overlay.remove();
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'جاري الحفظ...';
      try {
        await api('/accounting/payroll/salaries/' + emp.employee_id, {
          method: 'POST',
          body: JSON.stringify({
            baseSalary: Number(inBase.value) || 0,
            notes: inNotes.value.trim() || null,
          }),
        });
        App.toast('تم حفظ الراتب', 'success');
        overlay.remove();
        onSave();
      } catch (err) {
        App.toast(err.message || 'خطأ في الحفظ', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'حفظ';
      }
    };

    dialog.appendChild(el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title' }, ['راتب ' + (emp.name_ar || emp.name)]),
    ]));
    dialog.appendChild(el('div', { class: 'modal-body' }, [
      el('label', { class: 'form-label' }, ['الراتب الأساسي (شهري)']), inBase,
      el('label', { class: 'form-label mt-12' }, ['ملاحظات']), inNotes,
      el('div', { class: 'muted mt-12', style: 'font-size:12px' }, ['الكوميشن يُحسب تلقائيًا من عمولات المبيعات المسجّلة.']),
    ]));
    dialog.appendChild(el('div', { class: 'modal-footer' }, [cancelBtn, saveBtn]));
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    inBase.focus();
  }

  // ====================================================================
  //  صفحة دورات المرتبات — Payroll Runs
  // ====================================================================
  App.route('/payroll-runs', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('div', { class: 'page-title' }, ['دورات المرتبات']),
        el('div', { class: 'muted' }, ['إنشاء وإدارة دورات المرتبات الشهرية']),
      ]),
      el('button', { class: 'btn btn-brand', onclick: () => openNewRunDialog(loadRuns) }, ['+ دورة جديدة']),
    ]));

    const runsWrap = el('div');
    container.appendChild(runsWrap);

    async function loadRuns() {
      const { runs } = await api('/accounting/payroll/runs');
      runsWrap.innerHTML = '';

      if (!runs || runs.length === 0) {
        runsWrap.appendChild(el('div', { class: 'empty-state' }, ['لا توجد دورات مرتبات بعد. أنشئ أول دورة بالضغط على الزر أعلاه.']));
        return;
      }

      runs.forEach(run => {
        const isClosed = run.status === 'CLOSED';
        const card = el('div', {
          class: 'card card-pad',
          style: 'cursor:pointer;margin-bottom:12px',
          onclick: () => App.navigate('#/payroll-runs/' + run.id),
        }, [
          el('div', { class: 'flex-between' }, [
            el('div', {}, [
              el('div', { style: 'font-weight:700;font-size:16px' }, [monthLabel(run.month)]),
              el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, [
                run.employee_count + ' موظف',
                ' · أُنشئت: ' + fmt.dateTime(run.created_at),
                run.closed_at ? (' · أُغلقت: ' + fmt.dateTime(run.closed_at)) : '',
              ]),
            ]),
            el('span', { class: 'badge ' + (isClosed ? 'badge-success' : 'badge-warning') }, [isClosed ? 'مغلقة' : 'مسودة']),
          ]),
          el('div', { class: 'kpi-grid mt-12', style: 'gap:8px' }, [
            miniKpi('الرواتب الأساسية', money(run.total_base)),
            miniKpi('الكوميشن', money(run.total_bonuses)),
            miniKpi('الخصومات', money(run.total_deductions + run.total_advances + run.total_penalties)),
            miniKpi('صافي المرتبات', money(run.total_net), true),
          ]),
        ]);
        runsWrap.appendChild(card);
      });
    }

    await loadRuns();
    return container;
  });

  function miniKpi(label, value, accent) {
    return el('div', { style: 'text-align:center;padding:8px;background:var(--bg-2);border-radius:8px;min-width:100px' }, [
      el('div', { class: 'mono', style: 'font-size:13px;font-weight:700' + (accent ? ';color:var(--brand)' : '') }, [value]),
      el('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' }, [label]),
    ]);
  }

  function openNewRunDialog(onCreated) {
    const overlay = el('div', { class: 'modal-overlay active' });
    const dialog = el('div', { class: 'modal', style: 'max-width:380px' });

    const now = new Date();
    const defaultMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const inMonth = el('input', { type: 'month', class: 'form-input', value: defaultMonth });
    const inNotes = el('input', { type: 'text', class: 'form-input', placeholder: 'ملاحظات (اختياري)' });

    const createBtn = el('button', { class: 'btn btn-brand' }, ['إنشاء وحساب']);
    const cancelBtn = el('button', { class: 'btn btn-outline' }, ['إلغاء']);

    cancelBtn.onclick = () => overlay.remove();
    createBtn.onclick = async () => {
      if (!inMonth.value) { App.toast('يرجى اختيار الشهر', 'error'); return; }
      createBtn.disabled = true;
      createBtn.textContent = 'جاري الحساب...';
      try {
        const res = await api('/accounting/payroll/runs', {
          method: 'POST',
          body: JSON.stringify({ month: inMonth.value, notes: inNotes.value.trim() || null }),
        });
        App.toast('تم إنشاء دورة ' + monthLabel(inMonth.value) + ' (' + res.employeeCount + ' موظف)', 'success');
        overlay.remove();
        onCreated();
      } catch (err) {
        App.toast(err.message || 'خطأ', 'error');
        createBtn.disabled = false;
        createBtn.textContent = 'إنشاء وحساب';
      }
    };

    dialog.appendChild(el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title' }, ['دورة مرتبات جديدة'])]));
    dialog.appendChild(el('div', { class: 'modal-body' }, [
      el('label', { class: 'form-label' }, ['الشهر']), inMonth,
      el('label', { class: 'form-label mt-12' }, ['ملاحظات']), inNotes,
      el('div', { class: 'muted mt-12', style: 'font-size:12px' }, ['سيتم حساب المرتبات تلقائياً لجميع الموظفين النشطين بناءً على البيانات المتاحة.']),
    ]));
    dialog.appendChild(el('div', { class: 'modal-footer' }, [cancelBtn, createBtn]));
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // ====================================================================
  //  تفاصيل دورة المرتبات + كشوف المرتبات
  // ====================================================================
  App.route('/payroll-runs/:id', async (params) => {
    const container = el('div');
    const { run, payslips } = await api('/accounting/payroll/runs/' + params.id);
    const isClosed = run.status === 'CLOSED';
    const user = App.state.user;

    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('div', { class: 'page-title' }, ['كشف مرتبات ' + monthLabel(run.month)]),
        el('div', { class: 'muted' }, [
          run.employee_count + ' موظف',
          ' · ' + (isClosed ? 'مغلقة' : 'مسودة'),
          run.closed_at ? (' · أُغلقت: ' + fmt.dateTime(run.closed_at) + ' بواسطة ' + (run.closed_by_name || '')) : '',
        ]),
      ]),
      el('div', { class: 'flex gap-8' }, [
        ...(isClosed ? [] : [
          el('button', { class: 'btn btn-outline', onclick: async () => {
            if (!confirm('هل تريد إعادة حساب جميع المرتبات؟')) return;
            try {
              await api('/accounting/payroll/runs/' + run.id + '/recalculate', { method: 'POST' });
              App.toast('تمت إعادة الحساب', 'success');
              App.navigate('#/payroll-runs/' + run.id);
            } catch (err) { App.toast(err.message, 'error'); }
          } }, ['🔄 إعادة الحساب']),
          el('button', { class: 'btn btn-success', onclick: async () => {
            if (!confirm('هل أنت متأكد من إغلاق دورة ' + monthLabel(run.month) + '؟ لن يمكن تعديلها بعد الإغلاق.')) return;
            try {
              await api('/accounting/payroll/runs/' + run.id + '/close', { method: 'POST' });
              App.toast('تم إغلاق الدورة', 'success');
              App.navigate('#/payroll-runs/' + run.id);
            } catch (err) { App.toast(err.message, 'error'); }
          } }, ['🔒 إغلاق الدورة']),
        ]),
        ...(isClosed && user.isOwner ? [
          el('button', { class: 'btn btn-outline btn-danger', onclick: async () => {
            if (!confirm('هل تريد إعادة فتح الدورة؟')) return;
            try {
              await api('/accounting/payroll/runs/' + run.id + '/reopen', { method: 'POST' });
              App.toast('تمت إعادة فتح الدورة', 'success');
              App.navigate('#/payroll-runs/' + run.id);
            } catch (err) { App.toast(err.message, 'error'); }
          } }, ['🔓 إعادة فتح']),
        ] : []),
        el('button', { class: 'btn btn-outline', onclick: () => App.navigate('#/payroll-runs') }, ['← العودة']),
      ]),
    ]));

    // ── ملخص الإجماليات ──
    container.appendChild(el('div', { class: 'kpi-grid' }, [
      kpiCard('الرواتب الأساسية', money(run.total_base), 'brand'),
      kpiCard('الكوميشن والمكافآت', money(run.total_bonuses), 'success'),
      kpiCard('إجمالي الخصومات', money(run.total_deductions + run.total_advances + run.total_penalties), 'danger'),
      kpiCard('صافي المرتبات', money(run.total_net), 'brand'),
    ]));

    // ── جدول كشوف المرتبات ──
    container.appendChild(el('div', { class: 'section-title mt-24' }, ['كشوف المرتبات التفصيلية']));

    if (!payslips || payslips.length === 0) {
      container.appendChild(el('div', { class: 'empty-state' }, ['لا توجد كشوف مرتبات.']));
    } else {
      const table = el('table', { class: 'data-table' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        'الموظف', 'الأساسي', 'الكوميشن', 'الخصومات', 'الإجمالي', 'الصافي', ''
      ].map(h => el('th', { style: 'font-size:12px;white-space:nowrap' }, [h])))]));

      const tbody = el('tbody');
      payslips.forEach(slip => {
        const commission = slip.reward_bonus + slip.motivation_bonus + slip.benefits_bonuses;
        const allDeductions = slip.benefits_deductions + slip.benefits_advances + slip.absence_deduction + slip.late_deduction + slip.violation_fines;

        tbody.appendChild(el('tr', {}, [
          el('td', { style: 'font-weight:700;white-space:nowrap' }, [slip.employee_name]),
          el('td', { class: 'mono' }, [money(slip.base_salary)]),
          el('td', { class: 'mono', style: 'color:var(--success)' }, [commission > 0 ? '+' + money(commission) : '—']),
          el('td', { class: 'mono', style: 'color:var(--danger)' }, [allDeductions > 0 ? '-' + money(allDeductions) : '—']),
          el('td', { class: 'mono', style: 'font-weight:600' }, [money(slip.gross_salary)]),
          el('td', { class: 'mono', style: 'font-weight:700;color:var(--brand);font-size:14px' }, [money(slip.net_salary)]),
          el('td', {}, [
            el('button', { class: 'btn btn-sm btn-outline', onclick: (e) => { e.stopPropagation(); showPayslipDetail(slip, run); } }, ['تفاصيل']),
          ]),
        ]));
      });
      table.appendChild(tbody);
      container.appendChild(el('div', { class: 'table-wrap', style: 'overflow-x:auto' }, [table]));
    }

    return container;
  });

  function kpiCard(label, value, accent) {
    return el('div', { class: 'kpi-card' + (accent ? ' accent-' + accent : '') }, [
      el('div', { class: 'kpi-value' }, [value]),
      el('div', { class: 'kpi-label' }, [label]),
    ]);
  }

  // ====================================================================
  //  تفاصيل كشف مرتب فردي (Modal)
  // ====================================================================
  function showPayslipDetail(slip, run) {
    const overlay = el('div', { class: 'modal-overlay active' });
    const dialog = el('div', { class: 'modal', style: 'max-width:520px' });

    const commission = slip.reward_bonus + slip.motivation_bonus + slip.benefits_bonuses;
    const allDeductions = slip.benefits_deductions + slip.benefits_advances + slip.absence_deduction + slip.late_deduction + slip.violation_fines;

    function row(label, value, style) {
      return el('div', { class: 'flex-between', style: 'padding:6px 0;border-bottom:1px solid var(--border);' + (style || '') }, [
        el('span', {}, [label]),
        el('span', { class: 'mono' }, [value]),
      ]);
    }

    dialog.appendChild(el('div', { class: 'modal-header' }, [
      el('div', { class: 'modal-title' }, ['كشف مرتب: ' + slip.employee_name]),
      el('div', { class: 'muted', style: 'font-size:12px' }, [monthLabel(run.month)]),
    ]));

    dialog.appendChild(el('div', { class: 'modal-body', style: 'font-size:13px' }, [
      el('div', { style: 'font-weight:700;margin-bottom:8px;color:var(--brand)' }, ['الاستحقاقات']),
      row('الراتب الأساسي', money(slip.base_salary)),
      slip.reward_bonus > 0 ? row('عمولات المبيعات', '+' + money(slip.reward_bonus)) : null,
      slip.motivation_bonus > 0 ? row('حوافز', '+' + money(slip.motivation_bonus)) : null,
      slip.benefits_bonuses > 0 ? row('مكافآت إضافية', '+' + money(slip.benefits_bonuses)) : null,
      row('إجمالي الاستحقاقات', money(slip.gross_salary), 'font-weight:700;color:var(--success)'),

      allDeductions > 0 ? el('div', { style: 'font-weight:700;margin:16px 0 8px;color:var(--danger)' }, ['الاستقطاعات']) : null,
      slip.benefits_deductions > 0 ? row('خصومات', '-' + money(slip.benefits_deductions)) : null,
      slip.benefits_advances > 0 ? row('سُلف', '-' + money(slip.benefits_advances)) : null,
      slip.absence_deduction > 0 ? row('خصم غياب (' + slip.absence_days + ' يوم)', '-' + money(slip.absence_deduction)) : null,
      slip.late_deduction > 0 ? row('خصم تأخير (' + slip.late_count + ' مرة)', '-' + money(slip.late_deduction)) : null,
      slip.violation_fines > 0 ? row('غرامات مخالفات', '-' + money(slip.violation_fines)) : null,
      allDeductions > 0 ? row('إجمالي الاستقطاعات', '-' + money(allDeductions), 'font-weight:700;color:var(--danger)') : null,

      el('div', { style: 'margin-top:16px;padding:12px;background:var(--bg-2);border-radius:8px;text-align:center' }, [
        el('div', { class: 'muted', style: 'font-size:12px' }, ['صافي المرتب']),
        el('div', { class: 'mono', style: 'font-size:22px;font-weight:700;color:var(--brand)' }, [money(slip.net_salary)]),
      ]),
    ].filter(Boolean)));

    dialog.appendChild(el('div', { class: 'modal-footer' }, [
      el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, ['إغلاق']),
    ]));

    overlay.appendChild(dialog);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }

})();
