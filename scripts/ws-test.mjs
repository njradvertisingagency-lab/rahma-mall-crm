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

function connect(name, cookie) {
  const ws = new WebSocket('ws://localhost:8787/ws', { headers: { Cookie: cookie } });
  ws.on('open', () => console.log(`[${name}] connected`));
  ws.on('message', (data) => console.log(`[${name}] received:`, data.toString()));
  ws.on('close', (code) => console.log(`[${name}] closed`, code));
  ws.on('error', (err) => console.log(`[${name}] error`, err.message));
  return ws;
}

const tlWs = connect('TeamLeader', tlCookie);
const empWs = connect('Ashrakat', empCookie);

setTimeout(async () => {
  console.log('--- triggering a status change as employee via HTTP ---');
  const res = await fetch('http://localhost:8787/api/customers/RM-000002/status', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-rahma-client': 'web', Cookie: tlCookie },
    body: JSON.stringify({ status: 'CALLING' }),
  });
  console.log('HTTP status change result:', await res.json());
}, 1500);

setTimeout(() => {
  tlWs.close();
  empWs.close();
  process.exit(0);
}, 4000);
