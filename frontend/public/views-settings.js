'use strict';
(function () {
  const { el, api, toast } = App;

  App.route('/settings', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['الإعدادات'])]));
    const { settings } = await api('/settings');

    // --- أوزان تقييم الأداء ---
    const w = settings.performance_weights || { completionRate: 0.35, closedCustomers: 0.3, followupCompletion: 0.2, responseSpeed: 0.15, overduePenaltyPerItem: 2 };
    const weightsCard = el('div', { class: 'card card-pad mb-16' });
    weightsCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:6px' }, ['معادلة تقييم الأداء']));
    weightsCard.appendChild(el('div', { class: 'muted mb-12', style: 'font-size:12.5px' }, [
      'التقييم = نسبة الإنجاز × و١ + (أقل قيمة بين المغلق و٥٠ / ٥٠)×١٠٠ × و٢ + نسبة إنجاز المتابعات × و٣ + سرعة الاستجابة% × و٤ − عدد المتأخر × الخصم. كل رقم هنا مأخوذ فعليًا من بياناتك.',
    ]));
    const fields = {};
    [
      ['completionRate', 'وزن نسبة الإنجاز'],
      ['closedCustomers', 'وزن العملاء المغلقين'],
      ['followupCompletion', 'وزن إنجاز المتابعات'],
      ['responseSpeed', 'وزن سرعة الاستجابة'],
      ['overduePenaltyPerItem', 'خصم التأخير (نقاط لكل متابعة متأخرة)'],
    ].forEach(([key, label]) => {
      const input = el('input', { type: 'number', step: '0.01', value: w[key] });
      fields[key] = input;
      weightsCard.appendChild(el('div', { class: 'field' }, [el('label', {}, [label]), input]));
    });
    weightsCard.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
      const body = Object.fromEntries(Object.entries(fields).map(([k, i]) => [k, Number(i.value)]));
      await api('/settings/performance_weights', { method: 'PATCH', body });
      toast('تم حفظ أوزان التقييم', 'success');
    } }, ['حفظ الأوزان']));
    container.appendChild(weightsCard);

    // --- إعدادات التوزيع الافتراضية ---
    const dd = settings.distribution_defaults || { method: 'EQUAL', onlyAvailableEmployees: true };
    const distCard = el('div', { class: 'card card-pad mb-16' });
    distCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['إعدادات التوزيع الافتراضية']));
    const DIST_METHOD_LABELS = { EQUAL: 'بالتساوي', ROUND_ROBIN: 'بالتناوب', MANUAL: 'يدوي' };
    const methodSel = el('select', {}, ['EQUAL', 'ROUND_ROBIN', 'MANUAL'].map((m) => el('option', { value: m, selected: m === dd.method || undefined }, [DIST_METHOD_LABELS[m]])));
    distCard.appendChild(el('div', { class: 'field' }, [el('label', {}, ['الطريقة الافتراضية']), methodSel]));
    const onlyAvail = el('input', { type: 'checkbox', checked: dd.onlyAvailableEmployees !== false || undefined });
    distCard.appendChild(el('label', { class: 'checkbox-row mb-12' }, [onlyAvail, 'التوزيع على الموظفين المتاحين فقط بشكل افتراضي']));
    distCard.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
      await api('/settings/distribution_defaults', { method: 'PATCH', body: { method: methodSel.value, onlyAvailableEmployees: onlyAvail.checked } });
      toast('تم حفظ إعدادات التوزيع', 'success');
    } }, ['حفظ']));
    container.appendChild(distCard);

    // --- إعدادات المبيعات (نسبة الضريبة وطرق الدفع المتاحة) ---
    const PAYMENT_METHOD_LABELS = { CASH: 'نقدًا', CARD: 'بطاقة', INSTALLMENT: 'تقسيط', OTHER: 'أخرى' };
    const ALL_PAYMENT_METHODS = ['CASH', 'CARD', 'INSTALLMENT', 'OTHER'];
    const ss = settings.sales_settings || { taxRatePercent: 0, paymentMethods: ['CASH', 'CARD', 'INSTALLMENT', 'OTHER'] };
    const salesCard = el('div', { class: 'card card-pad mb-16' });
    salesCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['إعدادات المبيعات']));
    const taxInput = el('input', { type: 'number', step: '0.01', min: '0', value: ss.taxRatePercent ?? 0 });
    salesCard.appendChild(el('div', { class: 'field' }, [el('label', {}, ['نسبة الضريبة % (تُطبّق تلقائيًا عند تسجيل صفقة)']), taxInput]));
    const paymentChecks = {};
    salesCard.appendChild(el('div', { style: 'font-weight:700;margin-bottom:8px' }, ['طرق الدفع المتاحة عند تسجيل صفقة']));
    const paymentList = el('div', { class: 'flex gap-8 mb-12', style: 'flex-wrap:wrap' },
      ALL_PAYMENT_METHODS.map((m) => {
        const cb = el('input', { type: 'checkbox', checked: (ss.paymentMethods || []).includes(m) || undefined });
        paymentChecks[m] = cb;
        return el('label', { class: 'checkbox-row' }, [cb, PAYMENT_METHOD_LABELS[m]]);
      }));
    salesCard.appendChild(paymentList);
    salesCard.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
      const selected = ALL_PAYMENT_METHODS.filter((m) => paymentChecks[m].checked);
      if (selected.length === 0) { toast('اختر طريقة دفع واحدة على الأقل', 'error'); return; }
      await api('/settings/sales_settings', { method: 'PATCH', body: { taxRatePercent: Number(taxInput.value) || 0, paymentMethods: selected } });
      toast('تم حفظ إعدادات المبيعات', 'success');
    } }, ['حفظ إعدادات المبيعات']));
    container.appendChild(salesCard);

    // --- إعدادات مكافآت المبيعات ---
    const rs = settings.rewards_settings || { amountPerSale: 200 };
    const rewardsCard = el('div', { class: 'card card-pad mb-16' });
    rewardsCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:6px' }, ['🏆 مكافآت المبيعات']));
    rewardsCard.appendChild(el('div', { class: 'muted mb-12', style: 'font-size:12.5px' }, [
      'كل مرة يسجّل فيها قائد الفريق "تمت الصفقة" منسوبةً لموظف، تُضاف هذه القيمة تلقائيًا لمحفظة مكافآته (تظهر في ملفه الشخصي). إبطال الصفقة أو استرجاعها بالكامل يعكس المكافأة تلقائيًا.',
    ]));
    const rewardAmountInput = el('input', { type: 'number', step: '1', min: '0', value: rs.amountPerSale ?? 200 });
    rewardsCard.appendChild(el('div', { class: 'field' }, [el('label', {}, ['قيمة المكافأة لكل صفقة (ج.م)']), rewardAmountInput]));
    rewardsCard.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
      const amount = Number(rewardAmountInput.value);
      if (!(amount >= 0)) { toast('قيمة غير صالحة', 'error'); return; }
      await api('/settings/rewards_settings', { method: 'PATCH', body: { amountPerSale: amount } });
      toast('تم حفظ إعدادات المكافآت', 'success');
    } }, ['حفظ إعدادات المكافآت']));
    container.appendChild(rewardsCard);

    // --- إدارة الفروع ---
    const branchesCard = el('div', { class: 'card card-pad mb-16' });
    branchesCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['إدارة الفروع']));
    const branchesList = el('div', { class: 'mb-12' });
    branchesCard.appendChild(branchesList);
    async function loadBranches() {
      const { branches } = await api('/sales/branches');
      branchesList.innerHTML = '';
      if (branches.length === 0) { branchesList.appendChild(el('div', { class: 'muted' }, ['لا توجد فروع مضافة بعد.'])); return; }
      branches.forEach((b) => branchesList.appendChild(el('div', { class: 'flex-between mb-8', style: 'font-size:13.5px' }, [el('span', {}, [b.name])])));
    }
    await loadBranches();
    const newBranchInput = el('input', { placeholder: 'اسم الفرع الجديد', style: 'max-width:220px' });
    branchesCard.appendChild(el('div', { class: 'flex gap-8 wrap' }, [
      newBranchInput,
      el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
        if (!newBranchInput.value.trim()) return;
        try {
          await api('/sales/branches', { method: 'POST', body: { name: newBranchInput.value.trim() } });
          toast('تم إضافة الفرع', 'success');
          newBranchInput.value = '';
          await loadBranches();
        } catch (e) { toast(e.message, 'error'); }
      } }, ['+ إضافة فرع']),
    ]));
    container.appendChild(branchesCard);

    // --- WhatsApp template ---
    const wa = settings.whatsapp_template || { template: '', companyName: 'رحمة مول' };
    const waCard = el('div', { class: 'card card-pad', dir: 'rtl', style: 'text-align:right' });
    waCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:6px' }, ['قالب رسالة واتساب']));
    waCard.appendChild(el('div', { class: 'muted mb-12', style: 'font-size:12.5px' }, ['المتغيرات المتاحة: {{customer_name}}، {{employee_name}}، {{company_name}}']));
    const companyInput = el('input', { value: wa.companyName });
    const templateInput = el('textarea', { dir: 'rtl', style: 'min-height:140px;text-align:right' }, [wa.template]);
    templateInput.value = wa.template;
    waCard.appendChild(el('div', { class: 'field' }, [el('label', {}, ['اسم الشركة']), companyInput]));
    waCard.appendChild(el('div', { class: 'field' }, [el('label', {}, ['نص الرسالة']), templateInput]));

    const previewBox = el('div', { class: 'card card-pad', style: 'background:var(--surface-2);white-space:pre-wrap;font-size:13.5px' });
    function updatePreview() {
      let out = templateInput.value
        .split('{{customer_name}}').join('أحمد محمد')
        .split('{{employee_name}}').join('أشرقت')
        .split('{{company_name}}').join(companyInput.value || 'رحمة مول');
      previewBox.textContent = out;
    }
    templateInput.addEventListener('input', updatePreview);
    companyInput.addEventListener('input', updatePreview);
    updatePreview();
    waCard.appendChild(el('div', { class: 'field' }, [el('label', {}, ['معاينة حية']), previewBox]));
    waCard.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
      await api('/settings/whatsapp_template', { method: 'PATCH', body: { template: templateInput.value, companyName: companyInput.value } });
      toast('تم حفظ قالب الرسالة', 'success');
    } }, ['حفظ القالب']));
    container.appendChild(waCard);

    return container;
  }, { roles: ['team_leader'] });
})();
