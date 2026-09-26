// Verifies the frontend connection badge transitions LIVE -> RECONNECTING -> LIVE
// when the browser's network drops and comes back, exercising the real
// exponential-backoff reconnect logic in frontend/public/app.js (RT.connect).
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

async function badgeState() {
  return page.evaluate(() => {
    const el = document.querySelector('.conn-badge');
    return el ? { class: el.className, text: el.textContent.trim() } : null;
  });
}

console.log('--- Login as Team Leader ---');
await page.goto('http://localhost:8787/');
await page.waitForTimeout(800);
await page.click('.login-card:has-text("TEAM LEADER")');
await page.waitForTimeout(300);
await page.fill('#f-password', 'Rahmamallofficial199978518');
await page.click('button:has-text("LOGIN")');
await page.waitForTimeout(1200);

const initial = await badgeState();
console.log('Initial badge state:', initial);

console.log('\n--- Simulating network drop (context.setOffline(true)) ---');
await context.setOffline(true);
await page.waitForTimeout(1500);
const duringOffline = await badgeState();
console.log('Badge state during network drop:', duringOffline);

console.log('\n--- Restoring network (context.setOffline(false)) ---');
await context.setOffline(false);
// RT.backoff starts at 1000ms and grows *1.7 each failed attempt, so give it
// a generous window to reconnect.
let recovered = null;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(1000);
  const s = await badgeState();
  console.log(`  [+${(i + 1)}s] badge:`, s);
  if (s && s.class.includes('conn-live')) { recovered = s; break; }
}

await page.screenshot({ path: '/tmp/ws-reconnect-final.png', fullPage: true });

console.log('\n=== SUMMARY ===');
const checks = [
  ['Initial state is LIVE', !!initial && initial.class.includes('conn-live') && initial.text === 'LIVE'],
  ['State during drop is RECONNECTING', !!duringOffline && duringOffline.class.includes('conn-reconnecting') && duringOffline.text === 'RECONNECTING'],
  ['State recovered to LIVE after network restore', !!recovered],
  ['No console/page errors', errors.length === 0],
];
checks.forEach(([label, pass]) => console.log((pass ? 'PASS' : 'FAIL') + ' — ' + label));
if (errors.length) console.log('Console errors:', JSON.stringify(errors, null, 2));
const allPass = checks.every(([, pass]) => pass);
console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
await browser.close();
process.exit(allPass ? 0 : 1);
