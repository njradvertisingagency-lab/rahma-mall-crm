'use strict';
(function () {
  const { el, api, toast, fmt } = App;

  // اسم العرض لأي طرف في محادثة — نفس الحقول اللي بيرجعها الـ backend (name،
  // role، isOwner، isHr) لأي جهة اتصال، سواء في قائمة المحادثات أو الإشراف.
  function contactLabel(contact) {
    if (!contact) return '—';
    if (contact.isOwner) return `${contact.name} (المالك)`;
    if (contact.isHr) return `${contact.name} (HR)`;
    if (contact.role === 'team_leader') return `${contact.name} (قائد الفريق)`;
    return contact.name;
  }

  function messageBubble(m, isMine, otherName) {
    return el('div', { class: 'mb-12', style: isMine ? 'text-align:end' : '' }, [
      el('div', {
        style: `display:inline-block;padding:8px 12px;border-radius:10px;max-width:80%;font-size:13.5px;background:${isMine ? 'var(--brand)' : 'var(--surface-2)'};color:${isMine ? 'var(--brand-foreground)' : 'var(--text)'}`,
      }, [m.message]),
      el('div', { class: 'faint', style: `margin-top:2px;${isMine ? 'text-align:end' : ''}` }, [`${isMine ? 'أنت' : (otherName || '')} — ${fmt.ago(m.createdAt)}`]),
    ]);
  }

  // محادثة شخصية عادية (المستخدم الحالي طرف فيها) — بها صندوق إرسال.
  function renderThread(otherUserId, otherName, container) {
    const chatBox = el('div', { class: 'card card-pad', style: 'min-height:320px;max-height:480px;overflow-y:auto;margin-bottom:14px' });
    const input = el('textarea', { placeholder: 'اكتب رسالة…', style: 'min-height:44px' });
    const sendBtn = el('button', { class: 'btn btn-primary', onclick: send }, ['إرسال']);
    container.appendChild(chatBox);
    container.appendChild(el('div', { class: 'flex gap-8 wrap', style: 'align-items:flex-start' }, [input, sendBtn]));

    async function load() {
      try {
        const { messages } = await api('/chat/' + otherUserId + '/messages');
        chatBox.innerHTML = '';
        if (messages.length === 0) {
          chatBox.appendChild(el('div', { class: 'muted' }, ['لا توجد رسائل بعد — ابدأ المحادثة.']));
        } else {
          messages.forEach((m) => chatBox.appendChild(messageBubble(m, m.mine, otherName)));
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
        await api('/chat/' + otherUserId + '/messages', { method: 'POST', body: { message: text } });
        await load();
      } catch (e) { toast(e.message, 'error'); }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    load();
    const off = App.on('rt:CHAT_MESSAGE', (p) => { if (Number(p.senderId) === Number(otherUserId) || Number(p.recipientId) === Number(otherUserId)) load(); });
    return { cleanup: off };
  }

  // محادثة إشراف (HR/المالك يطّلعوا على محادثة بين طرفين تانيين) — عرض فقط، بلا إرسال.
  function renderOversightThread(userAId, userBId, userAName, userBName, container) {
    const chatBox = el('div', { class: 'card card-pad', style: 'min-height:320px;max-height:480px;overflow-y:auto' });
    container.appendChild(el('div', { class: 'muted mb-8' }, ['👁️ وضع الإشراف — عرض فقط']));
    container.appendChild(chatBox);

    async function load() {
      try {
        const { messages } = await api(`/chat/oversight/${userAId}/${userBId}/messages`);
        chatBox.innerHTML = '';
        if (messages.length === 0) {
          chatBox.appendChild(el('div', { class: 'muted' }, ['لا توجد رسائل في هذه المحادثة.']));
        } else {
          messages.forEach((m) => chatBox.appendChild(messageBubble(m, Number(m.senderId) === Number(userAId), Number(m.senderId) === Number(userAId) ? userAName : userBName)));
        }
        chatBox.scrollTop = chatBox.scrollHeight;
      } catch (e) { toast(e.message, 'error'); }
    }
    load();
    const off = App.on('rt:CHAT_MESSAGE_OVERSIGHT', (p) => {
      const ids = [Number(p.senderId), Number(p.recipientId)];
      if (ids.includes(Number(userAId)) && ids.includes(Number(userBId))) load();
    });
    return { cleanup: off };
  }

  App.route('/chat', async () => {
    const user = App.state.user;
    const isOverseer = !!user.isOwner || (user.role === 'team_leader' && !!user.isHr);
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [el('div', { class: 'page-title' }, ['💬 الدردشة'])]));
    container.appendChild(el('div', { class: 'muted mb-12' }, ['محادثة مباشرة وخاصة بينك وبين أي زميل — محادثتك ما يشوفها حد غيرك وغير الطرف التاني، ما عدا حساب الموارد البشرية اللي يقدر يشوف كل المحادثات للإشراف.']));

    const tabsWrap = isOverseer ? el('div', { class: 'flex gap-8 mb-12' }) : null;
    if (tabsWrap) container.appendChild(tabsWrap);

    const bodyWrap = el('div');
    container.appendChild(bodyWrap);

    let activeTab = 'mine';
    let cleanupFns = [];
    function clearCleanups() { cleanupFns.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); cleanupFns = []; }

    function renderTabs() {
      if (!tabsWrap) return;
      tabsWrap.innerHTML = '';
      tabsWrap.appendChild(el('button', { class: 'btn btn-sm ' + (activeTab === 'mine' ? 'btn-primary' : 'btn-outline'), onclick: () => { activeTab = 'mine'; renderTabs(); renderMineTab(); } }, ['محادثاتي']));
      tabsWrap.appendChild(el('button', { class: 'btn btn-sm ' + (activeTab === 'oversight' ? 'btn-primary' : 'btn-outline'), onclick: () => { activeTab = 'oversight'; renderTabs(); renderOversightTab(); } }, ['👁️ كل المحادثات (إشراف)']));
    }

    // ------------------------------------------------------------------
    // تبويب "محادثاتي": قائمة المحادثات (مرتبة بالأحدث) + زر بدء محادثة جديدة
    // من قائمة كل الحسابات — يفتح دردشة مع أي زميل، بغض النظر عن دوره.
    // ------------------------------------------------------------------
    function renderMineTab() {
      clearCleanups();
      bodyWrap.innerHTML = '';
      const grid = el('div', { style: 'display:grid;grid-template-columns:280px 1fr;gap:16px' });
      if (window.innerWidth < 880) grid.style.gridTemplateColumns = '1fr';
      const listBox = el('div', { class: 'card card-pad', style: 'max-height:560px;overflow-y:auto' });
      const threadArea = el('div');
      grid.appendChild(listBox);
      grid.appendChild(threadArea);
      bodyWrap.appendChild(grid);

      let currentCleanup = null;
      let selectedId = null;

      async function loadThreads() {
        const [{ threads }, { contacts }] = await Promise.all([api('/chat/threads'), api('/chat/contacts')]);
        listBox.innerHTML = '';
        listBox.appendChild(el('button', { class: 'btn btn-outline btn-sm', style: 'width:100%;margin-bottom:10px', onclick: () => openContactPicker(contacts) }, ['✏️ محادثة جديدة']));
        if (threads.length === 0) {
          listBox.appendChild(el('div', { class: 'muted' }, ['لا توجد محادثات بعد — ابدأ واحدة من "محادثة جديدة".']));
        }
        threads.forEach((t) => {
          const row = el('div', {
            class: 'checklist-item', style: `cursor:pointer;${selectedId === t.userId ? 'background:var(--brand-soft)' : ''}`,
            onclick: () => selectThread(t.userId, contactLabel(t)),
          }, [
            el('div', { style: 'flex:1;min-width:0' }, [
              el('div', { class: 'flex-between' }, [el('span', { style: 'font-weight:700' }, [contactLabel(t)]), t.unreadCount > 0 ? el('span', { class: 'badge badge-overdue' }, [String(t.unreadCount)]) : null]),
              el('div', { class: 'faint', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, [t.lastMessage ? ((t.lastMine ? 'أنت: ' : '') + t.lastMessage) : 'لا توجد رسائل بعد']),
            ]),
          ]);
          listBox.appendChild(row);
        });
      }
      function openContactPicker(contacts) {
        const list = el('div', { style: 'max-height:360px;overflow-y:auto' }, contacts.map((cnt) => el('div', {
          class: 'checklist-item', style: 'cursor:pointer',
          onclick: () => { dlg.close(); selectThread(cnt.userId, contactLabel(cnt)); },
        }, [el('span', { style: 'font-weight:700' }, [contactLabel(cnt)])])));
        const dlg = modal('بدء محادثة جديدة', list, [el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إغلاق'])]);
      }
      function selectThread(otherUserId, name) {
        selectedId = otherUserId;
        if (currentCleanup) currentCleanup();
        threadArea.innerHTML = '';
        threadArea.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, [name]));
        const { cleanup } = renderThread(otherUserId, name, threadArea);
        currentCleanup = cleanup;
        loadThreads();
      }
      loadThreads();
      threadArea.appendChild(el('div', { class: 'empty-state' }, ['اختر زميلًا من القائمة، أو ابدأ محادثة جديدة.']));
      const off = App.on('rt:CHAT_MESSAGE', loadThreads);
      cleanupFns.push(off, () => { if (currentCleanup) currentCleanup(); });
    }

    // ------------------------------------------------------------------
    // تبويب الإشراف (HR/المالك فقط): كل محادثة في النظام، بدون اشتراط إن
    // المشرف طرف فيها — عرض فقط، بلا إرسال، حفاظًا على خصوصية أصحاب المحادثة.
    // ------------------------------------------------------------------
    function renderOversightTab() {
      clearCleanups();
      bodyWrap.innerHTML = '';
      const grid = el('div', { style: 'display:grid;grid-template-columns:320px 1fr;gap:16px' });
      if (window.innerWidth < 880) grid.style.gridTemplateColumns = '1fr';
      const listBox = el('div', { class: 'card card-pad', style: 'max-height:560px;overflow-y:auto' });
      const threadArea = el('div');
      grid.appendChild(listBox);
      grid.appendChild(threadArea);
      bodyWrap.appendChild(grid);

      let currentCleanup = null;
      let selectedKey = null;

      async function loadAll() {
        const { threads } = await api('/chat/oversight/all-threads');
        listBox.innerHTML = '';
        if (threads.length === 0) { listBox.appendChild(el('div', { class: 'muted' }, ['لا توجد محادثات في النظام بعد.'])); return; }
        threads.forEach((t) => {
          const key = t.userA.userId + '-' + t.userB.userId;
          const row = el('div', {
            class: 'checklist-item', style: `cursor:pointer;${selectedKey === key ? 'background:var(--brand-soft)' : ''}`,
            onclick: () => selectPair(t.userA, t.userB),
          }, [
            el('div', { style: 'flex:1;min-width:0' }, [
              el('div', { style: 'font-weight:700' }, [`${contactLabel(t.userA)} ↔ ${contactLabel(t.userB)}`]),
              el('div', { class: 'faint', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, [t.lastMessage || '—']),
            ]),
          ]);
          listBox.appendChild(row);
        });
      }
      function selectPair(a, b) {
        selectedKey = a.userId + '-' + b.userId;
        if (currentCleanup) currentCleanup();
        threadArea.innerHTML = '';
        threadArea.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px' }, [`${contactLabel(a)} ↔ ${contactLabel(b)}`]));
        const { cleanup } = renderOversightThread(a.userId, b.userId, contactLabel(a), contactLabel(b), threadArea);
        currentCleanup = cleanup;
        loadAll();
      }
      loadAll();
      threadArea.appendChild(el('div', { class: 'empty-state' }, ['اختر محادثة من القائمة لعرضها.']));
      const off = App.on('rt:CHAT_MESSAGE_OVERSIGHT', loadAll);
      cleanupFns.push(off, () => { if (currentCleanup) currentCleanup(); });
    }

    renderTabs();
    renderMineTab();
    container.cleanup = () => clearCleanups();
    return container;
  });
})();
