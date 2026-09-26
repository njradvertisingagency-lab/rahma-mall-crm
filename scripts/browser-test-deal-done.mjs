import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('dialog', async (d) => { console.log('DIALOG:', d.message()); await d.accept(); });
page.on('response', async (res) => {
  if (res.url().includes('/api/') && res.status() >= 400) console.log('API ERROR', res.status(), res.url());
});

await page.goto('http://localhost:8787/');
await page.waitForTimeout(800);
await page.click('.login-card:has-text("TEAM LEADER")');
await page.waitForTimeout(300);
await page.fill('#f-password', 'Rahmamallofficial199978518');
await page.click('button:has-text("LOGIN")');
await page.waitForTimeout(1000);

await page.click('.nav-item:has-text("Customers")');
await page.waitForTimeout(800);
await page.click('a[href^="#/customers/"]');
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/dd-1-customer360.png', fullPage: true });

const bodyText1 = await page.textContent('body');
console.log('Has Lead Score:', bodyText1.includes('Lead Score'));
console.log('Has SLA Status:', bodyText1.includes('SLA Status'));
console.log('Has Product Interest section:', bodyText1.includes('Product Interest'));
console.log('Has Call Attempts section:', bodyText1.includes('Call Attempts'));
console.log('Has Deal Done button:', bodyText1.includes('Deal Done'));

// Add a product interest
await page.fill('input[placeholder="Add a product…"]', 'Blender XL');
await page.click('button:has-text("Add")');
await page.waitForTimeout(700);
const bodyText2 = await page.textContent('body');
console.log('Product added successfully:', bodyText2.includes('Blender XL'));

// Log a call attempt
await page.click('button:has-text("📞 Log Call Attempt")');
await page.waitForTimeout(400);
await page.selectOption('.modal select', 'ANSWERED');
await page.click('.modal button:has-text("Save")');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/dd-2-after-call-attempt.png', fullPage: true });

// Log a branch visit
await page.click('button:has-text("🏪 Branch Visit")');
await page.waitForTimeout(400);
await page.click('.modal button:has-text("Save")');
await page.waitForTimeout(700);

// Open Deal Done modal and submit a purchase
await page.click('button:has-text("✓ Deal Done")');
await page.waitForTimeout(500);
await page.fill('.modal input[placeholder="Product"]', 'Air Fryer Pro');
await page.fill('.modal input[placeholder="Invoice number (optional)"]', 'INV-TEST-001');
const priceInputs = await page.$$('.modal input[type="number"]');
// qty is priceInputs[0], price is [1], discount is [2] for the first line
await priceInputs[1].fill('1500');
await page.waitForTimeout(200);
await page.screenshot({ path: '/tmp/dd-3-deal-modal.png', fullPage: true });
await page.click('.modal button:has-text("Confirm Deal Done")');
await page.waitForTimeout(500);
// confirm() dialog will be auto-accepted
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/dd-4-after-deal.png', fullPage: true });

const bodyText3 = await page.textContent('body');
console.log('Purchase recorded (1500):', bodyText3.includes('1,500') || bodyText3.includes('1500'));
console.log('Invoice shown:', bodyText3.includes('INV-TEST-001'));

console.log('CONSOLE_ERRORS:', JSON.stringify(errors, null, 2));
await browser.close();
