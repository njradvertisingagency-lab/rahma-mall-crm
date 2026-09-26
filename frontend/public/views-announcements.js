'use strict';
(function () {
  const { el, api, toast, fmt } = App;

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

  function newAnnouncementModal(onDone) {
    const title = el('input', { type: 'text', placeholder: 'عنوان الإعلان' });
    const body2 = el('textarea', { rows: 4, placeholder: 'نص الإعلان' });
    const pinned = el('input', { type: 'checkbox' });
    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['العنوان']), title]),
      el('div', { class: 'field' }, [el('label', {}, ['النص']), body2]),
      el('label', { class: 'flex', style: 'gap:8px;align-items:center' }, [pinned, 'تثبيت الإعلان في الأعلى']),
    ]);
    const dlg = modal('📢 إعلان جديد', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        if (!title.value.trim() || !body2.value.trim()) { toast('اكتب العنوان والنص', 'error'); return; }
        try {
          await api('/announcements', { method: 'POST', body: { title: title.value.trim(), body: body2.value.trim(), pinned: pinned.checked } });
          toast('تم نشر الإعلان', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['نشر'])
    );
  }

  App.route('/announcements', async () => {
    const user = App.state.user;
    const isTL = user.role === 'team_leader' && (user.isHr || user.isOwner);
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['📢 الإعلانات الداخلية']),
      isTL ? el('button', { class: 'btn btn-primary btn-sm', onclick: () => newAnnouncementModal(load) }, ['➕ إعلان جديد']) : null,
    ]));
    const box = el('div');
    container.appendChild(box);

    async function load() {
      const { announcements } = await api('/announcements');
      box.innerHTML = '';
      if (announcements.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد إعلانات حاليًا.'])); return; }
      announcements.forEach((a) => {
        box.appendChild(el('div', { class: 'card card-pad mb-16' }, [
          el('div', { class: 'flex', style: 'justify-content:space-between;align-items:start' }, [
            el('div', { style: 'font-weight:800;font-size:16px' }, [(a.pinned ? '📌 ' : '') + a.title]),
            isTL ? el('button', { class: 'btn btn-sm btn-danger', onclick: async () => { if (confirm('تأكيد حذف الإعلان؟')) { try { await api('/announcements/' + a.id, { method: 'DELETE' }); load(); } catch (err) { toast(err.message, 'error'); } } } }, ['حذف']) : null,
          ]),
          el('div', { class: 'muted', style: 'margin:6px 0' }, [fmt.date(a.createdAt)]),
          el('div', { style: 'white-space:pre-wrap' }, [a.body]),
        ]));
      });
    }
    await load();
    const off = App.on('rt:ANNOUNCEMENT_POSTED', load);
    container.cleanup = () => { off(); };
    return container;
  }, { denyIfPlainSalesLead: true });
})();
