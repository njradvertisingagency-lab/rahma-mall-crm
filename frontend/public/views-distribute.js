'use strict';
(function () {
  const { el, api, toast, badges } = App;

  App.route('/distribute', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['Distribute Customers'])]));

    const { customers: unassigned } = await api('/customers?employeeId=unassigned&pageSize=200');
    const { employees } = await api('/employees');

    const selectedCustomers = new Set(unassigned.map((c) => c.id));
    const selectedEmployees = new Set(employees.filter((e) => e.availability === 'AVAILABLE').map((e) => e.id));

    const card = el('div', { class: 'card card-pad' });
    card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, [`Unassigned customers: ${unassigned.length}`]));

    const custList = el('div', { style: 'max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:16px' },
      unassigned.length === 0
        ? [el('div', { class: 'muted' }, ['No unassigned customers — import some first.'])]
        : unassigned.map((c) => el('label', { class: 'checkbox-row', style: 'padding:4px 0' }, [
            el('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? selectedCustomers.add(c.id) : selectedCustomers.delete(c.id)) }),
            `${c.id} — ${c.phone} ${c.name ? '(' + c.name + ')' : ''}`,
          ]))
    );
    card.appendChild(custList);

    card.appendChild(el('div', { class: 'field' }, [
      el('label', {}, ['Distribution Method']),
      el('select', { id: 'method-select' }, [
        el('option', { value: 'EQUAL' }, ['Equal Distribution']),
        el('option', { value: 'ROUND_ROBIN' }, ['Round Robin']),
        el('option', { value: 'MANUAL' }, ['Manual Assignment (set per-customer employee below)']),
      ]),
    ]));

    const onlyAvailable = el('input', { type: 'checkbox', checked: true, id: 'only-available' });
    card.appendChild(el('label', { class: 'checkbox-row mb-16' }, [onlyAvailable, 'Only distribute to AVAILABLE employees (override manually below)']));

    card.appendChild(el('div', { style: 'font-weight:700;margin-bottom:8px' }, ['Employees']));
    const empList = el('div', { class: 'checklist-item', style: 'flex-wrap:wrap;gap:14px;border:none' },
      employees.map((e) => el('label', { class: 'checkbox-row' }, [
        el('input', { type: 'checkbox', checked: selectedEmployees.has(e.id) || undefined, onchange: (ev) => (ev.target.checked ? selectedEmployees.add(e.id) : selectedEmployees.delete(e.id)) }),
        `${e.name} `, badges.availability(e.availability),
      ]))
    );
    card.appendChild(empList);

    const previewBox = el('div', { class: 'mt-16' });
    card.appendChild(previewBox);

    card.appendChild(el('div', { class: 'flex gap-8 mt-16' }, [
      el('button', { class: 'btn btn-outline', onclick: () => previewDistribution() }, ['Preview Distribution']),
      el('button', { class: 'btn btn-primary', onclick: () => confirmDistribution() }, ['DISTRIBUTE']),
    ]));

    function previewDistribution() {
      const n = selectedCustomers.size;
      const m = selectedEmployees.size;
      if (m === 0) { previewBox.innerHTML = ''; previewBox.appendChild(el('div', { class: 'error-text' }, ['Select at least one employee.'])); return; }
      const base = Math.floor(n / m);
      const rem = n % m;
      const names = employees.filter((e) => selectedEmployees.has(e.id));
      previewBox.innerHTML = '';
      previewBox.appendChild(el('div', { style: 'font-weight:700;margin-bottom:8px' }, [`Preview: ${n} customers → ${m} employees`]));
      previewBox.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Employee', 'Will receive'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, names.map((e, i) => el('tr', {}, [el('td', {}, [e.name]), el('td', {}, [String(base + (i < rem ? 1 : 0))])]))),
        ]),
      ]));
    }

    async function confirmDistribution() {
      if (selectedCustomers.size === 0) { toast('Select at least one customer', 'error'); return; }
      if (selectedEmployees.size === 0) { toast('Select at least one employee', 'error'); return; }
      const method = document.getElementById('method-select').value;
      try {
        const res = await api('/distributions', {
          method: 'POST',
          body: {
            customerIds: [...selectedCustomers],
            employeeIds: [...selectedEmployees],
            method,
            onlyAvailableEmployees: document.getElementById('only-available').checked,
          },
        });
        toast(`Customers distributed successfully (${res.distribution.total}).`, 'success');
        App.navigate('#/customers');
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    container.appendChild(card);

    container.appendChild(el('div', { class: 'section-title' }, ['Distribution History']));
    const historyBox = el('div');
    container.appendChild(historyBox);
    try {
      const { distributions } = await api('/distributions');
      if (distributions.length === 0) historyBox.appendChild(el('div', { class: 'empty-state' }, ['No distributions yet.']));
      else {
        historyBox.appendChild(el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Label', 'Method', 'Total', 'Date', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, distributions.map((d) => el('tr', {}, [
              el('td', {}, [d.label]),
              el('td', {}, [d.method]),
              el('td', {}, [String(d.total_customers)]),
              el('td', {}, [App.fmt.dateTime(d.created_at)]),
              el('td', {}, [el('button', { class: 'btn btn-sm btn-outline', onclick: () => showDistributionDetail(d.id) }, ['View'])]),
            ]))),
          ]),
        ]));
      }
    } catch {}

    async function showDistributionDetail(distId) {
      const detail = await api('/distributions/' + distId);
      const body = el('div', {}, Object.entries(detail.perEmployee).map(([name, count]) => el('div', { class: 'flex-between mb-8' }, [name, String(count)])));
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
      backdrop.appendChild(el('div', { class: 'modal' }, [
        el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title' }, [detail.distribution.label]), el('button', { class: 'modal-close', onclick: () => backdrop.remove() }, ['✕'])]),
        el('div', { class: 'modal-body' }, [body]),
      ]));
      document.body.appendChild(backdrop);
    }

    return container;
  }, { roles: ['team_leader'] });
})();
