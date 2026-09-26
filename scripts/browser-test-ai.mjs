import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

await page.goto('http://localhost:8787/');
await page.waitForTimeout(800);
await page.click('.login-card:has-text("TEAM LEADER")');
await page.waitForTimeout(300);
await page.fill('#f-password', 'Rahmamallofficial199978518');
await page.click('button:has-text("LOGIN")');
await page.waitForTimeout(1000);

await page.click('.nav-item:has-text("AI Assistant")');
await page.waitForTimeout(600);
await page.click('button:has-text("Generate Daily Summary")');
await page.waitForTimeout(700);
await page.click('button:has-text("Generate Operational Insights")');
await page.waitForTimeout(700);
await page.fill('input[placeholder*="Ask about"]', 'What is the lead score of RM-000001?');
await page.press('input[placeholder*="Ask about"]', 'Enter');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/ai-1.png', fullPage: true });
console.log('CONSOLE_ERRORS:', JSON.stringify(errors, null, 2));
await browser.close();
