import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

function cookieFromJar(path) {
  const txt = readFileSync(path, 'utf8');
  const line = txt.split('\n').find((l) => l.includes('rm_session'));
  const parts = line.trim().split('\t');
  return `rm_session=${parts[6]}`;
}

const tlCookie = cookieFromJar('/tmp/tl_cookies.txt');
const empCookie = cookieFromJar('/tmp/emp_cookies.txt');

const tlReceived = [];
const empReceived = [];

function connect(name, cookie, sink) {
  const ws = new WebSocket('ws://localhost:8787/ws', { headers: { Cookie: cookie } });
  ws.on('open', () => console.log(`[${name}] connected`));
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type !== 'pong') { sink.push(msg.type); console.log(`[${name}] received:`, msg.type, JSON.stringify(msg.payload)); }
  });
  ws.on('close', (code) => console.log(`[${name}] closed`, code));
  ws.on('error', (err) => console.log(`[${name}] error`, err.message));
  return ws;
}

const tlWs = connect('TeamLeader', tlCookie, tlReceived);
const empWs = connect('Ashrakat', empCookie, empReceived);

await new Promise((r) => setTimeout(r, 1000));

console.log('\n--- 1) Employee heartbeat (presence) ---');
await fetch('http://localhost:8787/api/presence/heartbeat', { method: 'POST', headers: { 'x-rahma-client': 'web', Cookie: empCookie } });
await new Promise((r) => setTimeout(r, 500));

console.log('\n--- 2) TL logs a call attempt on RM-000001 (assigned to Ashrakat) ---');
await fetch('http://localhost:8787/api/customers/RM-000001/call-attempts', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-rahma-client': 'web', Cookie: tlCookie },
  body: JSON.stringify({ outcome: 'NO_ANSWER' }),
});
await new Promise((r) => setTimeout(r, 500));

console.log('\n--- 3) TL logs a branch visit on RM-000001 ---');
const branchesRes = await fetch('http://localhost:8787/api/sales/branches', { headers: { 'x-rahma-client': 'web', Cookie: tlCookie } });
const { branches } = await branchesRes.json();
await fetch('http://localhost:8787/api/sales/customers/RM-000001/branch-visits', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-rahma-client': 'web', Cookie: tlCookie },
  body: JSON.stringify({ branchId: branches[0].id, notes: 'ws-test visit' }),
});
await new Promise((r) => setTimeout(r, 500));

console.log('\n--- 4) TL records a Deal Done purchase on RM-000001, attributed to Ashrakat (employeeId 1) ---');
await fetch('http://localhost:8787/api/sales/customers/RM-000001/purchases', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-rahma-client': 'web', Cookie: tlCookie },
  body: JSON.stringify({
    branchId: branches[0].id,
    items: [{ productName: 'WS Test Product', quantity: 1, unitPrice: 999 }],
    paymentMethod: 'CASH',
    attributedEmployeeId: 1,
  }),
});
await new Promise((r) => setTimeout(r, 800));

tlWs.close();
empWs.close();

console.log('\n=== SUMMARY ===');
console.log('TL received event types:', tlReceived);
console.log('Employee received event types:', empReceived);

const checks = [
  ['TL received CALL_ATTEMPT_CREATED', tlReceived.includes('CALL_ATTEMPT_CREATED')],
  ['TL received LEAD_SCORE_UPDATED', tlReceived.includes('LEAD_SCORE_UPDATED')],
  ['TL received BRANCH_VISIT_CREATED', tlReceived.includes('BRANCH_VISIT_CREATED')],
  ['Employee (assigned) received BRANCH_VISIT_CREATED', empReceived.includes('BRANCH_VISIT_CREATED')],
  ['TL received DEAL_DONE_CREATED', tlReceived.includes('DEAL_DONE_CREATED')],
  ['TL received PURCHASE_CREATED', tlReceived.includes('PURCHASE_CREATED')],
  ['TL received REVENUE_UPDATED', tlReceived.includes('REVENUE_UPDATED')],
  ['Employee (attributed) received DEAL_DONE_CREATED', empReceived.includes('DEAL_DONE_CREATED')],
  ['Employee did NOT receive PURCHASE_CREATED (role-scoped only)', !empReceived.includes('PURCHASE_CREATED')],
];
checks.forEach(([label, pass]) => console.log((pass ? 'PASS' : 'FAIL') + ' — ' + label));
const allPass = checks.every(([, pass]) => pass);
console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(allPass ? 0 : 1);
