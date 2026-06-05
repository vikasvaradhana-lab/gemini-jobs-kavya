const fs = require('fs');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const DISCIPLINE_EXCLUDES = [
  'number theory', 'mathematics', 'algebraic', 'topology', 'combinatorics',
  'graph theory', 'calculus', 'statistics phd', 'mathematical model',
  'astrophysics', 'astronomy', 'astrobiology', 'cosmology', 'quantum',
  'particle physics', 'nuclear physics', 'optics phd', 'photonics phd',
  'condensed matter', 'plasma physics', 'geology', 'geophysics', 'hydrology',
  'oceanography', 'atmospheric science', 'climatology', 'groundwater',
  'electrical engineering', 'mechanical engineering', 'civil engineering',
  'aerospace engineering', 'chemical engineering phd', 'materials science phd',
  'robotics phd', 'philosophy', 'sociology', 'anthropology', 'archaeology',
  'linguistics', 'literature phd', 'political science', 'economics phd',
  'health economics', 'epidemiology phd', 'public health phd',
  'marine ecology', 'fisheries', 'aquaculture phd', 'forest ecology',
  'computer science phd', '6g ', 'cybersecurity phd', 'human-computer interaction'
];

const POSTDOC_EXCLUDES = [
  'postdoctoral', 'postdoc', 'post-doctoral', 'post-doc', 'postdoctorate',
  'postdoktor', 'postdoktoral', 'postdoktorand', 'forskarassistent',
  'forskardoktor', 'biträdande forskare', 'forsker', 'tutkijatohtori',
  'yliopistotutkija', 'postdoctorant', 'chercheur postdoctoral', 'postdottorato',
  'wissenschaftliche*r mitarbeiter*in postdoc', 'marie curie postdoctoral',
  'erc postdoctoral', 'postdoc-fellow', 'postdoktorandenstelle'
];

const SENIOR_EXCLUDES = [
  'universitetslektor', 'lektor', 'docent', 'professor', 'adjungerad professor',
  'avdelningschef', 'prefekt', 'amanuensis', 'førsteamanuensis', 'dekan',
  'gruppenleiter', 'abteilungsleiter', 'hoogleraar', 'professori',
  'apulaisprofessori', 'maître de conférences', 'group leader', 'department head',
  'principal investigator', 'chair in', 'senior scientist', 'senior researcher',
  'senior project manager', 'head of', 'director', 'team lead', 'principal scientist'
];

const HARD_EXCLUDES = [
  'software engineer', 'software developer', 'devops engineer', 'it engineer',
  'nursing', 'nurse practitioner', 'full professor', 'associate professor',
  'assistant professor', 'business development manager', 'sales representative',
  'account manager', 'hr manager', 'finance manager'
];

function checkExclusionReason(title, description = '') {
  const t = String(title || '').toLowerCase();
  const desc = String(description || '').toLowerCase();

  for (const x of HARD_EXCLUDES) {
    if (t.includes(x)) return { type: 'hardExclude', match: x };
  }
  for (const x of POSTDOC_EXCLUDES) {
    if (t.includes(x)) return { type: 'postdocExclude', match: x };
  }
  for (const x of SENIOR_EXCLUDES) {
    if (t.includes(x)) return { type: 'seniorExclude', match: x };
  }
  for (const x of DISCIPLINE_EXCLUDES) {
    if (t.includes(x)) return { type: 'disciplineExclude', match: x };
  }
  return null;
}

function checkIsRATechTitle(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('assistant') || t.includes('technician') || t.includes('engineer') || t.includes('assistent') || t.includes('tekniker');
}

function isGenericNavigationLink(title) {
  const t = String(title || '').trim().toLowerCase();
  const exactMenuTitles = new Set([
    'home', 'research', 'publications', 'seminars', 'conferences', 'services', 
    'about us', 'about', 'contact us', 'contact', 'careers', 'vacancies', 'news', 
    'events', 'search', 'menu', 'footer', 'header', 'terms', 'privacy', 'sitemap', 
    'log in', 'sign in', 'register', 'apply now', 'all positions', 'open positions', 
    'research areas', 'research groups', 'research reports', 'advisory board', 
    'sustainable business', 'partnering', 'science & technology', 'news & media', 
    'investors', 'privacy policy', 'cookie settings', 'terms of use', 'accessibility', 
    'search results', 'job title', 'date posted', 'business', 'sweden jobs', 
    'global jobs', 'filter', 'cookie policy', 'site map', 'supplier help', 
    'product list', 'code of conduct', 'esg reporting', 'foundation', 'social media', 
    'linkedin', 'youtube', 'facebook', 'instagram', 'tiktok', 'sort ascending',
    'disease areas', 'our products', 'healthcare professionals', 'product list', 
    'our purpose - code of conduct'
  ]);
  return exactMenuTitles.has(t);
}

