'use strict';
(function () {
  const { el, api, toast } = App;

  const ACTION_AR = {
    CREATED: 'إنشاء ملف',
    EDITED: 'تعديل بيانات',
    DOCUMENT_ADDED: 'رفع مستند',
    DOCUMENT_REMOVED: 'حذف مستند',
    MOVED_TO_LEGAL: 'نقل للشئون القانونية',
    MOVED_TO_HR: 'نقل لـ HR',
    ARCHIVED: 'أرشفة',
    RESTORED: 'استعادة من الأرشيف',
    TRANSFER_REQUESTED: 'طلب نقل',
    TRANSFER_APPROVED: 'موافقة على نقل',
    TRANSFER_REJECTED: 'رفض طلب نقل',
  };

  // ────── Helpers ──────
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ────── الصفحة الرئيسية: قائمة الملفات ──────
  App.route('/legal-files', async () => {
    const user = App.state.user;
    const container = el('div');

    let currentSection = null; // null = الكل
    let currentStatus = 'ACTIVE';
    let searchQ = '';
    let page = 1;

    // ── الإحصائيات ──
    const statsRow = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px' });

    // ── التبويبات ──
    const tabsRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px' });

    // ── البحث ──
    const searchInput = el('input', {
      type: 'text', placeholder: 'ابحث برقم الملف أو اسم العميل أو الهاتف…',
      style: 'width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)',
      onkeydown: (e) => { if (e.key === 'Enter') { searchQ = e.target.value.trim(); page = 1; loadFiles(); } },
    });

    // ── طلبات النقل الواردة ──
    const transfersSection = el('div');

    // ── قائمة الملفات ──
    const filesList = el('div');
    const pagination = el('div', { style: 'display:flex;justify-content:center;gap:8px;margin-top:16px' });

    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['⚖️ الملفات القانونية']),
      el('div', { class: 'page-actions', style: 'display:flex;gap:8px' }, [
        el('button', { class: 'btn btn-outline', onclick: () => loadAll() }, ['🔄 تحديث']),
        el('button', { class: 'btn btn-primary', onclick: () => showCreateForm() }, ['➕ ملف جديد']),
      ]),
    ]));
    container.appendChild(statsRow);
    container.appendChild(tabsRow);
    container.appendChild(el('div', { style: 'margin-bottom:16px' }, [searchInput]));
    container.appendChild(transfersSection);
    container.appendChild(filesList);
    container.appendChild(pagination);

    async function loadStats() {
      try {
        const r = await api('/legal-files/stats/summary');
        statsRow.innerHTML = '';
        const cards = [
          ['📂 HR', r.hrFiles, '#3498db'],
          ['⚖️ قانونية', r.legalFiles, '#8e44ad'],
          ['🗄️ أرشيف', r.archivedFiles, '#95a5a6'],
          ['📩 طلبات واردة', r.pendingIncoming, '#e67e22'],
          ['📤 طلبات صادرة', r.pendingOutgoing, '#27ae60'],
        ];
        for (const [label, count, color] of cards) {
          statsRow.appendChild(el('div', {
            style: `background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;border-top:3px solid ${color}`,
          }, [
            el('div', { style: 'font-size:28px;font-weight:800;color:' + color }, [String(count)]),
            el('div', { style: 'font-size:13px;color:var(--text-2);margin-top:4px' }, [label]),
          ]));
        }
      } catch (e) { console.error(e); }
    }

    function renderTabs() {
      tabsRow.innerHTML = '';
      const tabs = [
        [null, 'الكل'],
        ['HR', '📂 ملفات HR'],
        ['LEGAL', '⚖️ ملفات القانونية'],
      ];
      for (const [sec, label] of tabs) {
        tabsRow.appendChild(el('button', {
          class: 'btn ' + (currentSection === sec ? 'btn-primary' : 'btn-outline'),
          style: 'font-size:13px',
          onclick: () => { currentSection = sec; page = 1; loadFiles(); renderTabs(); },
        }, [label]));
      }
      // أرشيف
      tabsRow.appendChild(el('button', {
        class: 'btn ' + (currentStatus === 'ARCHIVED' ? 'btn-primary' : 'btn-outline'),
        style: 'font-size:13px',
        onclick: () => {
          currentStatus = currentStatus === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED';
          page = 1; loadFiles(); renderTabs();
        },
      }, ['🗄️ الأرشيف']));
    }

    async function loadTransfers() {
      try {
        const r = await api('/legal-files/transfers/pending');
        transfersSection.innerHTML = '';
        if (!r.transfers || r.transfers.length === 0) return;
        const heading = el('div', { style: 'font-weight:700;font-size:15px;margin-bottom:8px;color:var(--warning)' }, ['📩 طلبات نقل واردة (' + r.transfers.length + ')']);
        transfersSection.appendChild(heading);
        for (const t of r.transfers) {
          const card = el('div', {
            style: 'background:var(--surface);border:1px solid var(--warning);border-radius:10px;padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px',
          }, [
            el('div', {}, [
              el('span', { style: 'font-weight:700' }, ['ملف #' + t.file_number]),
              ' — ', t.customer_name,
              el('span', { style: 'color:var(--text-2);font-size:12px;margin-right:8px' }, [' من ' + t.from_section + ' → ' + t.to_section]),
              t.note ? el('div', { style: 'font-size:12px;color:var(--text-2)' }, ['💬 ' + t.note]) : null,
            ]),
            el('div', { style: 'display:flex;gap:6px' }, [
              el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { await api('/legal-files/transfers/' + t.id, { method: 'PATCH', body: JSON.stringify({ decision: 'APPROVED' }) }); toast('✅ تمت الموافقة'); loadAll(); } }, ['✅ موافقة']),
              el('button', { class: 'btn btn-outline btn-sm', onclick: async () => { await api('/legal-files/transfers/' + t.id, { method: 'PATCH', body: JSON.stringify({ decision: 'REJECTED' }) }); toast('❌ تم الرفض'); loadAll(); } }, ['❌ رفض']),
            ]),
          ]);
          transfersSection.appendChild(card);
        }
      } catch (e) { console.error(e); }
    }

    async function loadFiles() {
      try {
        let url = '/legal-files?status=' + currentStatus + '&page=' + page + '&limit=30';
        if (currentSection) url += '&section=' + currentSection;
        if (searchQ) url += '&q=' + encodeURIComponent(searchQ);
        const r = await api(url);
        filesList.innerHTML = '';
        if (!r.files || r.files.length === 0) {
          filesList.appendChild(el('div', { style: 'text-align:center;padding:40px;color:var(--text-2)' }, ['لا توجد ملفات']));
          pagination.innerHTML = '';
          return;
        }
        for (const f of r.files) {
          const sectionBadge = f.current_section === 'LEGAL'
            ? el('span', { style: 'background:#8e44ad;color:#fff;padding:2px 8px;border-radius:6px;font-size:11px' }, ['⚖️ قانونية'])
            : el('span', { style: 'background:#3498db;color:#fff;padding:2px 8px;border-radius:6px;font-size:11px' }, ['📂 HR']);
          const statusBadge = f.status === 'ARCHIVED'
            ? el('span', { style: 'background:#95a5a6;color:#fff;padding:2px 8px;border-radius:6px;font-size:11px;margin-right:4px' }, ['🗄️ أرشيف'])
            : null;
          const card = el('div', {
            style: 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin-bottom:10px;cursor:pointer;transition:box-shadow .15s',
            onclick: () => App.navigate('#/legal-files/' + f.id),
            onmouseover: function () { this.style.boxShadow = '0 2px 12px rgba(0,0,0,.08)'; },
            onmouseout: function () { this.style.boxShadow = 'none'; },
          }, [
            el('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px' }, [
              el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                el('span', { style: 'font-weight:800;font-size:16px' }, ['#' + f.file_number]),
                sectionBadge,
                statusBadge,
              ]),
              el('span', { style: 'font-size:12px;color:var(--text-2)' }, [fmtDate(f.created_at)]),
            ]),
            el('div', { style: 'margin-top:8px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px;font-size:13px' }, [
              el('div', {}, ['👤 ', el('strong', {}, [f.customer_name])]),
              el('div', {}, ['📱 ', f.customer_phone]),
              f.guarantor_name ? el('div', {}, ['🤝 ', f.guarantor_name]) : null,
              f.sales_name ? el('div', {}, ['🏷️ ', f.sales_name]) : null,
            ]),
          ]);
          filesList.appendChild(card);
        }
        // Pagination
        pagination.innerHTML = '';
        if (r.pages > 1) {
          for (let i = 1; i <= r.pages; i++) {
            pagination.appendChild(el('button', {
              class: 'btn ' + (i === page ? 'btn-primary' : 'btn-outline') + ' btn-sm',
              onclick: () => { page = i; loadFiles(); },
            }, [String(i)]));
          }
        }
      } catch (e) {
        filesList.innerHTML = '';
        filesList.appendChild(el('div', { style: 'color:var(--danger);padding:20px' }, ['❌ خطأ في تحميل الملفات']));
      }
    }

    function loadAll() { loadStats(); loadTransfers(); loadFiles(); renderTabs(); }

    // ────── نموذج إنشاء ملف جديد ──────
    function showCreateForm() {
      const overlay = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px',
        onclick: (e) => { if (e.target === overlay) overlay.remove(); },
      });
      const fields = {};
      const fieldDefs = [
        ['fileNumber', 'رقم الملف *', 'text'],
        ['customerName', 'اسم العميل *', 'text'],
        ['customerPhone', 'رقم هاتف العميل *', 'tel'],
        ['guarantorName', 'اسم الضامن', 'text'],
        ['guarantorPhone', 'رقم هاتف الضامن', 'tel'],
        ['salesName', 'اسم السيلز', 'text'],
        ['notes', 'ملاحظات', 'text'],
      ];
      const formFields = fieldDefs.map(([key, label, type]) => {
        const input = el('input', { type, placeholder: label, style: 'width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)' });
        fields[key] = input;
        return el('div', { style: 'margin-bottom:10px' }, [
          el('label', { style: 'display:block;font-size:13px;font-weight:600;margin-bottom:4px;color:var(--text-2)' }, [label]),
          input,
        ]);
      });
      const errMsg = el('div', { style: 'color:var(--danger);font-size:13px;margin-top:8px;display:none' });
      const form = el('div', {
        style: 'background:var(--surface);border-radius:16px;padding:24px;max-width:500px;width:100%;max-height:90vh;overflow-y:auto',
      }, [
        el('div', { style: 'font-size:18px;font-weight:800;margin-bottom:16px' }, ['➕ ملف جديد']),
        ...formFields,
        errMsg,
        el('div', { style: 'display:flex;gap:8px;margin-top:16px' }, [
          el('button', { class: 'btn btn-primary', onclick: async () => {
            const data = {};
            for (const [key] of fieldDefs) data[key] = fields[key].value.trim();
            if (!data.fileNumber || !data.customerName || !data.customerPhone) {
              errMsg.textContent = 'رقم الملف واسم العميل ورقم الهاتف مطلوبين';
              errMsg.style.display = 'block';
              return;
            }
            try {
              const r = await api('/legal-files', { method: 'POST', body: JSON.stringify(data) });
              toast('✅ تم إنشاء الملف #' + r.fileNumber);
              overlay.remove();
              loadAll();
            } catch (e) {
              errMsg.textContent = e.message || 'خطأ في إنشاء الملف';
              errMsg.style.display = 'block';
            }
          }}, ['💾 حفظ']),
          el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, ['إلغاء']),
        ]),
      ]);
      overlay.appendChild(form);
      document.body.appendChild(overlay);
      fields.fileNumber.focus();
    }

    loadAll();
    return container;
  });

  // ────── صفحة تفاصيل الملف ──────
  App.route('/legal-files/:id', async ({ id }) => {
    const user = App.state.user;
    const container = el('div');
    let fileData = null;
    let docs = [];

    async function load() {
      try {
        const r = await api('/legal-files/' + id);
        fileData = r.file;
        docs = r.documents || [];
        render();
      } catch (e) {
        container.innerHTML = '';
        container.appendChild(el('div', { style: 'color:var(--danger);padding:40px;text-align:center' }, ['❌ ' + (e.message || 'خطأ')]));
      }
    }

    function render() {
      container.innerHTML = '';
      if (!fileData) return;
      const f = fileData;

      // العنوان
      container.appendChild(el('div', { class: 'page-header' }, [
        el('div', { style: 'display:flex;align-items:center;gap:12px' }, [
          el('button', { class: 'btn btn-outline btn-sm', onclick: () => App.navigate('#/legal-files') }, ['→ رجوع']),
          el('div', { class: 'page-title' }, ['ملف #' + f.file_number]),
          f.current_section === 'LEGAL'
            ? el('span', { style: 'background:#8e44ad;color:#fff;padding:3px 10px;border-radius:8px;font-size:12px' }, ['⚖️ قانونية'])
            : el('span', { style: 'background:#3498db;color:#fff;padding:3px 10px;border-radius:8px;font-size:12px' }, ['📂 HR']),
          f.status === 'ARCHIVED'
            ? el('span', { style: 'background:#95a5a6;color:#fff;padding:3px 10px;border-radius:8px;font-size:12px' }, ['🗄️ أرشيف'])
            : null,
        ]),
      ]));

      // أزرار الإجراءات
      const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px' });
      if (f.status === 'ACTIVE') {
        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', onclick: () => showEditForm() }, ['✏️ تعديل البيانات']));
        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', onclick: () => showUploadForm() }, ['📎 رفع مستند']));

        const targetSection = f.current_section === 'HR' ? 'LEGAL' : 'HR';
        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', style: 'border-color:#8e44ad;color:#8e44ad', onclick: async () => {
          if (!confirm('نقل الملف إلى قسم ' + (targetSection === 'LEGAL' ? 'الشئون القانونية' : 'HR') + '?')) return;
          await api('/legal-files/' + id + '/move', { method: 'PATCH', body: JSON.stringify({ toSection: targetSection }) });
          toast('✅ تم النقل');
          load();
        }}, ['🔀 نقل إلى ' + (targetSection === 'LEGAL' ? 'القانونية' : 'HR')]));

        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', style: 'border-color:#e67e22;color:#e67e22', onclick: async () => {
          const note = prompt('سبب طلب النقل (اختياري):');
          if (note === null) return;
          try {
            await api('/legal-files/' + id + '/transfer-request', { method: 'POST', body: JSON.stringify({ note: note || '' }) });
            toast('✅ تم إرسال طلب النقل');
          } catch (e) { toast('❌ ' + (e.message || 'خطأ')); }
        }}, ['📩 طلب نقل']));

        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', style: 'border-color:var(--danger);color:var(--danger)', onclick: async () => {
          if (!confirm('أرشفة الملف؟ لن يظهر في القائمة الرئيسية.')) return;
          await api('/legal-files/' + id + '/archive', { method: 'PATCH' });
          toast('🗄️ تم الأرشفة');
          load();
        }}, ['🗄️ أرشفة']));
      } else {
        actions.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
          await api('/legal-files/' + id + '/restore', { method: 'PATCH' });
          toast('✅ تمت الاستعادة');
          load();
        }}, ['♻️ استعادة من الأرشيف']));
      }
      container.appendChild(actions);

      // بيانات الملف
      const infoGrid = el('div', {
        style: 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px',
      }, [
        infoItem('👤 اسم العميل', f.customer_name),
        infoItem('📱 هاتف العميل', f.customer_phone),
        infoItem('🤝 اسم الضامن', f.guarantor_name || '—'),
        infoItem('📱 هاتف الضامن', f.guarantor_phone || '—'),
        infoItem('🏷️ اسم السيلز', f.sales_name || '—'),
        infoItem('📅 تاريخ الإنشاء', fmtDate(f.created_at)),
        f.notes ? infoItem('📝 ملاحظات', f.notes) : null,
      ]);
      container.appendChild(infoGrid);

      // المستندات
      container.appendChild(el('div', { style: 'font-size:16px;font-weight:700;margin-bottom:10px' }, ['📎 المستندات (' + docs.length + '/20)']));
      if (docs.length === 0) {
        container.appendChild(el('div', { style: 'color:var(--text-2);padding:20px;text-align:center;background:var(--surface);border-radius:10px;border:1px dashed var(--border)' }, ['لا توجد مستندات مرفقة']));
      } else {
        const docsGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:20px' });
        for (const doc of docs) {
          const isImg = doc.content_type.startsWith('image/');
          const card = el('div', {
            style: 'background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center;position:relative',
          }, [
            el('div', { style: 'font-size:32px;margin-bottom:6px' }, [isImg ? '🖼️' : '📄']),
            el('div', { style: 'font-size:12px;font-weight:600;word-break:break-all' }, [doc.filename]),
            el('div', { style: 'font-size:11px;color:var(--text-2)' }, [fmtSize(doc.file_size)]),
            el('div', { style: 'display:flex;gap:4px;justify-content:center;margin-top:8px' }, [
              el('button', { class: 'btn btn-outline btn-sm', style: 'font-size:11px', onclick: async (e) => {
                e.stopPropagation();
                try {
                  const r = await api('/legal-files/' + id + '/documents/' + doc.id);
                  const d = r.document;
                  // فتح في تبويب جديد
                  const w = window.open('', '_blank');
                  if (isImg) {
                    w.document.write('<html><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111"><img src="data:' + d.content_type + ';base64,' + d.data + '" style="max-width:100%;max-height:100vh" /></body></html>');
                  } else {
                    w.document.write('<html><body style="margin:0"><embed src="data:' + d.content_type + ';base64,' + d.data + '" type="' + d.content_type + '" width="100%" height="100%" style="position:fixed;inset:0" /></body></html>');
                  }
                } catch (e) { toast('❌ خطأ في تحميل المستند'); }
              }}, ['👁️ عرض']),
              f.status === 'ACTIVE' ? el('button', { class: 'btn btn-outline btn-sm', style: 'font-size:11px;color:var(--danger);border-color:var(--danger)', onclick: async (e) => {
                e.stopPropagation();
                if (!confirm('حذف المستند "' + doc.filename + '"?')) return;
                await api('/legal-files/' + id + '/documents/' + doc.id, { method: 'DELETE' });
                toast('🗑️ تم حذف المستند');
                load();
              }}, ['🗑️']) : null,
            ]),
          ]);
          docsGrid.appendChild(card);
        }
        container.appendChild(docsGrid);
      }

      // التاريخ
      container.appendChild(el('div', { style: 'font-size:16px;font-weight:700;margin:20px 0 10px' }, ['📜 سجل الحركات']));
      const historyBox = el('div', { style: 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;max-height:400px;overflow-y:auto' });
      container.appendChild(historyBox);
      loadHistory(historyBox);
    }

    function infoItem(label, value) {
      return el('div', {}, [
        el('div', { style: 'font-size:12px;color:var(--text-2);margin-bottom:2px' }, [label]),
        el('div', { style: 'font-size:14px;font-weight:600' }, [value || '—']),
      ]);
    }

    async function loadHistory(box) {
      try {
        const r = await api('/legal-files/' + id + '/history');
        box.innerHTML = '';
        if (!r.history || r.history.length === 0) {
          box.appendChild(el('div', { style: 'color:var(--text-2);text-align:center' }, ['لا يوجد سجل']));
          return;
        }
        for (const h of r.history) {
          let details = '';
          if (h.details) {
            try {
              const d = JSON.parse(h.details);
              if (h.action === 'EDITED' && typeof d === 'object') {
                details = Object.entries(d).map(([k, v]) => k + ': ' + (v.from || '—') + ' → ' + (v.to || '—')).join(' | ');
              } else if (h.action === 'DOCUMENT_ADDED' || h.action === 'DOCUMENT_REMOVED') {
                details = d.filename || '';
              } else if (d.from && d.to) {
                details = d.from + ' → ' + d.to;
              } else if (d.note) {
                details = d.note;
              }
            } catch (e) { details = h.details; }
          }
          box.appendChild(el('div', {
            style: 'padding:8px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:8px',
          }, [
            el('div', {}, [
              el('span', { style: 'font-weight:700;font-size:13px' }, [ACTION_AR[h.action] || h.action]),
              details ? el('span', { style: 'font-size:12px;color:var(--text-2);margin-right:8px' }, [' — ' + details]) : null,
              el('div', { style: 'font-size:11px;color:var(--text-2)' }, [h.performer_name || 'مستخدم #' + h.performed_by]),
            ]),
            el('span', { style: 'font-size:11px;color:var(--text-2);white-space:nowrap' }, [fmtDate(h.performed_at)]),
          ]));
        }
      } catch (e) { box.innerHTML = '<div style="color:var(--danger)">خطأ في تحميل السجل</div>'; }
    }

    // ────── نموذج التعديل ──────
    function showEditForm() {
      const f = fileData;
      const overlay = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px',
        onclick: (e) => { if (e.target === overlay) overlay.remove(); },
      });
      const fields = {};
      const fieldDefs = [
        ['fileNumber', 'رقم الملف', f.file_number],
        ['customerName', 'اسم العميل', f.customer_name],
        ['customerPhone', 'رقم هاتف العميل', f.customer_phone],
        ['guarantorName', 'اسم الضامن', f.guarantor_name || ''],
        ['guarantorPhone', 'رقم هاتف الضامن', f.guarantor_phone || ''],
        ['salesName', 'اسم السيلز', f.sales_name || ''],
        ['notes', 'ملاحظات', f.notes || ''],
      ];
      const formFields = fieldDefs.map(([key, label, val]) => {
        const input = el('input', { type: 'text', value: val, placeholder: label, style: 'width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)' });
        fields[key] = input;
        return el('div', { style: 'margin-bottom:10px' }, [
          el('label', { style: 'display:block;font-size:13px;font-weight:600;margin-bottom:4px;color:var(--text-2)' }, [label]),
          input,
        ]);
      });
      const errMsg = el('div', { style: 'color:var(--danger);font-size:13px;margin-top:8px;display:none' });
      overlay.appendChild(el('div', {
        style: 'background:var(--surface);border-radius:16px;padding:24px;max-width:500px;width:100%;max-height:90vh;overflow-y:auto',
      }, [
        el('div', { style: 'font-size:18px;font-weight:800;margin-bottom:16px' }, ['✏️ تعديل البيانات']),
        ...formFields,
        errMsg,
        el('div', { style: 'display:flex;gap:8px;margin-top:16px' }, [
          el('button', { class: 'btn btn-primary', onclick: async () => {
            const data = {};
            for (const [key] of fieldDefs) data[key] = fields[key].value.trim();
            try {
              await api('/legal-files/' + id, { method: 'PUT', body: JSON.stringify(data) });
              toast('✅ تم التعديل');
              overlay.remove();
              load();
            } catch (e) {
              errMsg.textContent = e.message || 'خطأ';
              errMsg.style.display = 'block';
            }
          }}, ['💾 حفظ']),
          el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, ['إلغاء']),
        ]),
      ]));
      document.body.appendChild(overlay);
    }

    // ────── نموذج رفع مستند ──────
    function showUploadForm() {
      const overlay = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px',
        onclick: (e) => { if (e.target === overlay) overlay.remove(); },
      });
      const fileInput = el('input', {
        type: 'file', multiple: true, accept: 'image/*,application/pdf',
        style: 'width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)',
      });
      const progressDiv = el('div', { style: 'margin-top:12px' });
      const errMsg = el('div', { style: 'color:var(--danger);font-size:13px;margin-top:8px;display:none' });

      overlay.appendChild(el('div', {
        style: 'background:var(--surface);border-radius:16px;padding:24px;max-width:500px;width:100%',
      }, [
        el('div', { style: 'font-size:18px;font-weight:800;margin-bottom:12px' }, ['📎 رفع مستندات']),
        el('div', { style: 'font-size:13px;color:var(--text-2);margin-bottom:12px' }, ['الحد الأقصى 20 مستند لكل ملف — صور أو PDF فقط — أقصى حجم 5 ميجا للمستند']),
        fileInput,
        progressDiv,
        errMsg,
        el('div', { style: 'display:flex;gap:8px;margin-top:16px' }, [
          el('button', { class: 'btn btn-primary', onclick: async () => {
            const files = fileInput.files;
            if (!files || files.length === 0) { errMsg.textContent = 'اختر ملفات للرفع'; errMsg.style.display = 'block'; return; }
            const remaining = 20 - docs.length;
            if (files.length > remaining) { errMsg.textContent = 'الحد الأقصى المتبقي: ' + remaining + ' مستند'; errMsg.style.display = 'block'; return; }
            progressDiv.innerHTML = '';
            let success = 0;
            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              const prog = el('div', { style: 'font-size:12px;padding:4px 0' }, ['⏳ جاري رفع ' + file.name + '…']);
              progressDiv.appendChild(prog);
              try {
                const base64 = await fileToBase64(file);
                await api('/legal-files/' + id + '/documents', {
                  method: 'POST',
                  body: JSON.stringify({ filename: file.name, contentType: file.type, data: base64 }),
                });
                prog.textContent = '✅ ' + file.name;
                prog.style.color = 'var(--success)';
                success++;
              } catch (e) {
                prog.textContent = '❌ ' + file.name + ' — ' + (e.message || 'خطأ');
                prog.style.color = 'var(--danger)';
              }
            }
            if (success > 0) {
              toast('✅ تم رفع ' + success + ' مستند');
              setTimeout(() => { overlay.remove(); load(); }, 800);
            }
          }}, ['📤 رفع']),
          el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, ['إلغاء']),
        ]),
      ]));
      document.body.appendChild(overlay);
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          // الـ result = "data:image/png;base64,AAAA..." — نقطع الـ prefix
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    await load();
    return container;
  });
})();
