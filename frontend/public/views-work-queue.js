'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  App.route('/work-queue', async () => {
    const user = App.state.user;
    const employeeId = user.employeeId;
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['🎯 قائمة مهامي'])]));

    const goalCard = el('div', { class: 'card card-pad mb-16' });
    const suggestionsCard = el('div', { class: 'card card-pad mb-16' });
    const queueCard = el('div', { class: 'card card-pad' });
    container.appendChild(goalCard);
    container.appendChild(suggestionsCard);
    container.appendChild(el('div', { class: 'section-title' }, ['العملاء التاليين للتعامل معهم']));
    container.appendChild(queueCard);

    async function load() {
      const [{ progress }, { suggestions }, { queue }] = await Promise.all([
        api('/employees/' + employeeId + '/daily-goal'),
        api('/employees/' + employeeId + '/followup-suggestions'),
        api('/employees/' + employeeId + '/work-queue'),
      ]);
      renderGoal(progress);
      renderSuggestions(suggestions);
      renderQueue(queue);
    }

    function renderGoal(p) {
      goalCard.innerHTML = '';
      goalCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, [`هدف اليوم — ${App.fmt.date(p.goalDate)}`]));
      if (!p.hasGoal) {
        goalCard.appendChild(el('div', { class: 'muted' }, ['لم يحدد لك قائد الفريق هدفًا اليوم.']));
        return;
      }
      const rows = [
        ['عملاء تم التعامل معهم', p.customers], ['تمت رؤيتهم', p.seen], ['تم التواصل معهم', p.contacted], ['متابعات مكتملة', p.followups],
      ];
      rows.forEach(([label, v]) => {
        const pct = v.target > 0 ? Math.min(100, Math.round((v.done / v.target) * 100)) : 0;
        goalCard.appendChild(el('div', { class: 'mb-8' }, [
          el('div', { class: 'flex-between', style: 'font-size:12.5px' }, [el('span', {}, [label]), el('span', { class: 'muted' }, [`${v.done}/${v.target}`])]),
          el('div', { class: 'progress-bar' }, [el('div', { style: `width:${pct}%` })]),
        ]));
      });
      goalCard.appendChild(el('div', { class: 'flex-between mt-8', style: 'font-weight:700' }, [el('span', {}, ['الإجمالي']), el('span', {}, [p.overallPercent + '%'])]));
    }

    function renderSuggestions(suggestions) {
      suggestionsCard.innerHTML = '';
      suggestionsCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['💡 اقتراحات ذكية للمتابعة']));
      if (suggestions.length === 0) {
        suggestionsCard.appendChild(el('div', { class: 'muted' }, ['لا توجد اقتراحات حاليًا.']));
        return;
      }
      suggestions.forEach((s) => {
        suggestionsCard.appendChild(el('div', { class: 'flex-between mb-8', style: 'padding:8px 10px;border-radius:8px;background:var(--surface-2)' }, [
          el('a', { href: '#/customers/' + s.customerId, style: 'font-weight:700' }, [s.customerName || s.customerId]),
          el('span', { class: 'faint' }, [s.suggestion]),
        ]));
      });
    }

    function renderQueue(queue) {
      queueCard.innerHTML = '';
      if (queue.length === 0) {
        queueCard.appendChild(el('div', { class: 'empty-state' }, ['لا يوجد عملاء مفتوحين حاليًا.']));
        return;
      }
      queueCard.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['العميل', 'الهاتف', 'الحالة', 'الأولوية', 'السبب', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, queue.map((c) => el('tr', {}, [
            el('td', {}, [el('a', { href: '#/customers/' + c.id, style: 'font-weight:700' }, [c.name || c.id])]),
            el('td', { class: 'mono' }, [c.phone]),
            el('td', {}, [badges.status(c.status)]),
            el('td', {}, [badges.priority(c.priority)]),
            el('td', { class: 'faint', style: 'font-size:12px' }, [c.reasons.join(' · ')]),
            el('td', {}, [el('button', { class: 'btn btn-sm btn-primary', onclick: () => App.navigate('#/customers/' + c.id) }, ['فتح'])]),
          ]))),
        ]),
      ]));
    }

    await load();
    const off = App.on('rt:*', () => load());
    container.cleanup = () => off();
    return container;
  });
})();
