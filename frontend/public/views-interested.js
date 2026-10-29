'use strict';
(function () {
  const { el, api, badges, fmt } = App;

  // "عملاء تم الاتفاق": جدول بالعملاء اللي حالتهم "AGREED" وعليهم ملاحظة حقيقية
  // العميل بدون ملاحظة كافية بيظهر في قسم تنبيه تحت.
  App.route('/my-agreed', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['🤝 عملاء تم الاتفاق']),
      el('div', { class: 'page-actions' }, [el('button', { class: 'btn btn-outline', onclick: () => load() }, ['🔄 تحديث'])]),
    ]));
    container.appendChild(el('div', { class: 'muted mb-16' }, [
      'العميل بيظهر هنا لما تحط حالته "تم الاتفاق" وتكتب عليه ملاحظة حقيقية بتوضح تفاصيل الاتفاق.',
    ]));
    const body = el('div');
    container.appendChild(body);

    const isTl = App.state.user.role === 'team_leader';

    function row(c, withNote) {
      return el('tr', {}, [
        el('td', {}, [el('a', { href: '#/customers/' + c.id, style: 'font-weight:700' }, [c.id])]),
        el('td', {}, [c.name || '—']),
        el('td', { class: 'mono' }, [c.phone]),
        ...(isTl ? [el('td', {}, [c.employeeName || '—'])] : []),
        el('td', {}, [badges.priority(c.priority)]),
        el('td', { style: 'max-width:300px' }, [
          withNote
            ? el('div', {}, [el('div', {}, [c.note]), el('div', { class: 'muted', style: 'font-size:11px' }, [fmt.ago(c.noteAt)])])
            : el('span', { style: 'color:var(--danger,#dc2626)' }, ['محتاج ملاحظة حقيقية']),
        ]),
        el('td', {}, [
          el('div', { class: 'flex gap-8 wrap' }, [
            el('a', { class: 'btn btn-sm btn-outline', href: 'tel:' + c.normalizedPhone }, ['📞 اتصال']),
            el('button', { class: 'btn btn-sm btn-outline', onclick: () => App.navigate('#/customers/' + c.id) }, ['فتح']),
          ]),
        ]),
      ]);
    }

    function table(list, withNote) {
      const heads = ['الكود', 'الاسم', 'الهاتف', ...(isTl ? ['الموظف'] : []), 'الأولوية', 'الملاحظة', ''];
      return el('div', { class: 'table-wrap responsive-cards' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, heads.map((h) => el('th', {}, [h])))]),
          el('tbody', {}, list.map((c) => row(c, withNote))),
        ]),
      ]);
    }

    async function load() {
      body.innerHTML = '';
      let data;
      try {
        data = await api('/interested');
      } catch (e) {
        body.appendChild(el('div', { class: 'empty-state' }, [e.message]));
        return;
      }
      body.appendChild(el('div', { class: 'card card-pad mb-16' }, [
        el('div', { style: 'font-weight:800' }, [`عملاء تم الاتفاق (بملاحظة): ${data.customers.length}`]),
      ]));
      if (data.customers.length === 0) {
        body.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['🤝']), 'لسه مفيش عملاء تم الاتفاق معهم عليهم ملاحظة حقيقية.']));
      } else {
        body.appendChild(table(data.customers, true));
      }
      if (data.needNote.length > 0) {
        body.appendChild(el('div', { class: 'card card-pad mb-16 mt-16' }, [
          el('div', { style: 'font-weight:800;margin-bottom:6px' }, [`⚠️ ${data.needNote.length} عميل حالته "تم الاتفاق" بس مفيش عليه ملاحظة كافية`]),
          el('div', { class: 'muted' }, ['اكتب على كل واحد منهم ملاحظة حقيقية عشان يظهر في الجدول اللي فوق.']),
        ]));
        body.appendChild(table(data.needNote, false));
      }
    }

    await load();
    return container;
  });
})();
