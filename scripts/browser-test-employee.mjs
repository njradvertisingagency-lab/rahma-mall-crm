import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('response', async (res) => {
  if (res.url().includes('/api/')) console.log('API', res.status(), res.url());
});

await page.goto('http://localhost:8787/');
await page.waitForTimeout(800);

await page.click('.login-card:has-text("EMPLOYEE")');
await page.waitForTimeout(400);
await page.click('.employee-pick:has-text("Ashrakat")');
await page.waitForTimeout(300);
await page.fill('#f-password', 'Ashrakat1559');
await page.click('button:has-text("LOGIN")');
await page.waitForTimeout(1200);

await page.click('.nav-item:has-text("Customers")');
await page.waitForTimeout(600);
const detailLink = await page.$('a[href^="#/customers/"]');
if (detailLink) { await detailLink.click(); await page.waitForTimeout(600); }

await page.click('.nav-item:has-text("Follow-ups")');
await page.waitForTimeout(600);
// toggle the overdue checkbox and click apply - exercise the fixed code path
const cb = await page.$('.checkbox-row input[type="checkbox"]');
if (cb) { await cb.click(); await page.click('button:has-text("Apply")'); await page.waitForTimeout(400); }
await page.screenshot({ path: '/tmp/emp-6-followups.png', fullPage: true });

await page.click('.nav-item:has-text("Notifications")');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/emp-7-notifications.png', fullPage: true });

await page.click('.nav-item:has-text("My Performance")');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/emp-8-myperf.png', fullPage: true });

await page.click('.nav-item:has-text("Profile")');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/emp-9-profile.png', fullPage: true });

// Direct hash-navigation attempts at every TL-only route as an employee.
const tlRoutes = ['#/distribute', '#/import', '#/employees', '#/analytics', '#/leaderboard', '#/reports', '#/settings', '#/ai'];
for (const route of tlRoutes) {
  await page.goto('http://localhost:8787/' + route);
  await page.waitForTimeout(400);
  const text = await page.textContent('body');
  const denied = text.includes('Access Denied');
  console.log(route, '=> Access Denied shown:', denied);
}

console.log('CONSOLE_ERRORS:', JSON.stringify(errors, null, 2));
await browser.close();
