'use strict';
(function () {
  const { el, api, toast } = App;

  App.route('/settings', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Settings'])]));
    const { settings } = await api('/settings');

    // --- Performance weights ---
    const w = settings.performance_weights || { completionRate: 0.35, closedCustomers: 0.3, followupCompletion: 0.2, responseSpeed: 0.15, overduePenaltyPerItem: 2 };
    const weightsCard = el('div', { class: 'card card-pad mb-16' });
    weightsCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:6px' }, ['Performance Score Formula']));
    weightsCard.appendChild(el('div', { class: 'muted mb-12', style: 'font-size:12.5px' }, [
      'Score = completion% × w₁ + (min(closed,50)/50)×100 × w₂ + followup-completion% × w₃ + response-speed% × w₄ − overdue × penalty. Every input is a real number from your data — nothing here is hidden.',
    ]));
    const fields = {};
    [
      ['completionRate', 'Completion Rate weight'],
      ['closedCustomers', 'Closed Customers weight'],
      ['followupCompletion', 'Follow-up Completion weight'],
      ['responseSpeed', 'Response Speed weight'],
      ['overduePenaltyPerItem', 'Overdue penalty (points per overdue item)'],
    ].forEach(([key, label]) => {
      const input = el('input', { type: 'number', step: '0.01', value: w[key] });
      fields[key] = input;
      weightsCard.appendChild(el('div', { class: 'field' }, [el('label', {}, [label]), input]));
    });
    weightsCard.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
      const body = Object.fromEntries(Object.entries(fields).map(([k, i]) => [k, Number(i.value)]));
      await api('/settings/performance_weights', { method: 'PATCH', body });
      toast('Performance weights saved', 'success');
    } }, ['Save Weights']));
    container.appendChild(weightsCard);

    // --- Distribution defaults ---
    const dd = settings.distribution_defaults || { method: 'EQUAL', onlyAvailableEmployees: true };
    const distCard = el('div', { class: 'card card-pad mb-16' });
    distCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['Distribution Defaults']));
    const methodSel = el('select', {}, ['EQUAL', 'ROUND_ROBIN', 'MANUAL'].map((m) => el('option', { value: m, selected: m === dd.method || undefined }, [m])));
    distCard.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Default method']), methodSel]));
    const onlyAvail = el('input', { type: 'checkbox', checked: dd.onlyAvailableEmployees !== false || undefined });
    distCard.appendChild(el('label', { class: 'checkbox-row mb-12' }, [onlyAvail, 'Only distribute to AVAILABLE employees by default']));
    distCard.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
      await api('/settings/distribution_defaults', { method: 'PATCH', body: { method: methodSel.value, onlyAvailableEmployees: onlyAvail.checked } });
      toast('Distribution defaults saved', 'success');
    } }, ['Save']));
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
    waCard.appendChild(el('div', { class: 'field' }, [el('label', {}, ['معاينة حية (Live Preview)']), previewBox]));
    waCard.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
      await api('/settings/whatsapp_template', { method: 'PATCH', body: { template: templateInput.value, companyName: companyInput.value } });
      toast('تم حفظ قالب الرسالة', 'success');
    } }, ['حفظ القالب']));
    container.appendChild(waCard);

    return container;
  }, { roles: ['team_leader'] });
})();