function scoreJobMultiDimensional(title, description, sourceName) {
  const excl = checkExclusionReason(title, description);
  if (excl) {
    return { score: -1, reason: `Excluded: ${excl.type}` };
  }
  
  const text = (String(title) + ' ' + String(description || '')).toLowerCase();
  
  for (const x of HARD_EXCLUDES) {
    if (text.includes(x)) {
      return { score: -1, reason: 'Hard exclude in text' };
    }
  }

  let dim1 = 0;
  const nicheKeywords = [
    { kw: 'developmental epigenomics', w: 45 },
    { kw: 'developmental epigenetics', w: 45 },
    { kw: 'environmental epigenetics', w: 40 },
    { kw: 'dna methylation', w: 35 },
    { kw: 'pyrosequencing', w: 35 },
    { kw: 'epigenetic', w: 20 },
    { kw: 'epigenomics', w: 20 },
    { kw: 'methylation', w: 25 },
    { kw: 'environmental toxicology', w: 40 },
    { kw: 'endocrine disruptor', w: 40 },
    { kw: 'endocrine disrupt', w: 40 },
    { kw: 'molecular toxicology', w: 35 },
    { kw: 'neurotoxicology', w: 35 },
    { kw: 'toxicology', w: 20 },
    { kw: 'stem cell differentiation', w: 40 },
    { kw: 'stem-cell differentiation', w: 40 },
    { kw: 'hesc', w: 30 },
    { kw: 'mesc', w: 30 },
    { kw: 'embryonic stem', w: 30 },
    { kw: 'pluripotent', w: 15 },
    { kw: 'stem cell', w: 15 },
    { kw: 'dorsal forebrain differentiation', w: 35 },
    { kw: 'dorsal forebrain', w: 35 },
    { kw: 'neurodevelopment', w: 40 },
    { kw: 'neurodegeneration', w: 30 },
    { kw: 'neurodegenerative', w: 30 },
    { kw: 'sh-sy5y', w: 35 },
    { kw: 'caco-2', w: 35 },
    { kw: 'caco2', w: 35 },
    { kw: 'assay development', w: 25 },
    { kw: 'translational science', w: 20 },
    { kw: 'molecular diagnostics', w: 20 },
    { kw: 'in vitro assays', w: 20 },
    { kw: 'cell-based assay', w: 20 },
    { kw: 'cell-based assays', w: 20 },
    { kw: 'automation biology', w: 15 },
    { kw: 'bioanalytics', w: 15 },
    { kw: 'analytical development', w: 15 },
    { kw: 'cell culture scientist', w: 15 }
  ];

  for (const { kw, w } of nicheKeywords) {
    if (text.includes(kw)) {
      dim1 += w;
    }
  }
  dim1 = Math.min(dim1, 45);

  let dim2 = 0;
  const methodKeywords = [
    { kw: 'rt-qpcr', w: 25 },
    { kw: 'qpcr', w: 20 },
    { kw: 'real-time pcr', w: 20 },
    { kw: 'immunofluorescence', w: 20 },
    { kw: 'confocal', w: 15 },
    { kw: 'fluorescence microscopy', w: 15 },
    { kw: 'pyrosequencing', w: 20 },
    { kw: 'bisulfite', w: 20 },
    { kw: 'cell culture', w: 10 },
    { kw: 'mammalian cell', w: 10 },
    { kw: 'cell differentiation', w: 10 },
    { kw: 'flow cytometry', w: 8 },
    { kw: 'elisa', w: 8 },
    { kw: 'western blot', w: 7 }
  ];

  for (const { kw, w } of methodKeywords) {
    if (text.includes(kw)) {
      dim2 += w;
    }
  }
  dim2 = Math.min(dim2, 25);

  let dim3 = 0;
  const levelKeywords = [
    { kw: 'marie curie', w: 20 },
    { kw: 'msca', w: 20 },
    { kw: 'phd', w: 10 },
    { kw: 'doctoral', w: 10 },
    { kw: 'research assistant', w: 8 },
    { kw: 'research engineer', w: 8 },
    { kw: 'associate scientist', w: 8 },
    { kw: 'junior scientist', w: 8 },
    { kw: 'scientist', w: 8 },
    { kw: 'specialist', w: 8 },
    { kw: 'associate', w: 8 },
    { kw: 'lab technician', w: 5 },
    { kw: 'laboratory technician', w: 5 }
  ];

  for (const { kw, w } of levelKeywords) {
    if (text.includes(kw)) {
      dim3 += w;
    }
  }
  dim3 = Math.min(dim3, 20);

  let dim4 = 0;
  const opKeywords = [
    { kw: 'glp', w: 10 },
    { kw: 'good laboratory practice', w: 10 },
    { kw: 'gmp', w: 10 },
    { kw: 'qa/qc', w: 8 },
    { kw: 'qc biology', w: 8 },
    { kw: 'quality control', w: 8 },
    { kw: 'reproducibility', w: 6 },
    { kw: 'documentation', w: 5 },
    { kw: 'sop', w: 5 }
  ];

  for (const { kw, w } of opKeywords) {
    if (text.includes(kw)) {
      dim4 += w;
    }
  }
  dim4 = Math.min(dim4, 10);

  let boost = 0;
  if (/life science|biolog|biomed|biochem|biotech|pharmaceutical|health|medical|research|laborator|scientist/i.test(text)) {
    boost = 5;
  }
  const isIndustry = (sourceName === 'industry' || sourceName === 'novo' || text.includes('biotech') || text.includes('pharma') || text.includes('diagnostics'));
  if (isIndustry) {
    boost += 10;
  }

  let penalty = 0;
  if (dim1 === 0 && dim4 === 0) {
    const isRaOrTech = checkIsRATechTitle(title);
    if (isIndustry) {
      penalty = 0; 
    } else if (isRaOrTech && dim2 >= 15) {
      penalty = 0; 
    } else if (dim2 >= 20) {
      penalty = -10; 
    } else {
      penalty = -35; 
    }
  }

  const base = 25;
  const score = base + dim1 + dim2 + dim3 + dim4 + boost + penalty;
  return {
    score: Math.max(0, Math.min(Math.round(score), 100)),
    dim1, dim2, dim3, dim4, boost, penalty
  };
}

