const { chromium } = require('playwright');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });
  const page = await browser.newPage();
  
  // Set up request interception
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/wday/cxs/')) {
      console.log(`\n[Intercepted Workday CXS Request]`);
      console.log('URL:', url);
      console.log('Method:', request.method());
      console.log('Headers:', JSON.stringify(request.headers(), null, 2));
      if (request.method() === 'POST') {
        console.log('Post Body:', request.postData());
      }
    }
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('/wday/cxs/')) {
      console.log(`[Intercepted Workday CXS Response]`);
      console.log('URL:', url);
      console.log('Status:', response.status());
      try {
        const text = await response.text();
        console.log('Response body preview:', text.substring(0, 500));
      } catch (e) {
        console.log('Could not read response body:', e.message);
      }
    }
  });

  const url = 'https://biontech.wd3.myworkdayjobs.com/BNT/jobs?q=scientist+cell+biology';
  console.log('Navigating to:', url);
  
  // Wait for 10 seconds to let the page fetch the jobs
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('Goto error:', e.message));
  await page.waitForTimeout(10000);

  await browser.close();
  console.log('Browser closed.');
})();
