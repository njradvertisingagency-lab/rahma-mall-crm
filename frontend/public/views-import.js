'use strict';
(function () {
  const { el, api, toast } = App;

  App.route('/import', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Import Customers'])]));

    const tabs = el('div', { class: 'tabs' }, [
      el('div', { class: 'tab active', id: 'tab-paste' }, ['Paste Numbers']),
      el('div', { class: 'tab', id: 'tab-file' }, ['Upload CSV / Excel']),
    ]);
    container.appendChild(tabs);

    const pasteBox = el('textarea', { placeholder: '01153557528\n01153557529\n01153557521', style: 'min-height:180px' });
    const pasteCard = el('div', { class: 'card card-pad' }, [
      el('div', { class: 'field' }, [el('label', {}, ['Paste phone numbers — one per line, or comma-separated']), pasteBox]),
      el('button', { class: 'btn btn-primary', onclick: () => runPreview({ text: pasteBox.value }) }, ['Preview Import']),
    ]);

    const fileInput = el('input', { type: 'file', accept: '.csv,.xlsx,.xls' });
    const fileCard = el('div', { class: 'card card-pad', style: 'display:none' }, [
      el('div', { class: 'field' }, [el('label', {}, ['Upload a CSV / Excel file (phone, name, source, campaign, product columns supported — auto-detected)']), fileInput]),
      el('button', { class: 'btn btn-primary', onclick: runFilePreview }, ['Preview Import']),
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
      if (!file) { toast('Choose a file first', 'error'); return; }
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
      if (!body.text || !body.text.trim()) { toast('Paste at least one number', 'error'); return; }
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
        ['Total Rows', s.total, null], ['Valid', s.valid, 'success'], ['Duplicate', s.duplicate, 'warning'], ['Invalid', s.invalid, 'danger'], ['New Customers', s.newCustomers, 'brand'],
      ].map(([l, v, a]) => el('div', { class: 'kpi-card' + (a ? ' accent-' + a : '') }, [el('div', { class: 'kpi-value' }, [String(v)]), el('div', { class: 'kpi-label' }, [l])]))));

      resultBox.appendChild(el('div', { class: 'table-wrap mt-16' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Phone', 'Name', 'Status', 'Reason'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, data.rows.slice(0, 200).map((r) => el('tr', {}, [
            el('td', { class: 'mono' }, [r.rawPhone]),
            el('td', {}, [r.name || '—']),
            el('td', {}, [el('span', { class: 'badge badge-' + (r.status === 'NEW' ? 'interested' : r.status === 'DUPLICATE' ? 'follow_up' : 'not_interested') }, [r.status])]),
            el('td', {}, [r.reason || '—']),
          ]))),
        ]),
      ]));

      resultBox.appendChild(el('div', { class: 'flex gap-8 mt-16' }, [
        el('button', { class: 'btn btn-outline', onclick: () => { resultBox.innerHTML = ''; currentToken = null; } }, ['CANCEL']),
        el('button', { class: 'btn btn-primary', disabled: s.newCustomers === 0 || undefined, onclick: commitImport }, [`IMPORT CUSTOMERS (${s.newCustomers})`]),
      ]));
    }

    async function commitImport() {
      if (!currentToken) return;
      try {
        const res = await api('/customers/import/commit', { method: 'POST', body: { token: currentToken } });
        toast(`${res.imported} customers imported successfully.`, 'success');
        App.navigate('#/customers');
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    return container;
  }, { roles: ['team_leader'] });
})();
