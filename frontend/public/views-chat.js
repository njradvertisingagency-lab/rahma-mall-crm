'use strict';
(function () {
  const { el, api, toast, fmt } = App;

  function messageBubble(m, isMine) {
    return el('div', { class: 'mb-12', style: isMine ? 'text-align:end' : '' }, [
      el('div', {
        style: `display:inline-block;padding:8px 12px;border-radius:10px;max-width:80%;font-size:13.5px;background:${isMine ? 'var(--brand)' : 'var(--surface-2)'};color:${isMine ? 'var(--brand-foreground)' : 'var(--text)'}`,
      }, [m.message]),
      el('div', { class: 'faint', style: `margin-top:2px;${isMine ? 'text-align:end' : ''}` }, [`${m.senderRole === 'team_leader' ? 'قائد الفريق' : m.senderName} — ${fmt.ago(m.createdAt)}`]),
    ]);
  }

  function renderThread(employeeId, container) {
    const chatBox = el('div', { class: 'card card-pad', style: 'min-height:320px;max-height:480px;overflow-y:auto;margin-bottom:14px' });
    const input = el('textarea', { placeholder: 'اكتب رسالة…', style: 'min-height:44px' });
    const sendBtn = el('button', { class: 'btn btn-primary', onclick: send }, ['إرسال']);
    container.appendChild(chatBox);
    container.appendChild(el('div', { class: 'flex gap-8 wrap', style: 'align-items:flex-start' }, [input, sendBtn]));

    async function load() {
      try {
        const { messages } = await api('/chat/' + employeeId + '/messages');
        chatBox.innerHTML = '';
        if (messages.length === 0) {
          chatBox.appendChild(el('div', { class: 'muted' }, ['لا توجد رسائل بعد — ابدأ المحادثة.']));
        } else {
          messages.forEach((m) => chatBox.appendChild(messageBubble(m, m.senderRole === App.state.user.role)));
        }
        chatBox.scrollTop = chatBox.scrollHeight;
        App.refreshChatUnread();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function send() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await api('/chat/' + employeeId + '/messages', { method: 'POST', body: { message: text } });
        await load();
      } catch (e) { toast(e.message, 'error'); }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    load();
    const off = App.on('rt:CHAT_MESSAGE', (p) => { if (Number(p.employeeId) === Number(employeeId)) load(); });
    return { cleanup: off };
  }

  App.route('/chat', async () => {
    const user = App.state.user;
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['💬 الدردشة'])]));

    if (user.role === 'employee') {
      container.appendChild(el('div', { class: 'muted mb-12' }, ['محادثة مباشرة مع قائد الفريق.']));
      const threadWrap = el('div');
      container.appendChild(threadWrap);
      const { cleanup } = renderThread(user.employeeId, threadWrap);
      container.cleanup = cleanup;
      return container;
    }

    // Team Leader: a thread list + selected employee's conversation.
    const grid = el('div', { style: 'display:grid;grid-template-columns:280px 1fr;gap:16px' });
    if (window.innerWidth < 880) grid.style.gridTemplateColumns = '1fr';
    const listBox = el('div', { class: 'card card-pad', style: 'max-height:560px;overflow-y:auto' });
    const threadArea = el('div');
    grid.appendChild(listBox);
    grid.appendChild(threadArea);
    container.appendChild(grid);

    let currentCleanup = null;
    let selectedId = null;

    async function loadThreads() {
      const { threads } = await api('/chat/threads');
      listBox.innerHTML = '';
      if (threads.length === 0) { listBox.appendChild(el('div', { class: 'muted' }, ['لا يوجد موظفون نشطون.'])); return; }
      threads.forEach((t) => {
        const row = el('div', {
          class: 'checklist-item', style: `cursor:pointer;${selectedId === t.employeeId ? 'background:var(--brand-soft)' : ''}`,
          onclick: () => selectThread(t.employeeId, t.employeeName),
        }, [
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { class: 'flex-between' }, [el('span', { style: 'font-weight:700' }, [t.employeeName]), t.unreadCount > 0 ? el('span', { class: 'badge badge-overdue' }, [String(t.unreadCount)]) : null]),
            el('div', { class: 'faint', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, [t.lastMessage || 'لا توجد رسائل بعد']),
          ]),
        ]);
        listBox.appendChild(row);
      });
    }
    function selectThread(employeeId, name) {
      selectedId = employeeId;
      if (currentCleanup) currentCleanup();
      threadArea.innerHTML = '';
      threadArea.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, [name]));
      const { cleanup } = renderThread(employeeId, threadArea);
      currentCleanup = cleanup;
      loadThreads();
    }
    await loadThreads();
    threadArea.appendChild(el('div', { class: 'empty-state' }, ['اختر موظفًا من القائمة لبدء أو متابعة المحادثة.']));
    const off = App.on('rt:CHAT_MESSAGE', loadThreads);
    container.cleanup = () => { off(); if (currentCleanup) currentCleanup(); };
    return container;
  }, { denyIfPlainSalesLead: true });
})();
