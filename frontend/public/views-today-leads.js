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
    const tableWrap = el('div', { class: 'table-wrap responsive-cards' });
    container.appendChild(summaryBox);
    container.appendChild(tableWrap);

    async function load() {
      tableWrap.innerHTML = '';
      summaryBox.innerHTML = '';
      let data;
      try {
        data = await api('/distributions/today');
      } catch (e) {
        tableWrap.appendChild(el('div', { class: 'empty-state' }, [e.message]));
        return;
      }
      summaryBox.appendChild(el('div', { class: 'card card-pad' }, [
        el('div', { style: 'font-weight:800' }, [`إجمالي الأرقام الموزّعة اليوم: ${data.total}`]),
      ]));
      if (data.customers.length === 0) {
        tableWrap.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['📭']), 'لسه محدش اتوزّع عليه عميل النهاردة.']));
        return;
      }
      tableWrap.appendChild(el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['الكود', 'الهاتف', 'الاسم', 'الموظف', 'الحالة', 'الأولوية', 'واتساب', 'آخر ملاحظة', ''].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, data.customers.map((c) => el('tr', {}, [
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

    await load();
    const off = App.onRealtime(load, 5000);
    container.cleanup = () => off();
    return container;
  }, { roles: ['team_leader'] });
})();
