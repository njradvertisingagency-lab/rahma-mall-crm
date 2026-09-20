'use strict';
(function () {
  const { el, api, toast } = App;

  App.views.login = async function () {
    const container = el('div', { class: 'login-screen' });
    let screen = 'pick';
    let employees = [];
    let selectedEmployee = null;

    async function render() {
      container.innerHTML = '';
      const brand = el('div', { class: 'login-brand' }, [
        el('div', { class: 'logo' }, ['رحمة مول']),
        el('div', { class: 'title' }, ['نظام إدارة فريق المكالمات']),
        el('div', { class: 'subtitle' }, ['توزيع العملاء وإدارة الفريق']),
      ]);
      container.appendChild(brand);

      if (screen === 'pick') {
        container.appendChild(
          el('div', { class: 'login-cards' }, [
            el('div', { class: 'login-card', onclick: () => { screen = 'tl-form'; render(); } }, [
              el('div', { class: 'icon' }, ['🧑‍💼']),
              el('div', { class: 'label' }, ['قائد الفريق']),
              el('div', { class: 'desc' }, ['إدارة الفريق بالكامل، توزيع العملاء، ومتابعة التحليلات.']),
            ]),
            el('div', { class: 'login-card', onclick: async () => { screen = 'employee-pick'; await loadEmployees(); render(); } }, [
              el('div', { class: 'icon' }, ['👥']),
              el('div', { class: 'label' }, ['الموظفين']),
              el('div', { class: 'desc' }, ['متابعة عملائك ومهامك الخاصة.']),
            ]),
          ])
        );
      } else if (screen === 'tl-form') {
        container.appendChild(renderLoginForm('Teamleader-optional', 'تسجيل دخول قائد الفريق', true));
      } else if (screen === 'employee-pick') {
        container.appendChild(
          el('div', { class: 'employee-pick-grid' }, employees.map((e) =>
            el('div', { class: 'employee-pick', onclick: () => { selectedEmployee = e; screen = 'employee-form'; render(); } }, [
              el('div', { class: 'avatar' }, [e.avatar_initial]),
              el('div', { style: 'font-weight:700;font-size:13px' }, [e.name]),
            ])
          ))
        );
        container.appendChild(el('button', { class: 'btn btn-outline mt-16', onclick: () => { screen = 'pick'; render(); } }, ['← رجوع']));
      } else if (screen === 'employee-form') {
        container.appendChild(renderLoginForm(selectedEmployee.username, `أهلاً بك، ${selectedEmployee.name}`, false));
      }
    }

    async function loadEmployees() {
      try {
        const data = await api('/auth/employees-public');
        employees = data.employees;
      } catch (e) {
        toast('تعذّر تحميل قائمة الموظفين', 'error');
      }
    }

    function renderLoginForm(prefillUsername, title, isTeamLeader) {
      const card = el('div', { class: 'login-form-card' });
      const heading = el('div', { class: 'modal-title mb-16' }, [title]);
      const usernameField = isTeamLeader
        ? el('div', { class: 'field' }, [el('label', {}, ['اسم المستخدم']), el('input', { id: 'f-username', value: '', placeholder: 'Teamleader' })])
        : el('input', { id: 'f-username', type: 'hidden', value: prefillUsername });
      const passwordField = el('div', { class: 'field' }, [
        el('label', {}, ['كلمة المرور']),
        el('input', { id: 'f-password', type: 'password' }),
      ]);
      const toggleRow = el('div', { class: 'password-toggle-row' }, [
        el('label', { class: 'checkbox-row' }, [el('input', { type: 'checkbox', id: 'f-showpw', onchange: (e) => { document.getElementById('f-password').type = e.target.checked ? 'text' : 'password'; } }), 'إظهار كلمة المرور']),
        el('label', { class: 'checkbox-row' }, [el('input', { type: 'checkbox', id: 'f-remember' }), 'تذكرني']),
      ]);
      const errorBox = el('div', { class: 'error-text', style: 'display:none' });
      const submit = el('button', { class: 'btn btn-primary btn-block', onclick: onSubmit }, ['تسجيل الدخول']);
      const back = el('button', { class: 'btn btn-outline btn-block mt-8', onclick: () => { screen = 'pick'; render(); } }, ['← رجوع']);

      async function onSubmit() {
        errorBox.style.display = 'none';
        submit.disabled = true;
        submit.textContent = 'جارِ الدخول…';
        const username = isTeamLeader ? document.getElementById('f-username').value.trim() || 'Teamleader' : prefillUsername;
        const password = document.getElementById('f-password').value;
        const remember = document.getElementById('f-remember').checked;
        try {
          const data = await api('/auth/login', { method: 'POST', body: { username, password, remember } });
          App.state.user = data.user;
          App.rt.connect();
          App.refreshNotifications();
          App.navigate('#/dashboard');
        } catch (e) {
          errorBox.textContent = e.message || 'اسم المستخدم أو كلمة المرور غير صحيحة';
          errorBox.style.display = 'block';
        } finally {
          submit.disabled = false;
          submit.textContent = 'تسجيل الدخول';
        }
      }

      card.appendChild(heading);
      if (isTeamLeader) card.appendChild(usernameField); else card.appendChild(usernameField);
      card.appendChild(passwordField);
      card.appendChild(toggleRow);
      card.appendChild(errorBox);
      card.appendChild(submit);
      card.appendChild(back);
      passwordField.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSubmit(); });
      return card;
    }

    await render();
    return container;
  };
})();
