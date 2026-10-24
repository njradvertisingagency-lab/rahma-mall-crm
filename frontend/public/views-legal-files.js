'use strict';
(function () {
  const { el, api, toast } = App;

  const ACTION_AR = {
    CREATED: 'Ø¥ÙØ´Ø§Ø¡ ÙÙÙ',
    EDITED: 'ØªØ¹Ø¯ÙÙ Ø¨ÙØ§ÙØ§Øª',
    DOCUMENT_ADDED: 'Ø±ÙØ¹ ÙØ³ØªÙØ¯',
    DOCUMENT_REMOVED: 'Ø­Ø°Ù ÙØ³ØªÙØ¯',
    MOVED_TO_LEGAL: 'ÙÙÙ ÙÙØ´Ø¦ÙÙ Ø§ÙÙØ§ÙÙÙÙØ©',
    MOVED_TO_HR: 'ÙÙÙ ÙÙ HR',
    ARCHIVED: 'Ø£Ø±Ø´ÙØ©',
    RESTORED: 'Ø§Ø³ØªØ¹Ø§Ø¯Ø© ÙÙ Ø§ÙØ£Ø±Ø´ÙÙ',
    TRANSFER_REQUESTED: 'Ø·ÙØ¨ ÙÙÙ',
    TRANSFER_APPROVED: 'ÙÙØ§ÙÙØ© Ø¹ÙÙ ÙÙÙ',
    TRANSFER_REJECTED: 'Ø±ÙØ¶ Ø·ÙØ¨ ÙÙÙ',
  };

  // ââââââ Helpers ââââââ
  function fmtDate(iso) {
    if (!iso) return 'â';
    const d = new Date(iso);
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ââââââ ÙÙÙÙ Ø±ÙØ¹ Ø§ÙÙÙÙØ§Øª Drag & Drop (ÙØ´ØªØ±Ù) ââââââ
  function createDropZone(maxFiles) {
    let selectedFiles = [];
    const previewGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-top:10px' });
    const countLabel = el('div', { style: 'font-size:12px;color:var(--text-2);margin-top:6px;text-align:center' });

    const hiddenInput = el('input', {
      type: 'file', multiple: true, accept: 'image/*,application/pdf',
      style: 'display:none',
      onchange: (e) => { addFiles(e.target.files); e.target.value = ''; },
    });

    const dropArea = el('div', {
      style: 'border:2px dashed var(--border);border-radius:12px;padding:28px 16px;text-align:center;cursor:pointer;transition:all .2s;background:var(--bg)',
      onclick: () => hiddenInput.click(),
    }, [
      el('div', { style: 'font-size:36px;margin-bottom:8px;opacity:.6' }, ['ð']),
      el('div', { style: 'font-size:14px;font-weight:600;color:var(--text)' }, ['Ø§Ø³Ø­Ø¨ Ø§ÙÙÙÙØ§Øª ÙÙØ§ Ø£Ù Ø§Ø¶ØºØ· ÙÙØ§Ø®ØªÙØ§Ø±']),
      el('div', { style: 'font-size:12px;color:var(--text-2);margin-top:4px' }, ['ØµÙØ± Ø¨Ø£Ù ØµÙØºØ© Ø£Ù PDF â Ø­Ø¯ Ø£ÙØµÙ ' + maxFiles + ' ÙÙÙ â Ø£ÙØµÙ Ø­Ø¬Ù 5 ÙÙØ¬Ø§ ÙÙÙÙÙ']),
      hiddenInput,
    ]);

    dropArea.addEventListener('dragover', (e) => {
      e.preventDefault(); e.stopPropagation();
      dropArea.style.borderColor = 'var(--primary)';
      dropArea.style.background = 'rgba(52,152,219,.08)';
    });
    dropArea.addEventListener('dragleave', (e) => {
      e.preventDefault(); e.stopPropagation();
      dropArea.style.borderColor = 'var(--border)';
      dropArea.style.background = 'var(--bg)';
    });
    dropArea.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      dropArea.style.borderColor = 'var(--border)';
      dropArea.style.background = 'var(--bg)';
      addFiles(e.dataTransfer.files);
    });

    function addFiles(fileList) {
      if (!fileList) return;
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        if (!f.type.startsWith('image/') && f.type !== 'application/pdf') { toast('â ï¸ ' + f.name + ' â ØµÙØºØ© ØºÙØ± ÙØ¯Ø¹ÙÙØ©'); continue; }
        if (f.size > 5 * 1024 * 1024) { toast('â ' + f.name + ' Ø£ÙØ¨Ø± ÙÙ 5 ÙÙØ¬Ø§'); continue; }
        if (selectedFiles.length >= maxFiles) { toast('â ï¸ Ø§ÙØ­Ø¯ Ø§ÙØ£ÙØµÙ ' + maxFiles + ' ÙÙÙ'); break; }
        if (selectedFiles.some(sf => sf.name === f.name && sf.size === f.size)) continue;
        selectedFiles.push(f);
      }
      renderPreviews();
    }

    function renderPreviews() {
      previewGrid.innerHTML = '';
      countLabel.textContent = selectedFiles.length > 0 ? ('ØªÙ Ø§Ø®ØªÙØ§Ø± ' + selectedFiles.length + ' ÙÙÙ') : '';
      selectedFiles.forEach((f, idx) => {
        const thumb = el('div', {
          style: 'position:relative;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;text-align:center;overflow:hidden',
        });
        const removeBtn = el('button', {
          style: 'position:absolute;top:2px;left:2px;background:var(--danger);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:20px;padding:0;z-index:1',
          onclick: (e) => { e.stopPropagation(); selectedFiles.splice(idx, 1); renderPreviews(); },
        }, ['â']);
        thumb.appendChild(removeBtn);

        if (f.type.startsWith('image/')) {
          const img = el('img', { style: 'width:100%;height:70px;object-fit:cover;border-radius:4px' });
          const url = URL.createObjectURL(f);
          img.src = url;
          img.onload = () => URL.revokeObjectURL(url);
          thumb.appendChild(img);
        } else {
          thumb.appendChild(el('div', { style: 'font-size:28px;padding:12px 0' }, ['ð']));
        }
        thumb.appendChild(el('div', { style: 'font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 4px' }, [f.name]));
        previewGrid.appendChild(thumb);
      });
    }

    const container = el('div', { style: 'margin-top:12px' }, [
      el('label', { style: 'display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text-2)' }, ['ð Ø§ÙÙØ³ØªÙØ¯Ø§Øª ÙØ§ÙØµÙØ±']),
      dropArea,
      countLabel,
      previewGrid,
    ]);

    return { container, getFiles: () => selectedFiles };
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ââââââ Ø§ÙØµÙØ­Ø© Ø§ÙØ±Ø¦ÙØ³ÙØ©: ÙØ§Ø¦ÙØ© Ø§ÙÙÙÙØ§Øª ââââââ
  App.route('/legal-files', async () => {
    const user = App.state.user;
    const container = el('div');

    let currentSection = null; // null = Ø§ÙÙÙ
    let currentStatus = 'ACTIVE';
    let searchQ = '';
    let page = 1;

    // ââ Ø§ÙØ¥Ø­ØµØ§Ø¦ÙØ§Øª ââ
    const statsRow = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px' });

    // ââ Ø§ÙØªØ¨ÙÙØ¨Ø§Øª ââ
    const tabsRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px' });

    // ââ Ø§ÙØ¨Ø­Ø« ââ
    const searchInput = el('input', {
      type: 'text', placeholder: 'Ø§Ø¨Ø­Ø« Ø¨Ø±ÙÙ Ø§ÙÙÙÙ Ø£Ù Ø§Ø³Ù Ø§ÙØ¹ÙÙÙ Ø£Ù Ø§ÙÙØ§ØªÙâ¦',
      style: 'width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)',
      onkeydown: (e) => { if (e.key === 'Enter') { searchQ = e.target.value.trim(); page = 1; loadFiles(); } },
    });

    // ââ Ø·ÙØ¨Ø§Øª Ø§ÙÙÙÙ Ø§ÙÙØ§Ø±Ø¯Ø© ââ
    const transfersSection = el('div');

    // ââ ÙØ§Ø¦ÙØ© Ø§ÙÙÙÙØ§Øª ââ
    const filesList = el('div');
    const pagination = el('div', { style: 'display:flex;justify-content:center;gap:8px;margin-top:16px' });

    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['âï¸ Ø§ÙÙÙÙØ§Øª Ø§ÙÙØ§ÙÙÙÙØ©']),
      el('div', { class: 'page-actions', style: 'display:flex;gap:8px' }, [
        el('button', { class: 'btn btn-outline', onclick: () => loadAll() }, ['ð ØªØ­Ø¯ÙØ«']),
        el('button', { class: 'btn btn-primary', onclick: () => showCreateForm() }, ['â ÙÙÙ Ø¬Ø¯ÙØ¯']),
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
          ['ð HR', r.hrFiles, '#3498db'],
          ['âï¸ ÙØ§ÙÙÙÙØ©', r.legalFiles, '#8e44ad'],
          ['ðï¸ Ø£Ø±Ø´ÙÙ', r.archivedFiles, '#95a5a6'],
          ['ð© Ø·ÙØ¨Ø§Øª ÙØ§Ø±Ø¯Ø©', r.pendingIncoming, '#e67e22'],
          ['ð¤ Ø·ÙØ¨Ø§Øª ØµØ§Ø¯Ø±Ø©', r.pendingOutgoing, '#27ae60'],
        ];
        for (const [label, count, color] of cards) {
          statsRow.appendChild(el('div', {
            style: `background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;border-top:3px solid ${color}`,
          }, [
            el('div', { style: 'font-size:28px;font-weight:800;color:' + color }, [String(count)]),
            el('div', { style: 'font-size:13px;color:var(--text-2);margin-top:4px' }, [label]),
          ])));
        }
      } catch (e) { console.error(e); }
    }

    function renderTabs() {
      tabsRow.innerHTML = '';
      const tabs = [
        [null, 'Ø§ÙÙÙ'],
        ['HR', 'ð ÙÙÙØ§Øª HR'],
        ['LEGAL', 'âû¯ ÙÙÙØ§Øª Ø§ÙÙØ§ÙÙÙÙØ©'],
      ];
      for (const [sec, label] of tabs) {
        tabsRow.appendChild(el('button', {
          class: 'btn ' + (currentSection === sec ? 'btn-primary' : 'btn-outline'),
          style: 'font-size:13px',
          onclick: () => { currentSection = sec; page = 1; loadFiles(); renderTabs(); },
        }, [label]));
      }
      // Ø£Ø±Ø´ÙÙ
      tabsRow.appendChild(el('button', {
        class: 'btn ' + (currentStatus === 'ARCHIVED' ? 'btn-primary' : 'btn-outline'),
        style: 'font-size:13px',
        onclick: () => {
          currentStatus = currentStatus === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED';
          page = 1; loadFiles(); renderTabs();
        },
      }, ['ðï¸ Ø§ÙØ£Ø±Ø´ÙÙ']));
    }

    async function loadTransfers() {
      try {
        const r = await api('/legal-files/transfers/pending');
        transfersSection.innerHTML = '';
        if (!r.transfers || r.transfers.length === 0) return;
        const heading = el('div', { style: 'font-weight:700;font-size:15px;margin-bottom:8px;color:var(--warning)' }, ['ð© Ø·ÙØ¨ ÙÙÙ ÙØ§Ø±Ø¯Ø© (' + r.transfers.length + ')']);
        transfersSection.appendChild(heading);
        for (const t of r.transfers) {
          const card = el('div', {
            style: 'background:var(--surface);border:1px solid var(--warning);border-radius:10px;padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px',
          }, [
            el('div', {}, [
              el('span', { style: 'font-weight:700' }, ['ÙÙÙ #' + t.file_number]),
              ' â ', t.customer_name,
              el('span', { style: 'color:var(--text-2);font-size:12px;margin-right:8px' }, [' ÙÙ ' + t.from_section + ' â ' + t.to_section]),
              t.note ? el('div', { style: 'font-size:12px;color:var(--text-2)' }, ['ð¬ ' + t.note]) : null,
            ]),
            el('div', { style: 'display:flex;gap:6px' }, [
              el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { await api('/legal-files/transfers/' + t.id, { method: 'PATCH', body: JSON.stringify({ decision: 'APPROVED' }) }); toast('â ØªÙØª Ø§ÙÙÙØ§ÙÙØ©'); loadAll(); } }, ['â ÙÙØ§ÙÙØ©']),
              el('button', { class: 'btn btn-outline btn-sm', onclick: async () => { await api('/legal-files/transfers/' + t.id, { method: 'PATCH', body: JSON.stringify({ decision: 'REJECTED' }) }); toast('â ØªÙ Ø§ÙØ±ÙØ¶'); loadAll(); } }, ['â Ø±ÙØ¶']),
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
          filesList.appendChild(el('div', { style: 'text-align:center;padding:40px;color:var(--text-2)' }, ['ÙØ§ ØªÙØ¬Ø¯ ÙÙÙØ§Øª']));
          pagination.innerHTML = '';
          return;
        }
        for (const f of r.files) {
          const sectionBadge = f.current_section === 'LEGAL'
            ? el('span', { style: 'background:#8e44ad;color:#fff;padding:2px 8px;border-radius:6px;font-size:11px' }, ['âï¸ ÙØ§ÙÙÙÙØ©'])
            : el('span', { style: 'background:#3498db;color:#fff;padding:2px 8px;border-radius:6px;font-size:11px' }, ['ð HR']);
          const statusBadge = f.status === 'ARCHIVED'
            ? el('span', { style: 'background:#95a5a6;color:#fff;padding:2px 8px;border-radius:6px;font-size:11px;margin-right:4px' }, ['ðï¸ Ø£Ø±Ø´ÙÙ'])
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
              el('div', {}, ['ð¤ ', el('strong', {}, [f.customer_name])]),
              el('div', {}, ['ð± ', f.customer_phone]),
              f.guarantor_name ? el('div', {}, ['ð¤ ', f.guarantor_name]) : null,
              f.sales_name ? el('div', {}, ['ð·ï¸ ', f.sales_name]) : null,
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
        filesList.appendChild(el('div', { style: 'color:var(--danger);padding:20px' }, ['â Ø®Ø·Ø£ ÙÙ ØªØ­ÙÙÙ Ø§ÙÙÙÙØ§Øª']));
      }
    }

    function loadAll() { loadStats(); loadTransfers(); loadFiles(); renderTabs(); }

    // ââââââ ÙÙÙØ°Ø¬ Ø¥ÙØ´Ø§Ø¡ ÙÙÙ Ø¬Ø¯ÙØ¯ ââââââ
    function showCreateForm() {
      const overlay = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px',
        onclick: (e) => { if (e.target === overlay) overlay.remove(); },
      });
      const fields = {};
      const fieldDefs = [
        ['fileNumber', 'Ø±ÙÙ Ø§ÙÙÙÙ *', 'text'],
        ['customerName', 'Ø§Ø³Ù Ø§ÙØ¹ÙÙÙ *', 'text'],
        ['customerPhone', 'Ø±ÙÙ ÙØ§ØªÙ Ø§ÙØ¹ÙÙÙ *', 'tel'],
        ['guarantorName', 'Ø§Ø³Ù Ø§ÙØ¶Ø§ÙÙ', 'text'],
        ['guarantorPhone', 'Ø±ÙÙ ÙØ§ØªÙ Ø§ÙØ¶Ø§ÙÙ', 'tel'],
        ['salesName', 'Ø§Ø³Ù Ø§ÙØ³ÙÙØ²', 'text'],
        ['notes', 'ÙÙØ§Ø­Ø¸Ø§Øª', 'text'],
      ];
      const formFields = fieldDefs.map(([key, label, type]) => {
        const input = el('input', { type, placeholder: label, style: 'width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)' });
        fields[key] = input;
        return el('div', { style: 'margin-bottom:10px' }, [
          el('label', { style: 'display:block;font-size:13px;font-weight:600;margin-bottom:4px;color:var(--text-2)' }, [label]),
          input,
        ]);
      });

      // ÙÙØ·ÙØ© Ø±ÙØ¹ Ø§ÙÙÙÙØ§Øª
      const dropZone = createDropZone(20);

      const errMsg = el('div', { style: 'color:var(--danger);font-size:13px;margin-top:8px;display:none' });
      const progressDiv = el('div', { style: 'margin-top:8px' });
      const form = el('div', {
        style: 'background:var(--surface);border-radius:16px;padding:24px;max-width:540px;width:100%;max-height:90vh;overflow-y:auto',
      }, [
        el('div', { style: 'font-size:18px;font-weight:800;margin-bottom:16px' }, ['â ÙÙÙ Ø¬Ø¯ÙØ¯']),
        ...formFields,
        dropZone.container,
        errMsg,
        progressDiv,
        el('div', { style: 'display:flex;gap:8px;margin-top:16px' }, [
          el('button', { class: 'btn btn-primary', onclick: async () => {
            const data = {};
            for (const [key] of fieldDefs) data[key] = fields[key].value.trim();
            if (!data.fileNumber || !data.customerName || !data.customerPhone) {
              errMsg.textContent = 'Ø±ÙÙ Ø§ÙÙÙÙ ÙØ§Ø³Ù Ø§ÙØ¹ÙÙÙ ÙØ±ÙÙ Ø§ÙÙØ§ØªÙ ÙØ·ÙÙØ¨ÙÙ';
              errMsg.style.display = 'block';
              return;
            }
            try {
              errMsg.style.display = 'none';
              const r = await api('/legal-files', { method: 'POST', body: JSON.stringify(data) });
              const fileId = r.id;
              // Ø±ÙØ¹ Ø§ÙÙØ³ØªÙØ¯Ø§Øª Ø§ÙÙØ±ÙÙØ©
              const pendingFiles = dropZone.getFiles();
              if (pendingFiles.length > 0) {
                progressDiv.innerHTML = '';
                let success = 0;
                for (let i = 0; i < pendingFiles.length; i++) {
                  const file = pendingFiles[i];
                  const prog = el('div', { style: 'font-size:12px;padding:3px 0' }, ['â³ Ø±ÙØ¹ ' + file.name + 'â¦']);
                  progressDiv.appendChild(prog);
                  try {
                    const base64 = await fileToBase64(file);
                    await api('/legal-files/' + fileId + '/documents', {
                      method: 'POST',
                      body: JSON.stringify({ filename: file.name, contentType: file.type, data: base64 }),
                    });
                    prog.textContent = 'â ' + file.name;
                    prog.style.color = 'var(--success)';
                    success++;
                  } catch (e) {
                    prog.textContent = 'â ' + file.name + ' â ' + (e.message || 'Ø®Ø·Ø£');
                    prog.style.color = 'var(--danger)';
                  }
                }
                toast('â ØªÙ Ø¥ÙØ´Ø§Ø¡ Ø§ÙÙÙÙ #' + r.fileNumber + ' ÙØ¹ ' + success + ' ÙØ³ØªÙØ¯');
              } else {
                toast('â ØªÙ Ø¥ÙØ´Ø§Ø¡ Ø§ÙÙÙÙ #' + r.fileNumber);
              }
              setTimeout(() => { overlay.remove(); loadAll(); }, 500);
            } catch (e) {
              errMsg.textContent = e.message || 'Ø®Ø·Ø£ ÙÙ Ø¥ÙØ´Ø§Ø¡ Ø§ÙÙÙÙ';
              errMsg.style.display = 'block';
            }
          }}, ['ð¾ Ø­ÙØ¸']),
          el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, ['Ø¥ÙØºØ§Ø¡']),
        ]),
      ]);
      overlay.appendChild(form);
      document.body.appendChild(overlay);
      fields.fileNumber.focus();
    }

    loadAll();
    return container;
  });

  // ââââââ ØµÙØ­Ø© ØªÙØ§ØµÙÙ Ø§ÙÙÙÙ ââââââ
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
        container.appendChild(el('div', { style: 'color:var(--danger);padding:40px;text-align:center' }, ['â ' + (e.message || 'Ø®Ø·Ø£')]));
      }
    }

    function render() {
      container.innerHTML = '';
      if (!fileData) return;
      const f = fileData;

      // Ø§ÙØ¹ÙÙØ§Ù
      container.appendChild(el('div', { class: 'page-header' }, [
        el('div', { style: 'display:flex;align-items:center;gap:12px' }, [
          el('button', { class: 'btn btn-outline btn-sm', onclick: () => App.navigate('#/legal-files') }, ['â Ø±Ø¬ÙØ¹']),
          el('div', { class: 'page-title' }, ['ÙÙÙ #' + f.file_number]),
          f.current_section === 'LEGAL'
            ? el('span', { style: 'background:#8e44ad;color:#fff;padding:3px 10px;border-radius:8px;font-size:12px' }, ['âï¸ ÙØ§ÙÙÙÙØ©'])
            : el('span', { style: 'background:#3498db;color:#fff;padding:3px 10px;border-radius:8px;font-size:12px' }, ['ð HR']),
          f.status === 'ARCHIVED'
            ? el('span', { style: 'background:#95a5a6;color:#fff;padding:3px 10px;border-radius:8px;font-size:12px' }, ['ðï¸ Ø£Ø±Ø´ÙÙ'])
            : null,
        ]),
      ]));

      // Ø£Ø²Ø±Ø§Ø± Ø§ÙØ¥Ø¬Ø±Ø§Ø¡Ø§Øª
      const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px' });
      if (f.status === 'ACTIVE') {
        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', onclick: () => showEditForm() }, ['âï¸ ØªØ¹Ø¯ÙÙ Ø§ÙØ¨ÙØ§ÙØ§Øª']));
        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', onclick: () => showUploadForm() }, ['ð Ø±ÙØ¹ ÙØ³ØªÙØ¯']));

        const targetSection = f.current_section === 'HR' ? 'LEGAL' : 'HR';
        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', style: 'border-color:#8e44ad;color:#8e44ad', onclick: async () => {
          if (!confirm('ÙÙÙ Ø§ÙÙÙÙ Ø¥ÙÙ ÙØ³Ù ' + (targetSection === 'LEGAL' ? 'Ø§ÙØ´Ø¦ÙÙ Ø§ÙÙØ§ÙÙÙÙØ©' : 'HR') + '?')) return;
          await api('/legal-files/' + id + '/move', { method: 'PATCH', body: JSON.stringify({ toSection: targetSection }) });
          toast('â ØªÙ Ø§ÙÙÙÙ');
          load();
        }}, ['ð ÙÙÙ Ø¥ÙÙ ' + (targetSection === 'LEGAL' ? 'Ø§ÙÙØ§ÙÙÙÙØ©' : 'HR')]));

        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', style: 'border-color:#e67e22;color:#e67e22', onclick: async () => {
          const note = prompt('Ø³Ø¨Ø¨ Ø·ÙØ¨ Ø§ÙÙÙÙ (Ø§Ø®ØªÙØ§Ø±Ù):');
          if (note === null) return;
          try {
            await api('/legal-files/' + id + '/transfer-request', { method: 'POST', body: JSON.stringify({ note: note || '' }) });
            toast('â ØªÙ Ø¥Ø±Ø³Ø§Ù Ø·ÙØ¨ Ø§ÙÙÙÙ');
          } catch (e) { toast('â ' + (e.message || 'Ø®Ø·Ø£')); }
        }}, ['ð© Ø·ÙØ¨ ÙÙÙ']));

        actions.appendChild(el('button', { class: 'btn btn-outline btn-sm', style: 'border-color:var(--danger);color:var(--danger)', onclick: async () => {
          if (!confirm('Ø£Ø±Ø´ÙØ© Ø§ÙÙÙÙØ ÙÙ ÙØ¸ÙØ± ÙÙ Ø§ÙÙØ§Ø¦ÙØ© Ø§ÙØ±Ø¦ÙØ³ÙØ©.')) return;
          await api('/legal-files/' + id + '/archive', { method: 'PATCH' });
          toast('ðï¸ ØªÙ Ø§ÙØ£Ø±Ø´ÙØ©');
          load();
        }}, ['ðï¸ Ø£Ø±Ø´ÙØ©']));
      } else {
        actions.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
          await api('/legal-files/' + id + '/restore', { method: 'PATCH' });
          toast('â ØªÙØª Ø§ÙØ§Ø³ØªØ¹Ø§Ø¯Ø©');
          load();
        }}, ['â»ï¸ Ø§Ø³ØªØ¹Ø§Ø¯Ø© ÙÙ Ø§ÙØ£Ø±Ø´ÙÙ']));
      }
      container.appendChild(actions);

      // Ø¨ÙØ§ÙØ§Øª Ø§ÙÙÙÙ
      const infoGrid = el('div', {
        style: 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px',
      }, [
        infoItem('ð¤ Ø§Ø³Ù Ø§ÙØ¹ÙÙÙ', f.customer_name),
        infoItem('ð± ÙØ§ØªÙ Ø§ÙØ¹ÙÙÙ', f.customer_phone),
        infoItem('ð¤ Ø§Ø³Ù Ø§ÙØ¶Ø§ÙÙ', f.guarantor_name || 'â'),
        infoItem('ð± ÙØ§ØªÙ Ø§ÙØ¶Ø§ÙÙ', f.guarantor_phone || 'â'),
        infoItem('ð·ï¸ Ø§Ø³Ù Ø§ÙØ³ÙÙØ²', f.sales_name || 'â'),
        infoItem('ð ØªØ§Ø±ÙØ® Ø§ÙØ¥ÙØ´Ø§Ø¡', fmtDate(f.created_at)),
        f.notes ? infoItem('ð ÙÙØ§Ø­Ø¸Ø§Øª', f.notes) : null,
      ]);
      container.appendChild(infoGrid);

      // Ø§ÙÙØ³ØªÙØ¯Ø§Øª
      container.appendChild(el('div', { style: 'font-size:16px;font-weight:700;margin-bottom:10px' }, ['ð Ø§ÙÙØ³ØªÙØ¯Ø§Øª (' + docs.length + '/20)']));
      if (docs.length === 0) {
        container.appendChild(el('div', { style: 'color:var(--text-2);padding:20px;text-align:center;background:var(--surface);border-radius:10px;border:1px dashed var(--border)' }, ['ÙØ§ ØªÙØ¬Ø¯ ÙØ³ØªÙØ¯Ø§Øª ÙØ±ÙÙØ©']));
      } else {
        const docsGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:20px' });
        for (const doc of docs) {
          const isImg = doc.content_type.startsWith('image/');
          const card = el('div', {
            style: 'background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center;position:relative',
          }, [
            el('div', { style: 'font-size:32px;margin-bottom:6px' }, [isImg ? 'ð¼ï¸' : 'ð']),
            el('div', { style: 'font-size:12px;font-weight:600;word-break:break-all' }, [doc.filename]),
            el('div', { style: 'font-size:11px;color:var(--text-2)' }, [fmtSize(doc.file_size)]),
            el('div', { style: 'display:flex;gap:4px;justify-content:center;margin-top:8px' }, [
              el('button', { class: 'btn btn-outline btn-sm', style: 'font-size:11px', onclick: async (e) => {
                e.stopPropagation();
                try {
                  const r = await api('/legal-files/' + id + '/documents/' + doc.id);
                  const d = r.document;
                  // ÙØªØ­ ÙÙ ØªØ¨ÙÙØ¨ Ø¬Ø¯ÙØ¯
                  const w = window.open('', '_blank');
                  if (isImg) {
                    w.document.write('<html><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111"><img src="data:' + d.content_type + ';base64,' + d.data + '" style="max-width:100%;max-height:100vh" /></body></html>');
                  } else {
                    w.document.write('<html><body style="margin:0"><embed src="data:' + d.content_type + ';base64,' + d.data + '" type="' + d.content_type + '" width="100%" height="100%" style="position:fixed;inset:0" /></body></html>');
                  }
                } catch (e) { toast('â Ø®Ø·Ø£ ÙÙ ØªØ­ÙÙÙ Ø§ÙÙØ³ØªÙØ¯'); }
              }}, ['ðï¸ Ø¹Ø±Ø¶']),
              f.status === 'ACTIVE' ? el('button', { class: 'btn btn-outline btn-sm', style: 'font-size:11px;color:var(--danger);border-color:var(--danger)', onclick: async (e) => {
                e.stopPropagation();
                if (!confirm('Ø­Ø°Ù Ø§ÙÙØ³ØªÙØ¯ "' + doc.filename + '"?')) return;
                await api('/legal-files/' + id + '/documents/' + doc.id, { method: 'DELETE' });
                toast('ðï¸ ØªÙ Ø­Ø°Ù Ø§ÙÙØ³ØªÙØ¯');
                load();
              }}, ['ðï¸']) : null,
            ]),
          ]);
          docsGrid.appendChild(card);
        }
        container.appendChild(docsGrid);
      }

      // Ø§ÙØªØ§Ø±ÙØ®
      container.appendChild(el('div', { style: 'font-size:16px;font-weight:700;margin:20px 0 10px' }, ['ð Ø³Ø¬Ù Ø§ÙØ­Ø±ÙØ§Øª']));
      const historyBox = el('div', { style: 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;max-height:400px;overflow-y:auto' });
      container.appendChild(historyBox);
      loadHistory(historyBox);
    }

    function infoItem(label, value) {
      return el('div', {}, [
        el('div', { style: 'font-size:12px;color:var(--text-2);margin-bottom:2px' }, [label]),
        el('div', { style: 'font-size:14px;font-weight:600' }, [value || 'â']),
      ]);
    }

    async function loadHistory(box) {
      try {
        const r = await api('/legal-files/' + id + '/history');
        box.innerHTML = '';
        if (!r.history || r.history.length === 0) {
          box.appendChild(el('div', { style: 'color:var(--text-2);text-align:center' }, ['ÙØ§ ÙÙØ¬Ø¯ Ø³Ø¬Ù']));
          return;
        }
        for (const h of r.history) {
          let details = '';
          if (h.details) {
            try {
              const d = JSON.parse(h.details);
              if (h.action === 'EDITED' && typeof d === 'object') {
                details = Object.entries(d).map(([k, v]) => k + ': ' + (v.from || 'â') + ' â ' + (v.to || 'â')).join(' | ');
              } else if (h.action === 'DOCUMENT_ADDED' || h.action === 'DOCUMENT_REMOVED') {
                details = d.filename || '';
              } else if (d.from && d.to) {
                details = d.from + ' â ' + d.to;
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
              details ? el('span', { style: 'font-size:12px;color:var(--text-2);margin-right:8px' }, [' â ' + details]) : null,
              el('div', { style: 'font-size:11px;color:var(--text-2)' }, [h.performer_name || 'ÙØ³ØªØ®Ø¯Ù #' + h.performed_by]),
            ]),
            el('span', { style: 'font-size:11px;color:var(--text-2);white-space:nowrap' }, [fmtDate(h.performed_at)]),
          ]));
        }
      } catch (e) { box.innerHTML = '<div style="color:var(--danger)">Ø®Ø·Ø£ ÙÙ ØªØ­ÙÙÙ Ø§ÙØ³Ø¬Ù</div>'; }
    }

    // ââââââ ÙÙÙØ°Ø¬ Ø§ÙØªØ¹Ø¯ÙÙ ââââââ
    function showEditForm() {
      const f = fileData;
      const overlay = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px',
        onclick: (e) => { if (e.target === overlay) overlay.remove(); },
      });
      const fields = {};
      const fieldDefs = [
        ['fileNumber', 'Ø±ÙÙ Ø§ÙÙÙÙ', f.file_number],
        ['customerName', 'Ø§Ø³Ù Ø§ÙØ¹ÙÙÙ', f.customer_name],
        ['customerPhone', 'Ø±ÙÙ ÙØ§ØªÙ Ø§ÙØ¹ÙÙÙ', f.customer_phone],
        ['guarantorName', 'Ø§Ø³Ù Ø§ÙØ¶Ø§ÙÙ', f.guarantor_name || ''],
        ['guarantorPhone', 'Ø±ÙÙ ÙØ§ØªÙ Ø§ÙØ¶Ø§ÙÙ', f.guarantor_phone || ''],
        ['salesName', 'Ø§Ø³Ù Ø§ÙØ³ÙÙØ²', f.sales_name || ''],
        ['notes', 'ÙÙØ§Ø­Ø¸Ø§Øª', f.notes || ''],
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
        el('div', { style: 'font-size:18px;font-weight:800;margin-bottom:16px' }, ['âï¸ ØªØ¹Ø¯ÙÙ Ø§ÙØ¨ÙØ§ÙØ§Øª']),
        ...formFields,
        errMsg,
        el('div', { style: 'display:flex;gap:8px;margin-top:16px' }, [
          el('button', { class: 'btn btn-primary', onclick: async () => {
            const data = {};
            for (const [key] of fieldDefs) data[key] = fields[key].value.trim();
            try {
              await api('/legal-files/' + id, { method: 'PUT', body: JSON.stringify(data) });
              toast('â ØªÙ Ø§ÙØªØ¹Ø¯ÙÙ');
              overlay.remove();
              load();
            } catch (e) {
              errMsg.textContent = e.message || 'Ø®Ø·Ø£';
              errMsg.style.display = 'block';
            }
          }}, ['ð¾ Ø­ÙØ¸']),
          el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, ['Ø¥ÙØºØ§Ø¡']),
        ]),
      ]));
      document.body.appendChild(overlay);
    }

    // ââââââ ÙÙÙØ°Ø¬ Ø±ÙØ¹ ÙØ³ØªÙØ¯ ââââââ
    function showUploadForm() {
      const remaining = 20 - docs.length;
      const overlay = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px',
        onclick: (e) => { if (e.target === overlay) overlay.remove(); },
      });
      const dropZone = createDropZone(remaining);
      const progressDiv = el('div', { style: 'margin-top:12px' });
      const errMsg = el('div', { style: 'color:var(--danger);font-size:13px;margin-top:8px;display:none' });

      overlay.appendChild(el('div', {
        style: 'background:var(--surface);border-radius:16px;padding:24px;max-width:540px;width:100%;max-height:90vh;overflow-y:auto',
      }, [
        el('div', { style: 'font-size:18px;font-weight:800;margin-bottom:12px' }, ['ð Ø±ÙØ¹ ÙØ³ØªÙØ¯Ø§Øª']),
        dropZone.container,
        progressDiv,
        errMsg,
        el('div', { style: 'display:flex;gap:8px;margin-top:16px' }, [
          el('button', { class: 'btn btn-primary', onclick: async () => {
            const files = dropZone.getFiles();
            if (files.length === 0) { errMsg.textContent = 'Ø§Ø®ØªØ± ÙÙÙØ§Øª ÙÙØ±ÙØ¹'; errMsg.style.display = 'block'; return; }
            progressDiv.innerHTML = '';
            errMsg.style.display = 'none';
            let success = 0;
            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              const prog = el('div', { style: 'font-size:12px;padding:3px 0' }, ['â³ Ø±ÙØ¹ ' + file.name + 'â¦']);
              progressDiv.appendChild(prog);
              try {
                const base64 = await fileToBase64(file);
                await api('/legal-files/' + id + '/documents', {
                  method: 'POST',
                  body: JSON.stringify({ filename: file.name, contentType: file.type, data: base64 }),
                });
                prog.textContent = 'â ' + file.name;
                prog.style.color = 'var(--success)';
                success++;
              } catch (e) {
                prog.textContent = 'â ' + file.name + ' â ' + (e.message || 'Ø®Ø·Ø£');
                prog.style.color = 'var(--danger)';
              }
            }
            if (success > 0) {
              toast('â ØªÙ Ø±ÙØ¹ ' + success + ' ÙØ³ØªÙØ¯');
              setTimeout(() => { overlay.remove(); load(); }, 800);
            }
          }}, ['ð¤ Ø±ÙØ¹']),
          el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, ['Ø¥ÙØºØ§Ø¡']),
        ]),
      ]));
      document.body.appendChild(overlay);
    }

    await load();
    return container;
  });
})();
