'use strict';
(function () {
  const { el, api, toast, badges, fmt } = App;

  const AVAILABILITY_LABELS = { AVAILABLE: 'متاح', BUSY: 'مشغول', ON_BREAK: 'في استراحة', UNAVAILABLE: 'غير متاح' };

  function modal(title, bodyNode, footerNodes) {
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
    const m = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title' }, [title]), el('button', { class: 'modal-close', onclick: () => close() }, ['✕'])]),
      el('div', { class: 'modal-body' }, [bodyNode]),
      el('div', { class: 'modal-footer' }, footerNodes || []),
    ]);
    backdrop.appendChild(m);
    document.body.appendChild(backdrop);
    function close() { backdrop.remove(); }
    return { close, el: backdrop };
  }

  function setDailyGoalModal(e) {
    const todayInput = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const targetCustomers = el('input', { type: 'number', min: '0', value: '0' });
    const targetSeen = el('input', { type: 'number', min: '0', value: '0' });
    const targetContacted = el('input', { type: 'number', min: '0', value: '0' });
    const targetFollowups = el('input', { type: 'number', min: '0', value: '0' });
    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['التاريخ']), todayInput]),
      el('div', { class: 'field' }, [el('label', {}, ['عدد العملاء المستهدف التعامل معهم']), targetCustomers]),
      el('div', { class: 'field' }, [el('label', {}, ['عدد العملاء المستهدف رؤيتهم']), targetSeen]),
      el('div', { class: 'field' }, [el('label', {}, ['عدد العملاء المستهدف التواصل معهم']), targetContacted]),
      el('div', { class: 'field' }, [el('label', {}, ['عدد المتابعات المستهدف إنجازها']), targetFollowups]),
    ]);
    const dlg = modal(`تحديد هدف يومي — ${e.name}`, body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        try {
          await api('/employees/' + e.id + '/daily-goal', {
            method: 'POST',
            body: {
              goalDate: todayInput.value,
              targetCustomers: Number(targetCustomers.value) || 0,
              targetSeen: Number(targetSeen.value) || 0,
              targetContacted: Number(targetContacted.value) || 0,
              targetFollowups: Number(targetFollowups.value) || 0,
            },
          });
          toast('تم تحديد الهدف اليومي', 'success');
          dlg.close();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['حفظ الهدف'])
    );
  }

  function addEmployeeModal(onDone) {
    const name = el('input', { placeholder: 'مثال: Sara' });
    const nameAr = el('input', { placeholder: 'مثال: سارة (اختياري)' });
    const username = el('input', { placeholder: 'بالإنجليزية والأرقام، ٣ أحرف على الأقل' });
    const password = el('input', { type: 'password', placeholder: '٨ أحرف على الأقل' });
    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['الاسم']), name]),
      el('div', { class: 'field' }, [el('label', {}, ['الاسم بالعربي (اختياري)']), nameAr]),
      el('div', { class: 'field' }, [el('label', {}, ['اسم المستخدم']), username]),
      el('div', { class: 'field' }, [el('label', {}, ['كلمة المرور']), password]),
    ]);
    const dlg = modal('إضافة موظف جديد', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        try {
          await api('/employees', { method: 'POST', body: { name: name.value.trim(), nameAr: nameAr.value.trim(), username: username.value.trim(), password: password.value } });
          toast('تم إضافة الموظف بنجاح', 'success');
          dlg.close();
          onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['إضافة'])
    );
  }

  function editUsernameModal(e, onDone) {
    const username = el('input', { value: e.username || '' });
    const body = el('div', {}, [el('div', { class: 'field' }, [el('label', {}, [`اسم المستخدم — ${e.name}`]), username])]);
    const dlg = modal('تعديل اسم المستخدم', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        try {
          await api('/employees/' + e.id + '/username', { method: 'PATCH', body: { username: username.value.trim() } });
          toast('تم تعديل اسم المستخدم', 'success');
          dlg.close();
          onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['حفظ'])
    );
  }

  function editNameModal(e, onDone) {
    const name = el('input', { value: e.name || '' });
    const nameAr = el('input', { value: e.nameAr || '' });
    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['الاسم']), name]),
      el('div', { class: 'field' }, [el('label', {}, ['الاسم بالعربي (اختياري)']), nameAr]),
    ]);
    const dlg = modal(`تعديل اسم الموظف — ${e.name}`, body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        if (!name.value.trim()) { toast('اسم الموظف مطلوب', 'error'); return; }
        try {
          await api('/employees/' + e.id + '/name', { method: 'PATCH', body: { name: name.value.trim(), nameAr: nameAr.value.trim() } });
          toast('تم تعديل اسم الموظف', 'success');
          dlg.close();
          onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['حفظ'])
    );
  }

  function resetPasswordModal(e) {
    const password = el('input', { type: 'password', placeholder: '٨ أحرف على الأقل' });
    const body = el('div', {}, [el('div', { class: 'field' }, [el('label', {}, [`كلمة مرور جديدة — ${e.name}`]), password])]);
    const dlg = modal('إعادة تعيين كلمة المرور', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        try {
          await api('/employees/' + e.id + '/reset-password', { method: 'POST', body: { newPassword: password.value } });
          toast('تم تغيير كلمة المرور', 'success');
          dlg.close();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['حفظ'])
    );
  }

  App.route('/employees', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['الموظفين']),
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => addEmployeeModal(load) }, ['➕ إضافة موظف جديد']),
    ]));
    const grid = el('div', { class: 'kpi-grid' });
    container.appendChild(grid);

    let badgesByEmployee = {};
    async function loadBadges() {
      try {
        const { weekly, monthly } = await api('/employees/badges');
        badgesByEmployee = {};
        [...weekly, ...monthly].forEach((b) => { (badgesByEmployee[b.employeeId] = badgesByEmployee[b.employeeId] || []).push(b); });
      } catch {}
    }
    async function load() {
      await loadBadges();
      const { employees, weights } = await api('/employees');
      grid.innerHTML = '';
      employees.forEach((e) => {
        const card = el('div', { class: 'card card-pad' });
        card.appendChild(el('div', { class: 'flex-between' }, [
          el('div', { class: 'flex gap-8', style: 'align-items:center' }, [App.avatar({ url: e.avatarUrl, name: e.name }), el('div', {}, [el('div', { style: 'font-weight:800' }, [e.name]), e.nameAr ? el('div', { class: 'faint' }, [e.nameAr]) : null, e.username ? el('div', { class: 'faint mono' }, ['@' + e.username]) : null])]),
        ]));
        card.appendChild(el('div', { class: 'mt-12' }, [
          badges.availability(e.availability),
          e.dndUntil && new Date(e.dndUntil) > new Date() ? el('span', { class: 'badge', style: 'background:var(--warning-soft);color:var(--warning);margin-inline-start:6px' }, ['🔕 حتى ' + new Date(e.dndUntil).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })]) : null,
        ]));
        if (badgesByEmployee[e.id] && badgesByEmployee[e.id].length) {
          card.appendChild(el('div', { class: 'flex gap-8 wrap mt-8' }, badgesByEmployee[e.id].map((b) => el('span', { class: 'badge', style: 'background:var(--brand-soft)', title: b.detail || '' }, [b.icon + ' ' + b.label]))));
        }
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
        card.appendChild(el('button', { class: 'btn btn-sm btn-outline btn-block mt-8', onclick: () => setDailyGoalModal(e) }, ['🎯 تحديد هدف يومي']));
        card.appendChild(el('button', { class: 'btn btn-sm btn-outline btn-block mt-8', onclick: async () => {
          const dataUrl = await App.pickAvatarImage();
          if (!dataUrl) return;
          try {
            await api('/employees/' + e.id + '/avatar', { method: 'POST', body: { dataUrl } });
            toast('تم تحديث الصورة الشخصية', 'success');
            load();
          } catch (err) { toast(err.message, 'error'); }
        } }, ['📷 تغيير الصورة الشخصية']));
        card.appendChild(el('button', { class: 'btn btn-sm btn-outline btn-block mt-8', onclick: () => editNameModal(e, load) }, ['✏️ تعديل اسم الموظف']));
        card.appendChild(el('button', { class: 'btn btn-sm btn-outline btn-block mt-8', onclick: () => editUsernameModal(e, load) }, ['✏️ تعديل اسم المستخدم']));
        card.appendChild(el('button', { class: 'btn btn-sm btn-outline btn-block mt-8', onclick: () => resetPasswordModal(e) }, ['🔑 إعادة تعيين كلمة المرور']));
        card.appendChild(el('button', { class: 'btn btn-sm btn-outline btn-block mt-8', onclick: async () => { await api('/employees/' + e.id, { method: 'PATCH', body: { active: !e.active } }); load(); } }, [e.active === false ? 'تفعيل' : 'إيقاف']));
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

  // مشتركة مع صفحة "أدائي" — انظر App.labels.activity / App.labels.role في app.js.
  const ACTION_LABELS = App.labels.activity;
  const ROLE_LABELS = App.labels.role;
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

    if (user.role === 'employee' && user.employeeId) {
      const avatarCard = el('div', { class: 'card card-pad mb-16', style: 'max-width:420px;text-align:center' });
      avatarCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:12px' }, ['الصورة الشخصية']));
      const avatarPreviewWrap = el('div', { style: 'margin-bottom:12px' }, [App.avatar({ url: user.avatarUrl, name: user.displayName, sizeClass: '', })]);
      avatarPreviewWrap.querySelector('.avatar').style.width = '84px';
      avatarPreviewWrap.querySelector('.avatar').style.height = '84px';
      avatarPreviewWrap.querySelector('.avatar').style.fontSize = '28px';
      avatarPreviewWrap.querySelector('.avatar').style.margin = '0 auto';
      avatarCard.appendChild(avatarPreviewWrap);
      const btnRow = el('div', { class: 'flex gap-8 wrap', style: 'justify-content:center' });
      btnRow.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
        const dataUrl = await App.pickAvatarImage();
        if (!dataUrl) return;
        try {
          await api('/employees/' + user.employeeId + '/avatar', { method: 'POST', body: { dataUrl } });
          App.state.user = { ...App.state.user, avatarUrl: dataUrl };
          toast('تم تحديث الصورة الشخصية', 'success');
          App.rerender();
        } catch (e) { toast(e.message, 'error'); }
      } }, ['📷 تغيير الصورة']));
      if (user.avatarUrl) {
        btnRow.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
          try {
            await api('/employees/' + user.employeeId + '/avatar', { method: 'DELETE' });
            App.state.user = { ...App.state.user, avatarUrl: null };
            toast('تم حذف الصورة الشخصية', 'success');
            App.rerender();
          } catch (e) { toast(e.message, 'error'); }
        } }, ['🗑 إزالة الصورة']));
      }
      avatarCard.appendChild(btnRow);
      container.appendChild(avatarCard);

      // --- وضع "عدم الإزعاج" المؤقت — بدل "غير متاح" الدائمة، يرجع تلقائيًا لـ"متاح" بعد المدة المحددة ---
      const dndCard = el('div', { class: 'card card-pad mb-16', style: 'max-width:420px' });
      dndCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, ['🔕 عدم الإزعاج المؤقت']));
      const dndStatus = el('div', { class: 'mb-12' });
      const dndBtns = el('div', { class: 'flex gap-8 wrap' });
      async function refreshDnd() {
        const { employees } = await api('/employees');
        const me = employees[0];
        dndStatus.innerHTML = '';
        dndBtns.innerHTML = '';
        const active = me.dndUntil && new Date(me.dndUntil) > new Date();
        if (active) {
          dndStatus.appendChild(el('div', {}, [
            el('span', { class: 'badge', style: 'background:var(--warning-soft);color:var(--warning)' }, ['🔕 مفعّل حتى ' + new Date(me.dndUntil).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })]),
          ]));
          dndBtns.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await api('/employees/' + me.id + '/dnd/cancel', { method: 'POST' }); toast('تم إلغاء عدم الإزعاج — أنت متاح الآن', 'success'); refreshDnd(); } }, ['إلغاء وإعادة "متاح"']));
        } else {
          dndStatus.appendChild(el('div', { class: 'muted' }, [`الحالة الحالية: ${AVAILABILITY_LABELS[me.availability] || me.availability}`]));
          [[15, '١٥ دقيقة'], [30, '٣٠ دقيقة'], [60, 'ساعة (استراحة غداء)'], [120, 'ساعتان']].forEach(([mins, label]) => {
            dndBtns.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
              try {
                await api('/employees/' + me.id + '/dnd', { method: 'POST', body: { minutes: mins } });
                toast('تم تفعيل عدم الإزعاج لمدة ' + label, 'success');
                refreshDnd();
              } catch (e) { toast(e.message, 'error'); }
            } }, [label]));
          });
        }
      }
      dndCard.appendChild(dndStatus);
      dndCard.appendChild(dndBtns);
      container.appendChild(dndCard);
      refreshDnd();
    }

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
