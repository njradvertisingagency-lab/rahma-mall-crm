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

  const DOC_TYPE_LABELS = { CONTRACT: 'عقد عمل', ID_COPY: 'صورة بطاقة', CERTIFICATE: 'شهادة', CV: 'سيرة ذاتية', OTHER: 'أخرى' };

  function isExpiringSoon(expiryDate) {
    if (!expiryDate) return false;
    const days = (new Date(expiryDate + 'T00:00:00Z').getTime() - Date.now()) / 86400000;
    return days >= 0 && days <= 30;
  }
  function isExpired(expiryDate) {
    if (!expiryDate) return false;
    return new Date(expiryDate + 'T00:00:00Z').getTime() < Date.now();
  }

  function newDocumentModal(onDone) {
    const employeeSel = el('select', {}, [el('option', { value: '' }, ['جاري التحميل…'])]);
    api('/employees').then(({ employees }) => {
      employeeSel.innerHTML = '';
      employees.forEach((e) => employeeSel.appendChild(el('option', { value: e.id }, [e.nameAr || e.name])));
    }).catch(() => {});

    const docType = el('select', {}, Object.entries(DOC_TYPE_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
    const title = el('input', { type: 'text', placeholder: 'مثال: عقد عمل 2026' });
    const externalUrl = el('input', { type: 'url', placeholder: 'رابط الملف (Google Drive مثلاً) — اختياري' });
    const issueDate = el('input', { type: 'date' });
    const expiryDate = el('input', { type: 'date' });
    const notes = el('textarea', { rows: 2, placeholder: 'ملاحظات (اختياري)' });

    const body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', {}, ['الموظف']), employeeSel]),
      el('div', { class: 'field' }, [el('label', {}, ['نوع المستند']), docType]),
      el('div', { class: 'field' }, [el('label', {}, ['العنوان']), title]),
      el('div', { class: 'field' }, [el('label', {}, ['رابط الملف']), externalUrl]),
      el('div', { class: 'field' }, [el('label', {}, ['تاريخ الإصدار']), issueDate]),
      el('div', { class: 'field' }, [el('label', {}, ['تاريخ الانتهاء (لو موجود)']), expiryDate]),
      el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notes]),
    ]);
    const dlg = modal('📁 مستند جديد', body, []);
    dlg.el.querySelector('.modal-footer').append(
      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        if (!employeeSel.value) { toast('اختر الموظف', 'error'); return; }
        if (!title.value.trim()) { toast('اكتب عنوان المستند', 'error'); return; }
        try {
          await api('/documents', {
            method: 'POST',
            body: {
              employeeId: Number(employeeSel.value),
              docType: docType.value,
              title: title.value.trim(),
              externalUrl: externalUrl.value.trim(),
              issueDate: issueDate.value || null,
              expiryDate: expiryDate.value || null,
              notes: notes.value.trim(),
            },
          });
          toast('تم إضافة المستند', 'success');
          dlg.close();
          if (onDone) onDone();
        } catch (err) { toast(err.message, 'error'); }
      } }, ['إضافة'])
    );
  }

  App.route('/documents', async () => {
    const user = App.state.user;
    const isTL = user.role === 'team_leader' && (user.isHr || user.isOwner);
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['📁 ' + (isTL ? 'المستندات والعقود' : 'مستنداتي')]),
      isTL ? el('button', { class: 'btn btn-primary btn-sm', onclick: () => newDocumentModal(load) }, ['➕ مستند جديد']) : null,
    ]));
    const box = el('div');
    container.appendChild(box);

    async function load() {
      const { documents } = await api('/documents');
      box.innerHTML = '';
      if (documents.length === 0) { box.appendChild(el('div', { class: 'empty-state' }, ['لا توجد مستندات مسجلة.'])); return; }
      box.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [...(isTL ? ['الموظف'] : []), 'النوع', 'العنوان', 'تاريخ الانتهاء', 'الرابط', ...(isTL ? [''] : [])].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, documents.map((d) => el('tr', {}, [
            ...(isTL ? [el('td', {}, [d.employeeNameAr || d.employeeName])] : []),
            el('td', {}, [DOC_TYPE_LABELS[d.docType] || d.docType]),
            el('td', {}, [d.title]),
            el('td', {}, [d.expiryDate ? el('span', { style: isExpired(d.expiryDate) ? 'color:var(--danger);font-weight:700' : (isExpiringSoon(d.expiryDate) ? 'color:var(--warning);font-weight:700' : '') }, [fmt.date(d.expiryDate)]) : '—']),
            el('td', {}, [d.externalUrl ? el('a', { href: d.externalUrl, target: '_blank', rel: 'noopener' }, ['فتح الملف ↗']) : '—']),
            ...(isTL ? [el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', onclick: async () => { if (confirm('تأكيد حذف المستند؟')) { try { await api('/documents/' + d.id, { method: 'DELETE' }); load(); } catch (err) { toast(err.message, 'error'); } } } }, ['حذف'])])] : []),
          ]))),
        ]),
      ]));
    }
    await load();
    container.cleanup = () => {};
    return container;
  }, { denyIfPlainSalesLead: true });
})();
