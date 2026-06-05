const { chromium } = require('playwright');
const cheerio = require('cheerio');

(async () => {
  console.log('Launching browser for AstraZeneca...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = 'https://careers.astrazeneca.com/search-jobs?location=Sweden&keywords=research+scientist+cell+biology+epigenetics';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('Goto error:', e.message));
  await page.waitForTimeout(5000);
  
  const html = await page.content();
  const $ = cheerio.load(html);
  
  console.log('HTML Length:', html.length);
  console.log('a tags:', $('a').length);
  console.log('h2 tags:', $('h2').length);
  console.log('h3 tags:', $('h3').length);
  
  // Find links containing "/job/"
  console.log('\nLinks containing "/job/":');
  $('a[href*="/job/"]').each((i, el) => {
    console.log(`[${i+1}] text: "${$(el).text().trim()}" href: "${$(el).attr('href')}"`);
  });

  // Let's print the first 500 characters of the inner text of some potential containers
  console.log('\nBody text snippet:');
  const text = await page.innerText('body');
  console.log(text.substring(0, 1500));

  await browser.close();
})();
