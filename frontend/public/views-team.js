'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  const AVAILABILITY_LABELS = { AVAILABLE: 'متاح', BUSY: 'مشغول', ON_BREAK: 'في استراحة', UNAVAILABLE: 'غير متاح' };

  App.route('/employees', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['الموظفين'])]));
    const grid = el('div', { class: 'kpi-grid' });
    container.appendChild(grid);

    async function load() {
      const { employees, weights } = await api('/employees');
      grid.innerHTML = '';
      employees.forEach((e) => {
        const card = el('div', { class: 'card card-pad' });
        card.appendChild(el('div', { class: 'flex-between' }, [
          el('div', { class: 'flex gap-8', style: 'align-items:center' }, [el('div', { class: 'avatar' }, [e.name[0]]), el('div', {}, [el('div', { style: 'font-weight:800' }, [e.name]), e.nameAr ? el('div', { class: 'faint' }, [e.nameAr]) : null])]),
        ]));
        card.appendChild(el('div', { class: 'mt-12' }, [badges.availability(e.availability)]));
        card.appendChild(el('div', { class: 'mt-12', style: 'font-size:12.5px' }, [
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['موزّع']), String(e.assigned)]),
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['مغلق']), String(e.closed)]),
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['المتابعات']), `${e.followupsCompleted}/${e.followupsTotal}`]),
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['متأخر']), String(e.followupsOverdue)]),
          el('div', { class: 'flex-between' }, [el('span', { class: 'muted' }, ['النقاط']), String(e.performanceScore)]),
        ]));
        card.appendChild(el('div', { class: 'field mt-12' }, [
          el('label', {}, ['الإتاحة']),
          el('select', { onchange: async (ev) => { await api('/employees/' + e.id, { method: 'PATCH', body: { availability: ev.target.value } }); toast('تم تحديث الإتاحة', 'success'); load(); } },
            ['AVAILABLE', 'BUSY', 'ON_BREAK', 'UNAVAILABLE'].map((a) => el('option', { value: a, selected: a === e.availability || undefined }, [AVAILABILITY_LABELS[a]]))),
        ]));
        card.appendChild(el('button', { class: 'btn btn-sm btn-outline btn-block', onclick: async () => { await api('/employees/' + e.id, { method: 'PATCH', body: { active: !e.active } }); load(); } }, [e.active === false ? 'تفعيل' : 'إيقاف']));
        grid.appendChild(card);
      });
    }
    await load();
    const off = App.on('rt:EMPLOYEE_AVAILABILITY_CHANGED', load);
    container.cleanup = () => off();
    return container;
  }, { roles: ['team_leader'] });

  const FOLLOWUP_FILTER_LABELS = { ALL: 'الكل', OPEN: 'مفتوحة', COMPLETED: 'مكتملة', CANCELLED: 'ملغاة' };
  const FOLLOWUP_STATUS_LABELS = { UPCOMING: 'قادمة', DUE: 'مستحقة', OVERDUE: 'متأخرة', COMPLETED: 'مكتملة', CANCELLED: 'ملغاة' };
  App.route('/followups', async () => {
    const container = el('div');
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['المتابعات'])]));
    const filterBar = el('div', { class: 'filters-bar' });
    const sel = el('select', {}, [['ALL', 'الكل'], ['OPEN', 'مفتوحة'], ['COMPLETED', 'مكتملة'], ['CANCELLED', 'ملغاة']].map(([v, l]) => el('option', { value: v }, [l])));
    filterBar.appendChild(sel);
    const overdueCheckbox = el('input', { type: 'checkbox', checked: params.get('overdue') === 'true' || undefined });
    const overdueOnly = el('label', { class: 'checkbox-row' }, [overdueCheckbox, 'المتأخرة فقط']);
    filterBar.appendChild(overdueOnly);
    filterBar.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: load }, ['تطبيق']));
    container.appendChild(filterBar);
    const box = el('div');
    container.appendChild(box);

    async function load() {
      const q = new URLSearchParams();
      if (sel.value !== 'ALL') q.set('status', sel.value);
      if (overdueCheckbox.checked) q.set('overdue', 'true');
      const { followups } = await api('/followups?' + q.toString());
      box.innerHTML = '';
      if (followups.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد متابعات لعرضها.'])); return; }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(App.state.user.role === 'team_leader' ? ['الموظف'] : []), 'العميل', 'الهاتف', 'الموعد', 'السبب', 'الحالة', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, followups.map((f) => el('tr', {}, [
            ...(App.state.user.role === 'team_leader' ? [el('td', {}, [f.employeeName || '—'])] : []),
            el('td', {}, [el('a', { href: '#/customers/' + f.customerId }, [f.customerName || f.customerId])]),
            el('td', { class: 'mono' }, [f.customerPhone || '']),
            el('td', {}, [fmt.dateTime(f.scheduledFor)]),
            el('td', {}, [f.reason || '—']),
            el('td', {}, [el('span', { class: 'badge badge-' + (f.status === 'OVERDUE' ? 'overdue' : f.status.toLowerCase()) }, [FOLLOWUP_STATUS_LABELS[f.status] || f.status])]),
            el('td', {}, [f.status === 'UPCOMING' || f.status === 'DUE' || f.status === 'OVERDUE' ? el('button', { class: 'btn btn-sm btn-success', onclick: async () => { await api('/followups/' + f.id + '/complete', { method: 'POST' }); load(); } }, ['إنجاز']) : '']),
          ]))),
        ]),
      ]));
    }
    await load();
    const off = App.on('rt:*', load);
    container.cleanup = () => off();
    return container;
  });

  App.route('/notifications', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['الإشعارات']),
      el('button', { class: 'btn btn-outline', onclick: async () => { await api('/notifications/mark-all-read', { method: 'POST' }); App.refreshNotifications(); load(); } }, ['تحديد الكل كمقروء']),
    ]));
    const box = el('div');
    container.appendChild(box);
    async function load() {
      const { notifications } = await api('/notifications');
      box.innerHTML = '';
      if (notifications.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد إشعارات.'])); return; }
      box.appendChild(el('div', { class: 'card' }, notifications.map((n) => el('div', {
        class: 'checklist-item', style: n.read ? '' : 'background:var(--brand-soft)',
        onclick: async () => { if (!n.read) { await api('/notifications/' + n.id + '/read', { method: 'PATCH' }); App.refreshNotifications(); load(); } },
      }, [el('div', {}, [el('div', { style: 'font-weight:700' }, [n.title]), el('div', { class: 'muted', style: 'font-size:13px' }, [n.message]), el('div', { class: 'faint' }, [fmt.ago(n.created_at)])])]))));
    }
    await load();
    const off = App.on('rt:*', load);
    container.cleanup = () => off();
    return container;
  });

  const ACTION_LABELS = {
    LOGIN: 'تسجيل دخول', LOGIN_FAILED: 'محاولة دخول فاشلة', LOGOUT: 'تسجيل خروج', PASSWORD_CHANGED: 'تغيير كلمة المرور',
    CUSTOMER_CREATED: 'إنشاء عميل', CUSTOMER_REASSIGNED: 'إعادة تعيين عميل', CUSTOMER_REOPENED: 'إعادة فتح عميل',
    CUSTOMER_ARCHIVED: 'أرشفة عميل', CUSTOMER_RESTORED: 'استعادة عميل', CUSTOMERS_IMPORTED: 'استيراد عملاء',
    STATUS_CHANGED: 'تغيير الحالة', PRIORITY_CHANGED: 'تغيير الأولوية', ATTRIBUTION_CHANGED: 'تغيير مصدر العميل',
    NOTE_ADDED: 'إضافة ملاحظة', PRODUCT_INTEREST_ADDED: 'إضافة منتج مهتم به', CALL_ATTEMPT_CREATED: 'تسجيل محاولة اتصال',
    CALL_INITIATED: 'بدء اتصال', WHATSAPP_CONTACT_INITIATED: 'تواصل عبر واتساب', FOLLOWUP_CREATED: 'إنشاء متابعة',
    FOLLOWUP_UPDATED: 'تعديل متابعة', FOLLOWUP_COMPLETED: 'إنجاز متابعة', FOLLOWUP_CANCELLED: 'إلغاء متابعة',
    DISTRIBUTION_CREATED: 'توزيع عملاء', EMPLOYEE_STATUS_CHANGED: 'تغيير حالة موظف', DAILY_GOAL_SET: 'تحديد هدف يومي',
    BRANCH_CREATED: 'إنشاء فرع', BRANCH_VISIT_CREATED: 'تسجيل زيارة فرع', DEAL_DONE_CREATED: 'تسجيل صفقة',
    PURCHASE_UPDATED: 'تعديل عملية شراء', PURCHASE_CANCELLED: 'إلغاء عملية شراء', REFUND_CREATED: 'تسجيل استرجاع',
    SETTINGS_UPDATED: 'تحديث الإعدادات', AI_QUESTION_ASKED: 'سؤال للمساعد الذكي',
    BULK_STATUS: 'تعديل جماعي للحالة', BULK_PRIORITY: 'تعديل جماعي للأولوية', BULK_ARCHIVE: 'أرشفة جماعية',
  };
  const ROLE_LABELS = { team_leader: 'قائد الفريق', employee: 'موظف' };
  App.route('/activity', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['سجل الأنشطة'])]));
    const box = el('div');
    container.appendChild(box);
    const { activity } = await api('/activity');
    if (activity.length === 0) box.appendChild(el('div', { class: 'empty-state' }, ['لا يوجد نشاط بعد.']));
    else box.appendChild(el('div', { class: 'timeline' }, activity.map((a) => el('div', { class: 'timeline-item' }, [
      el('div', { class: 'timeline-time' }, [fmt.dateTime(a.created_at)]),
      el('div', { class: 'timeline-text' }, [`${a.actor_name || 'النظام'} (${ROLE_LABELS[a.actor_role] || a.actor_role || '—'}) — ${ACTION_LABELS[a.action] || a.action.replace(/_/g, ' ').toLowerCase()}${a.entity_id ? ' · ' + a.entity_id : ''}`]),
    ]))));
    return container;
  });

  App.route('/profile', async () => {
    const user = App.state.user;
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['الملف الشخصي'])]));
    const card = el('div', { class: 'card card-pad', style: 'max-width:420px' });
    card.appendChild(el('div', { class: 'flex-between mb-8' }, [el('span', { class: 'muted' }, ['الاسم']), user.displayName]));
    card.appendChild(el('div', { class: 'flex-between mb-8' }, [el('span', { class: 'muted' }, ['اسم المستخدم']), user.username]));
    card.appendChild(el('div', { class: 'flex-between mb-16' }, [el('span', { class: 'muted' }, ['الدور']), ROLE_LABELS[user.role] || user.role]));
    card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['تغيير كلمة المرور']));
    const cur = el('input', { type: 'password', placeholder: 'كلمة المرور الحالية' });
    const next = el('input', { type: 'password', placeholder: 'كلمة المرور الجديدة (٨ أحرف على الأقل)' });
    card.appendChild(el('div', { class: 'field' }, [cur]));
    card.appendChild(el('div', { class: 'field' }, [next]));
    card.appendChild(el('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur.value, newPassword: next.value } });
        toast('تم تغيير كلمة المرور', 'success');
        cur.value = ''; next.value = '';
      } catch (e) { toast(e.message, 'error'); }
    } }, ['تحديث كلمة المرور']));
    container.appendChild(card);
    return container;
  });
})();
