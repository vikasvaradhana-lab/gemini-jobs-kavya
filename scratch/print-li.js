const { chromium } = require('playwright');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = 'https://biontech.wd3.myworkdayjobs.com/BNT/jobs?q=scientist+cell+biology';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('Goto error:', e.message));
  await page.waitForTimeout(5000);
  
  const text = await page.innerText('body');
  console.log('--- Body Text ---');
  console.log(text.substring(0, 2000));
  
  // Let's also check if there is an iframe or something similar
  const frames = page.frames();
  console.log('Number of frames:', frames.length);
  
  await browser.close();
})();
