'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  // طلب أ/ هاني: صفحة لقائد الفريق تجمّع كل الأرقام اللي اتوزّعت النهاردة
  // (لأي موظف) في مكان واحد، عشان يقدر يتواصل معاهم هو كمان كدعم إضافي
  // للموظف المسؤول. قراءة فقط — مفيش تعديل على توزيع العميل هنا، وكل عميل
  // ظاهر جنبه آخر ملاحظة اتكتبت عليه.
  App.route('/today-leads', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['📞 أرقام اليوم الموزّعة']),
      el('div', { class: 'page-actions' }, [el('button', { class: 'btn btn-outline', onclick: () => load() }, ['🔄 تحديث'])]),
    ]));
    container.appendChild(el('div', { class: 'muted mb-16' }, [
      'كل العملاء اللي اتوزّعوا على أي موظف النهاردة — تقدر تتواصل مع أي واحد منهم بنفسك كدعم إضافي، بدون ما يتغيّر العميل بتاع الموظف الأساسي.',
    ]));

    const summaryBox = el('div', { class: 'mb-16' });
    const filterBar = el('div', { class: 'card card-pad mb-16', style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:end' });
    const tableWrap = el('div', { class: 'table-wrap responsive-cards' });
    container.appendChild(filterBar);
    container.appendChild(summaryBox);
    container.appendChild(tableWrap);

    // فلاتر على الجهاز (من غير أي قراءة إضافية من القاعدة): موظف / حالة / الملاحظات.
    let all = null;
    const filters = { emp: '', status: '', note: '' };

    function selectField(label, key, options) {
      const sel = el('select', { onchange: () => { filters[key] = sel.value; render(); } },
        options.map(([v, t]) => el('option', { value: v }, [t])));
      sel.value = filters[key];
      return el('div', { class: 'field', style: 'margin:0;min-width:170px' }, [el('label', {}, [label]), sel]);
    }

    function buildFilterBar() {
      filterBar.innerHTML = '';
      const counts = {};
      all.customers.forEach((c) => { const k = c.assignedEmployeeId ?? 'none'; counts[k] = counts[k] || { name: c.employeeName || 'غير موزّع', n: 0 }; counts[k].n++; });
      const empOpts = [['', `كل الموظفين (${all.customers.length})`]]
        .concat(Object.entries(counts).sort((x, y) => x[1].name.localeCompare(y[1].name)).map(([k, v]) => [String(k), `${v.name} (${v.n})`]));
      const statuses = [...new Set(all.customers.map((c) => c.status))];
      const stOpts = [['', 'كل الحالات']].concat(statuses.map((st) => [st, (App.labels && App.labels.status[st]) || st]));
      filterBar.append(
        selectField('الموظف', 'emp', empOpts),
        selectField('الحالة', 'status', stOpts),
        selectField('الملاحظات', 'note', [['', 'الكل'], ['with', 'عليها ملاحظة'], ['without', 'بدون ملاحظة']]),
        el('button', { class: 'btn btn-outline', onclick: () => { filters.emp = ''; filters.status = ''; filters.note = ''; buildFilterBar(); render(); } }, ['مسح الفلاتر'])
      );
    }

    function render() {
      tableWrap.innerHTML = '';
      summaryBox.innerHTML = '';
      const list = all.customers.filter((c) =>
        (!filters.emp || String(c.assignedEmployeeId ?? 'none') === filters.emp) &&
        (!filters.status || c.status === filters.status) &&
        (!filters.note || (filters.note === 'with' ? !!c.lastNote : !c.lastNote)));
      const withNote = list.filter((c) => c.lastNote).length;
      const byStatus = {};
      list.forEach((c) => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
      const summary = el('div', { class: 'card card-pad' }, [
        el('div', { style: 'font-weight:800' }, [filters.emp || filters.status || filters.note
          ? `المعروض: ${list.length} من ${all.total} رقم موزّع اليوم`
          : `إجمالي الأرقام الموزّعة اليوم: ${all.total}`]),
        el('div', { class: 'muted', style: 'margin-top:6px' }, [
          `عليها ملاحظة: ${withNote} — بدون ملاحظة: ${list.length - withNote}`,
        ]),
        el('div', { class: 'flex gap-8 wrap', style: 'margin-top:8px' },
          Object.entries(byStatus).map(([st, n]) => el('span', {}, [badges.status(st), ` × ${n}`]))),
      ]);
      summaryBox.appendChild(summary);
      if (all.customers.length === 0) {
        tableWrap.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['📭']), 'لسه محدش اتوزّع عليه عميل النهاردة.']));
        return;
      }
      if (list.length === 0) {
        tableWrap.appendChild(el('div', { class: 'empty-state' }, ['مفيش أرقام مطابقة للفلاتر دي.']));
        return;
      }
      tableWrap.appendChild(el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['الكود', 'الهاتف', 'الاسم', 'الموظف', 'الحالة', 'الأولوية', 'واتساب', 'آخر ملاحظة', ''].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, list.map((c) => el('tr', {}, [
          el('td', {}, [el('a', { href: '#/customers/' + c.id, style: 'font-weight:700' }, [c.id])]),
          el('td', { class: 'mono' }, [c.phone]),
          el('td', {}, [c.name || '—']),
          el('td', {}, [c.employeeName || el('span', { class: 'faint' }, ['غير موزّع'])]),
          el('td', {}, [badges.status(c.status)]),
          el('td', {}, [badges.priority(c.priority)]),
          el('td', {}, [badges.whatsapp(c.whatsappContactStatus)]),
          el('td', { style: 'max-width:220px' }, [
            c.lastNote
              ? el('div', {}, [el('div', {}, [c.lastNote]), el('div', { class: 'muted', style: 'font-size:11px' }, [fmt.ago(c.lastNoteAt)])])
              : el('span', { class: 'faint' }, ['لا توجد ملاحظات بعد']),
          ]),
          el('td', {}, [
            el('div', { class: 'flex gap-8 wrap' }, [
              el('a', { class: 'btn btn-sm btn-outline', href: 'tel:' + c.normalizedPhone }, ['📞 اتصال']),
              el('button', { class: 'btn btn-sm btn-outline', onclick: () => App.navigate('#/customers/' + c.id) }, ['فتح']),
            ]),
          ]),
        ]))),
      ]));
    }

    async function load() {
      try {
        all = await api('/distributions/today');
      } catch (e) {
        tableWrap.innerHTML = '';
        tableWrap.appendChild(el('div', { class: 'empty-state' }, [e.message]));
        return;
      }
      buildFilterBar();
      render();
    }

    await load();
    const off = App.onRealtime(load, 5000);
    container.cleanup = () => off();
    return container;
  }, { roles: ['team_leader'] });
})();
