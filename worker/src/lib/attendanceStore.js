// Thin client for the AttendanceStore Durable Object (see
// durable-objects/attendance-store.js for why this exists instead of D1).
// One global instance, same pattern as broadcast()'s TEAM_ROOM lookup in
// lib/db.js.
function getStub(env) {
  const id = env.ATTENDANCE_STORE.idFromName('global');
  return env.ATTENDANCE_STORE.get(id);
}

async function call(env, path, body) {
  const stub = getStub(env);
  const res = await stub.fetch('https://attendance-store.internal' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function asGet(env, key) {
  const { value } = await call(env, '/get', { key });
  return value;
}

export async function asPut(env, key, value) {
  await call(env, '/put', { key, value });
}

export async function asList(env, prefix) {
  const { entries } = await call(env, '/list', { prefix });
  return entries;
}

export async function asDelete(env, key) {
  await call(env, '/delete', { key });
}

// الفحص + الكتابة الذرّيّة لتسجيل حضور/انصراف — انظر التعليق فوق endpoint
// /checkin و/checkout في durable-objects/attendance-store.js لسبب وجودهم
// كعملية واحدة بدل get ثم put منفصلين.
export async function asCheckIn(env, key, payload) {
  return call(env, '/checkin', { key, ...payload });
}

export async function asCheckOut(env, key, payload) {
  return call(env, '/checkout', { key, ...payload });
}
