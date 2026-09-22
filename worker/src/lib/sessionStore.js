// Thin RPC-style client for the SessionStore Durable Object — same pattern
// as lib/attendanceStore.js. Every login session is a single key (the
// session token itself) mapping to a small JSON record; see lib/auth.js for
// what that record contains and why (it caches the user's role/name/owner
// flag/employeeId at login time so requireAuth never has to touch D1 again
// for the life of the session).
function getStub(env) {
  const id = env.SESSION_STORE.idFromName('global');
  return env.SESSION_STORE.get(id);
}

async function call(env, path, body) {
  const stub = getStub(env);
  const res = await stub.fetch('https://session-store.internal' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function sessGet(env, token) {
  const { value } = await call(env, '/get', { key: token });
  return value;
}

export async function sessPut(env, token, value) {
  await call(env, '/put', { key: token, value });
}

export async function sessDelete(env, token) {
  await call(env, '/delete', { key: token });
}

/** Every active session, for the "sign this user out everywhere" use case (routes/employees.js). */
export async function sessListAll(env) {
  const { entries } = await call(env, '/list', {});
  return entries;
}
