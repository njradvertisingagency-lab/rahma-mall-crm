'use strict';
(function () {
  const { el, api, toast } = App;

  const ROW_STATUS_LABELS = { NEW: 'جديد', DUPLICATE: 'مكرر', INVALID: 'غير صالح' };
  const REASON_LABELS = { EMPTY: 'رقم فارغ', INVALID_LENGTH: 'طول الرقم غير صحيح', INVALID_PREFIX: 'بادئة الرقم غير صحيحة' };

  App.route('/import', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['استيراد عملاء'])]));

    const tabs = el('div', { class: 'tabs' }, [
      el('div', { class: 'tab active', id: 'tab-paste' }, ['لصق الأرقام']),
      el('div', { class: 'tab', id: 'tab-file' }, ['رفع ملف CSV / Excel']),
    ]);
    container.appendChild(tabs);

    const pasteBox = el('textarea', { placeholder: '01153557528\n01153557529\n01153557521', style: 'min-height:180px' });
    const pasteCard = el('div', { class: 'card card-pad' }, [
      el('div', { class: 'field' }, [el('label', {}, ['الصق أرقام الهواتف — رقم في كل سطر، أو مفصولة بفاصلة']), pasteBox]),
      el('button', { class: 'btn btn-primary', onclick: () => runPreview({ text: pasteBox.value }) }, ['معاينة الاستيراد']),
    ]);

    const fileInput = el('input', { type: 'file', accept: '.csv,.xlsx,.xls' });
    const fileCard = el('div', { class: 'card card-pad', style: 'display:none' }, [
      el('div', { class: 'field' }, [el('label', {}, ['ارفع ملف CSV أو Excel (يدعم أعمدة الهاتف والاسم والمصدر والحملة والمنتج تلقائيًا)']), fileInput]),
      el('button', { class: 'btn btn-primary', onclick: runFilePreview }, ['معاينة الاستيراد']),
    ]);

    container.appendChild(pasteCard);
    container.appendChild(fileCard);

    const resultBox = el('div', { class: 'mt-20' });
    container.appendChild(resultBox);

    tabs.querySelector('#tab-paste').addEventListener('click', () => {
      tabs.querySelector('#tab-paste').classList.add('active');
      tabs.querySelector('#tab-file').classList.remove('active');
      pasteCard.style.display = '';
      fileCard.style.display = 'none';
    });
    tabs.querySelector('#tab-file').addEventListener('click', () => {
      tabs.querySelector('#tab-file').classList.add('active');
      tabs.querySelector('#tab-paste').classList.remove('active');
      fileCard.style.display = '';
      pasteCard.style.display = 'none';
    });

    let currentToken = null;

    async function runFilePreview() {
      const file = fileInput.files[0];
      if (!file) { toast('اختر ملفًا أولاً', 'error'); return; }
      const form = new FormData();
      form.append('file', file);
      try {
        const data = await api('/customers/import/preview', { method: 'POST', body: form });
        currentToken = data.token;
        renderPreview(data);
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    async function runPreview(body) {
      if (!body.text || !body.text.trim()) { toast('الصق رقمًا واحدًا على الأقل', 'error'); return; }
      try {
        const data = await api('/customers/import/preview', { method: 'POST', body });
        currentToken = data.token;
        renderPreview(data);
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    function renderPreview(data) {
      resultBox.innerHTML = '';
      const s = data.summary;
      resultBox.appendChild(el('div', { class: 'kpi-grid' }, [
        ['إجمالي الصفوف', s.total, null], ['صالح', s.valid, 'success'], ['مكرر', s.duplicate, 'warning'], ['غير صالح', s.invalid, 'danger'], ['عملاء جدد', s.newCustomers, 'brand'],
      ].map(([l, v, a]) => el('div', { class: 'kpi-card' + (a ? ' accent-' + a : '') }, [el('div', { class: 'kpi-value' }, [String(v)]), el('div', { class: 'kpi-label' }, [l])]))));

      resultBox.appendChild(el('div', { class: 'table-wrap mt-16' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['الهاتف', 'الاسم', 'الحالة', 'السبب'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, data.rows.slice(0, 200).map((r) => el('tr', {}, [
            el('td', { class: 'mono' }, [r.rawPhone]),
            el('td', {}, [r.name || '—']),
            el('td', {}, [el('span', { class: 'badge badge-' + (r.status === 'NEW' ? 'interested' : r.status === 'DUPLICATE' ? 'follow_up' : 'not_interested') }, [ROW_STATUS_LABELS[r.status] || r.status])]),
            el('td', {}, [(r.reason && REASON_LABELS[r.reason]) || r.reason || '—']),
          ]))),
        ]),
      ]));

      resultBox.appendChild(el('div', { class: 'flex gap-8 mt-16' }, [
        el('button', { class: 'btn btn-outline', onclick: () => { resultBox.innerHTML = ''; currentToken = null; } }, ['إلغاء']),
        el('button', { class: 'btn btn-primary', disabled: s.newCustomers === 0 || undefined, onclick: commitImport }, [`استيراد العملاء (${s.newCustomers})`]),
      ]));
    }

    async function commitImport() {
      if (!currentToken) return;
      try {
        const res = await api('/customers/import/commit', { method: 'POST', body: { token: currentToken } });
        toast(`تم استيراد ${res.imported} عميل بنجاح.`, 'success');
        App.navigate('#/customers');
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    return container;
  }, { roles: ['team_leader'] });
})();
