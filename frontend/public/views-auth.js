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
        el('div', { class: 'logo' }, ['RAHMA MALL']),
        el('div', { class: 'title' }, ['LIVE CALL TEAM CRM']),
        el('div', { class: 'subtitle' }, ['Customer Distribution & Team Management']),
      ]);
      container.appendChild(brand);

      if (screen === 'pick') {
        container.appendChild(
          el('div', { class: 'login-cards' }, [
            el('div', { class: 'login-card', onclick: () => { screen = 'tl-form'; render(); } }, [
              el('div', { class: 'icon' }, ['🧑‍💼']),
              el('div', { class: 'label' }, ['TEAM LEADER']),
              el('div', { class: 'desc' }, ['Manage the whole team, distribute customers, view analytics.']),
            ]),
            el('div', { class: 'login-card', onclick: async () => { screen = 'employee-pick'; await loadEmployees(); render(); } }, [
              el('div', { class: 'icon' }, ['👥']),
              el('div', { class: 'label' }, ['EMPLOYEES']),
              el('div', { class: 'desc' }, ['Handle your assigned customers and follow-ups.']),
            ]),
          ])
        );
      } else if (screen === 'tl-form') {
        container.appendChild(renderLoginForm('Teamleader-optional', 'Team Leader Login', true));
      } else if (screen === 'employee-pick') {
        container.appendChild(
          el('div', { class: 'employee-pick-grid' }, employees.map((e) =>
            el('div', { class: 'employee-pick', onclick: () => { selectedEmployee = e; screen = 'employee-form'; render(); } }, [
              el('div', { class: 'avatar' }, [e.avatar_initial]),
              el('div', { style: 'font-weight:700;font-size:13px' }, [e.name]),
            ])
          ))
        );
        container.appendChild(el('button', { class: 'btn btn-outline mt-16', onclick: () => { screen = 'pick'; render(); } }, ['← Back']));
      } else if (screen === 'employee-form') {
        container.appendChild(renderLoginForm(selectedEmployee.username, `Welcome, ${selectedEmployee.name}`, false));
      }
    }

    async function loadEmployees() {
      try {
        const data = await api('/auth/employees-public');
        employees = data.employees;
      } catch (e) {
        toast('Could not load employee list', 'error');
      }
    }

    function renderLoginForm(prefillUsername, title, isTeamLeader) {
      const card = el('div', { class: 'login-form-card' });
      const heading = el('div', { class: 'modal-title mb-16' }, [title]);
      const usernameField = isTeamLeader
        ? el('div', { class: 'field' }, [el('label', {}, ['Username']), el('input', { id: 'f-username', value: '', placeholder: 'Teamleader' })])
        : el('input', { id: 'f-username', type: 'hidden', value: prefillUsername });
      const passwordField = el('div', { class: 'field' }, [
        el('label', {}, ['Password']),
        el('input', { id: 'f-password', type: 'password' }),
      ]);
      const toggleRow = el('div', { class: 'password-toggle-row' }, [
        el('label', { class: 'checkbox-row' }, [el('input', { type: 'checkbox', id: 'f-showpw', onchange: (e) => { document.getElementById('f-password').type = e.target.checked ? 'text' : 'password'; } }), 'Show password']),
        el('label', { class: 'checkbox-row' }, [el('input', { type: 'checkbox', id: 'f-remember' }), 'Remember me']),
      ]);
      const errorBox = el('div', { class: 'error-text', style: 'display:none' });
      const submit = el('button', { class: 'btn btn-primary btn-block', onclick: onSubmit }, ['LOGIN']);
      const back = el('button', { class: 'btn btn-outline btn-block mt-8', onclick: () => { screen = 'pick'; render(); } }, ['← Back']);

      async function onSubmit() {
        errorBox.style.display = 'none';
        submit.disabled = true;
        submit.textContent = 'Signing in…';
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
          errorBox.textContent = e.message || 'Invalid username or password';
          errorBox.style.display = 'block';
        } finally {
          submit.disabled = false;
          submit.textContent = 'LOGIN';
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
