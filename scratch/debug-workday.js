const { chromium } = require('playwright');
const cheerio = require('cheerio');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = 'https://biontech.wd3.myworkdayjobs.com/BNT/jobs?q=scientist+cell+biology';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('Goto error:', e.message));
  
  // Settle a bit
  await page.waitForTimeout(5000);
  
  const html = await page.content();
  const $ = cheerio.load(html);
  
  console.log('HTML Length:', html.length);
  
  // Find all elements with "job" in class or attribute
  console.log('--- Printing selector matches ---');
  console.log('li count:', $('li').length);
  console.log('a count:', $('a').length);
  console.log('article count:', $('article').length);
  console.log('[data-automation-id="jobTitle"] count:', $('[data-automation-id="jobTitle"]').length);
  console.log('[data-automation-id*="job"] count:', $('[data-automation-id*="job"]').length);
  console.log('h3 count:', $('h3').length);
  
  // Log some elements
  $('h3').each((i, el) => {
    console.log(`h3[${i}]:`, $(el).text().trim());
  });
  
  $('[data-automation-id="jobTitle"]').each((i, el) => {
    console.log(`jobTitle[${i}]:`, $(el).text().trim());
  });
  
  await browser.close();
})();
