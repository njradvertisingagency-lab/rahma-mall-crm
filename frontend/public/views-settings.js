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