const sources = [
  { org: 'AstraZeneca', country: 'sweden', location: 'Gothenburg', url: 'https://careers.astrazeneca.com/search-jobs?location=Sweden&keywords=research+scientist+cell+biology+epigenetics', base: 'https://careers.astrazeneca.com', card: 'article, li[class*="job"], tr[class*="job"]', title: 'h2, h3, a', link: 'a[href*="/job/"], a[href]' },
  { org: 'Roche', country: 'switzerland', location: 'Basel', url: 'https://careers.roche.com/global/en/search-results?keywords=cell+culture+scientist&location=Basel', base: 'https://careers.roche.com', card: '.job-card, article, li', title: 'h2, h3, a', link: 'a[href]' },
  { org: 'Novartis', country: 'switzerland', location: 'Basel', url: 'https://www.novartis.com/careers/career-search?search=cell+biology+scientist&country=CH', base: 'https://www.novartis.com', card: 'article, li, tr', title: 'h2, h3, a', link: 'a[href]' },
  { org: 'BioNTech', country: 'germany', location: 'Mainz', url: 'https://biontech.wd3.myworkdayjobs.com/BNT/jobs?q=scientist+cell+biology', base: 'https://biontech.wd3.myworkdayjobs.com', card: '[data-automation-id*="job"], li, article', title: '[data-automation-id="jobTitle"], h2, h3, a', link: 'a[href*="/job/"], a[href]' },
  { org: 'Lonza', country: 'switzerland', location: 'Basel', url: 'https://lonza.wd3.myworkdayjobs.com/LonzaCareers/jobs?q=cell+biology+scientist', base: 'https://lonza.wd3.myworkdayjobs.com', card: '[data-automation-id*="job"], li, article', title: '[data-automation-id="jobTitle"], h2, h3, a', link: 'a[href*="/job/"], a[href]' },
  { org: 'Sartorius', country: 'germany', location: 'Göttingen', url: 'https://careers.sartorius.com/search/?q=cell+culture+scientist', base: 'https://careers.sartorius.com', card: 'article, li, .job-result', title: 'h2, h3, a', link: 'a[href]' },
  { org: 'Bayer AG', country: 'germany', location: 'Berlin', url: 'https://career.bayer.de/en/jobs?keywords=molecular+biology+toxicology', base: 'https://career.bayer.de', card: 'article, li, .job-result', title: 'h2, h3, a', link: 'a[href]' },
  { org: 'Thermo Fisher Scientific', country: 'sweden', location: 'Stockholm', url: 'https://jobs.thermofisher.com/global/en/sweden-jobs?keywords=scientist+cell+culture', base: 'https://jobs.thermofisher.com', card: 'article, li, .job-card', title: 'h2, h3, a', link: 'a[href]' }
];

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const src of sources) {
    console.log(`\nTesting ${src.org} at ${src.url.substring(0, 80)}...`);
    try {
      await page.goto(src.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      const html = await page.content();
      const $ = cheerio.load(html);
      const items = [];
      $(src.card).each((_, el) => {
        const title = $(el).find(src.title).first().text().trim();
        if (title) items.push(title);
      });
      console.log(`  Found ${items.length} items.`);
      if (items.length > 0) {
        console.log(`  Sample titles:`, items.slice(0, 5));
        let validCount = 0;
        for (const title of items) {
          if (!isGenericNavigationLink(title)) {
            const scoreRes = scoreJobMultiDimensional(title, '', 'industry');
            validCount++;
            if (validCount <= 3) {
              console.log(`    Valid job: "${title}" - Score: ${scoreRes.score}`, scoreRes);
            }
          }
        }
        console.log(`  Total valid jobs: ${validCount}`);
      }
    } catch (e) {
      console.error(`  Error scraping ${src.org}: ${e.message}`);
    }
  }

  await browser.close();
})();
