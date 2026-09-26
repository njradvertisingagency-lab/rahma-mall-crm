import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('response', async (res) => {
  if (res.url().includes('/api/') && res.status() >= 400) console.log('API ERROR', res.status(), res.url());
});

// --- Team Leader: Command Center ---
await page.goto('http://localhost:8787/');
await page.waitForTimeout(800);
await page.click('.login-card:has-text("TEAM LEADER")').catch(() => {});
await page.waitForTimeout(300);
await page.fill('#f-password', 'Rahmamallofficial199978518').catch(async () => {
  // fallback: username/password form instead of picker
  await page.fill('#f-username', 'Teamleader');
  await page.fill('#f-password', 'Rahmamallofficial199978518');
});
await page.click('button:has-text("LOGIN")');
await page.waitForTimeout(1200);

await page.click('.nav-item:has-text("Command Center")');
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/cc-1-command-center.png', fullPage: true });
const ccText = await page.textContent('body');
console.log('Command Center has "Live Employee Table":', ccText.includes('Live Employee Table'));
console.log('Command Center has "Needs Attention":', ccText.includes('Needs Attention'));
console.log('Command Center has "Today\'s Sales" via heading:', ccText.includes("Today's Sales"));

// Customers page — segment/saved-filter bar
await page.click('.nav-item:has-text("Customers")');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/cc-2-customers-filters.png', fullPage: true });
const custText = await page.textContent('body');
console.log('Customers page has segment select:', custText.includes('All segments'));
console.log('Customers page has saved filter UI:', custText.includes('Save Current Filter'));

// Open a customer detail to confirm no crash from the new API fields
const detailLink = await page.$('a[href^="#/customers/"]');
if (detailLink) {
  await detailLink.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/cc-3-customer-detail.png', fullPage: true });
}

await page.click('button:has-text("Logout")');
await page.waitForTimeout(600);

// --- Employee: Work Queue ---
await page.click('.login-card:has-text("EMPLOYEE")').catch(() => {});
await page.waitForTimeout(300);
await page.click('.employee-pick:has-text("Ashrakat")').catch(() => {});
await page.waitForTimeout(300);
await page.fill('#f-password', 'Ashrakat1559');
await page.click('button:has-text("LOGIN")');
await page.waitForTimeout(1200);

await page.click('.nav-item:has-text("My Work Queue")');
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/cc-4-work-queue.png', fullPage: true });
const wqText = await page.textContent('body');
console.log('Work Queue has "Next Customers to Handle":', wqText.includes('Next Customers to Handle'));
console.log('Work Queue has "Smart Follow-up Suggestions":', wqText.includes('Smart Follow-up Suggestions'));

// Employee attempting Command Center via hash nav should be denied
await page.goto('http://localhost:8787/#/command-center');
await page.waitForTimeout(500);
const deniedText = await page.textContent('body');
console.log('Employee denied Command Center:', deniedText.includes('Access Denied'));

console.log('CONSOLE_ERRORS:', JSON.stringify(errors, null, 2));
await browser.close();
