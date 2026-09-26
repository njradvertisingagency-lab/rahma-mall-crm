import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('response', async (res) => {
  if (res.url().includes('/api/')) {
    console.log('API', res.status(), res.url());
  }
});

await page.goto('http://localhost:8787/');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/shot-1-login.png' });

// Team Leader login
await page.click('.login-card:has-text("TEAM LEADER")');
await page.waitForTimeout(300);
await page.fill('#f-username', 'Teamleader');
await page.fill('#f-password', 'Rahmamallofficial199978518');
await page.click('button:has-text("LOGIN")');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/shot-2-dashboard.png', fullPage: true });
console.log('URL after login click:', page.url());
console.log('CONSOLE_ERRORS_SO_FAR:', JSON.stringify(errors, null, 2));
console.log('BODY_TEXT_SNIPPET:', (await page.textContent('body') || '').slice(0, 300));

await page.click('.nav-item:has-text("Customers")');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/shot-3-customers.png', fullPage: true });

await page.click('a:has-text("RM-000001")');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/shot-4-detail.png', fullPage: true });

await page.click('.nav-item:has-text("Analytics")');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/shot-5-analytics.png', fullPage: true });

await page.click('.nav-item:has-text("AI Assistant")');
await page.waitForTimeout(500);
await page.fill('input[placeholder*="Ask about"]', 'How many customers are unassigned?');
await page.click('button:has-text("Ask")');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/shot-6-ai.png', fullPage: true });

await page.click('.nav-item:has-text("Settings")');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/shot-7-settings.png', fullPage: true });

await page.click('.nav-item:has-text("Distribute")');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/shot-8-distribute.png', fullPage: true });

await page.click('.nav-item:has-text("Leaderboard")');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/shot-9-leaderboard.png', fullPage: true });

await page.click('.nav-item:has-text("Employees")');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/shot-10-employees.png', fullPage: true });

console.log('FINAL_CONSOLE_ERRORS:', JSON.stringify(errors, null, 2));

console.log('CONSOLE_ERRORS:', JSON.stringify(errors, null, 2));
await browser.close();
