// ═══════════════════════════════════════════════════════════════════
// KAVYA JOB BOARD — REDESIGNED AI-CURATED opportunity ENGINE
// Supports: Verbose Diagnostic Logging & Circuit Breakers
// ═══════════════════════════════════════════════════════════════════

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── DEBUG MODE CONFIGURATION ────────────────────────────────────────────────
const DEBUG_MODE = process.argv.includes('--debug') || process.env.SCRAPER_DEBUG === 'true';

const REQUEST_TIMEOUT = 15000; 
const MAX_JOBS_PER_SOURCE = 30;
const MIN_SCORE_THRESHOLD = DEBUG_MODE ? 10 : 45; // lower in debug mode
const COOLDOWN_HOURS = DEBUG_MODE ? 0 : 12;      // disable in debug mode
const OFFLINE_RETRY_HOURS = DEBUG_MODE ? 0 : 48; // disable in debug mode

const STATE_FILE = path.join(process.cwd(), 'source-state.json');
const DB_FILE = path.join(process.cwd(), 'jobs-db.json');
const JS_FILE = path.join(process.cwd(), 'jobs-db.js');
const DIAGNOSTICS_FILE = path.join(process.cwd(), 'scraper-diagnostics.json');

const PLAYWRIGHT_TIMEOUT = Number(process.env.PLAYWRIGHT_TIMEOUT || 30000);
let chromium = null;
let playwrightChecked = false;
let browserPromise = null;

// Telemetry state
const metrics = {
  attemptedAt: new Date().toISOString(),
  debugModeActive: DEBUG_MODE,
  rejections: {
    lowScore: 0,
    disciplineExclude: 0,
    postdocExclude: 0,
    seniorExclude: 0,
    hardExclude: 0,
    deduplicated: 0,
    skippedCooldown: 0,
    malformedData: 0
  },
  categories: {
    phd: 0,
    postdoc: 0,
    researchAssistantOrTech: 0,
    industryScientist: 0,
    genericBiology: 0
  },
  multilingualMatches: 0,
  nicheHits: 0,
  glpHits: 0,
  sources: {},
  dedupExamples: []
};

// User-Agent and Anti-bot Headers
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

function getHeaders(url) {
  const host = new URL(url).hostname;
  return {
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': `https://www.google.com/search?q=${encodeURIComponent(host)}`,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  };
}

// ─── PLAYWRIGHT SEQUENTIAL QUEUE ──────────────────────────────────────────────
let activePlaywrightPages = 0;
const playwrightQueue = [];
const MAX_CONCURRENT_PLAYWRIGHT_PAGES = 2;

async function acquirePlaywrightSlot() {
  if (activePlaywrightPages < MAX_CONCURRENT_PLAYWRIGHT_PAGES) {
    activePlaywrightPages++;
    return;
  }
  return new Promise(resolve => playwrightQueue.push(resolve));
}

function releasePlaywrightSlot() {
  activePlaywrightPages--;
  if (playwrightQueue.length > 0) {
    activePlaywrightPages++;
    const next = playwrightQueue.shift();
    next();
  }
}

function getChromium() {
  if (playwrightChecked) return chromium;
  playwrightChecked = true;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.warn('  ⚠ Playwright not installed locally.');
    chromium = null;
  }
  return chromium;
}

async function getBrowser() {
  const pwChromium = getChromium();
  if (!pwChromium) return null;
  if (!browserPromise) {
    browserPromise = pwChromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  try {
    return await browserPromise;
  } catch (e) {
    browserPromise = null;
    console.warn(`  ⚠ Playwright browser launch failed: ${e.message}`);
    return null;
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (e) {
    console.warn(`  ⚠ Could not close Playwright: ${e.message}`);
  } finally {
    browserPromise = null;
  }
}

async function renderPageHtml(url, opts = {}) {
  await acquirePlaywrightSlot();
  let context;
  try {
    const browser = await getBrowser();
    if (!browser) return null;
    context = await browser.newContext({
      userAgent: getHeaders(url)['User-Agent'],
      locale: 'en-GB',
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en-US;q=0.9'
      }
    });
    const page = await context.newPage();
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeout || PLAYWRIGHT_TIMEOUT
    });
    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 10000 }).catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(opts.settleMs || 1000);
    return await page.content();
  } catch (e) {
    console.warn(`  ⚠ Playwright render failed [${url.substring(0, 70)}]: ${e.message}`);
    return null;
  } finally {
    if (context) await context.close().catch(() => {});
    releasePlaywrightSlot();
  }
}

async function parseProtectedPage(url, defaults, selectors, opts = {}) {
  const jobs = [];
  const html = await safeFetch(url);
  if (html) {
    jobs.push(...extractEmbeddedJobs(html, defaults));
    jobs.push(...parseHtmlCards(html, defaults, selectors));
  }
  const minRendered = opts.minRenderedFallback ?? 1;
  if (jobs.length >= minRendered) return jobs;

  console.log(`  ↳ Rendering protected page: ${url.substring(0, 70)}`);
  const renderedHtml = await renderPageHtml(url, {
    waitForSelector: opts.waitForSelector || selectors?.link || selectors?.card
  });
  if (!renderedHtml) return jobs;

  const renderedJobs = [
    ...extractEmbeddedJobs(renderedHtml, defaults),
    ...parseHtmlCards(renderedHtml, defaults, selectors)
  ];
  return deduplicateRawJobs([...jobs, ...renderedJobs]);
}

// ─── SAFE HTTP GET ────────────────────────────────────────────────────────────
async function safeFetch(url) {
  try {
    const res = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: getHeaders(url),
      maxRedirects: 4,
      validateStatus: status => status >= 200 && status < 300
    });
    return res.data;
  } catch (e) {
    const status = e.response?.status ? `HTTP ${e.response.status}` : e.message;
    console.warn(`  ⚠ Fetch failed [${url.substring(0, 70)}]: ${status}`);
    return null;
  }
}

// ─── DEDUPLICATION & NORMALIZATION ─────────────────────────────────────────────
function normalizeOrg(org) {
  let o = String(org || 'Unknown Organisation').toLowerCase();
  if (o.includes('karolinska')) return 'karolinska institutet';
  if (o.includes('uppsala')) return 'uppsala university';
  if (o.includes('lund')) return 'lund university';
  if (o.includes('copenhagen') || o.includes('københavn')) return 'university of copenhagen';
  if (o.includes('helsinki')) return 'university of helsinki';
  if (o.includes('turku')) return 'university of turku';
  if (o.includes('chalm')) return 'chalmers university';
  if (o.includes('stockholm')) return 'stockholm university';
  if (o.includes('utrecht')) return 'utrecht university';
  if (o.includes('leiden')) return 'leiden university';
  if (o.includes('amsterdam') && (o.includes('vu') || o.includes('vrije'))) return 'vu amsterdam';
  if (o.includes('amsterdam') && (o.includes('uva') || o.includes('university'))) return 'university of amsterdam';
  if (o.includes('erasmus')) return 'erasmus mc';
  if (o.includes('wageningen')) return 'wageningen university';
  if (o.includes('aarhus')) return 'aarhus university';
  if (o.includes('oslo')) return 'university of oslo';
  if (o.includes('ntnu')) return 'ntnu';
  if (o.includes('vienna') || o.includes('wien')) {
    if (o.includes('med')) return 'medical university of vienna';
    return 'university of vienna';
  }
  if (o.includes('toronto')) return 'university of toronto';
  if (o.includes('mcgill')) return 'mcgill university';
  if (o.includes('british columbia') || o.includes('ubc')) return 'university of british columbia';
  if (o.includes('basel')) return 'university of basel';
  if (o.includes('bern')) return 'university of bern';
  if (o.includes('zurich') || o.includes('eth')) return 'eth zurich';
  return o.replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanTitle(title) {
  let t = String(title || '').toLowerCase();
  const patterns = [
    /phd\s+(position|student|candidate|fellowship|fellow|project|scholarship|studies)\s+in/g,
    /doctoral\s+(position|student|candidate|fellowship|fellow|project|scholarship)\s+in/g,
    /phd\s+(position|student|candidate|fellowship|fellow|project|scholarship)/g,
    /doctoral\s+(position|student|candidate|fellowship|fellow|project|scholarship)/g,
    /postdoc(toral)?\s+(fellowship|fellow|position|project|student|researcher)/g,
    /research\s+(assistant|associate|engineer|fellow|officer)\s+in/g,
    /research\s+(assistant|associate|engineer|fellow|officer)/g,
    /early\s+stage\s+researcher/g,
    /msca\s+doctoral\s+fellowship/g,
    /marie\s+skłodowska-curie\s+doctoral\s+fellowship/g,
    /stipendiat\s+innen/g,
    /stipendiat/g,
    /doktorand/g,
  ];
  for (const p of patterns) {
    t = t.replace(p, '');
  }
  return t.replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getTokens(str) {
  return new Set(str.split(' ').filter(w => w.length > 2));
}

function tokenSimilarity(str1, str2) {
  const tokens1 = getTokens(str1);
  const tokens2 = getTokens(str2);
  if (tokens1.size === 0 || tokens2.size === 0) return 0;
  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }
  return intersection / (tokens1.size + tokens2.size - intersection);
}

function fingerprint(title, org) {
  const cleaned = cleanTitle(title);
  // If cleanTitle strips it completely, fall back to the normalized original title
  const finalTitle = cleaned.length > 0 ? cleaned : String(title || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${normalizeOrg(org)}||${finalTitle}`;
}

// ─── EXCLUSIONS LISTS ────────────────────────────────────────────────────────
const DISCIPLINE_EXCLUDES = [
  'number theory', 'mathematics', 'algebraic', 'topology', 'combinatorics',
  'graph theory', 'calculus', 'statistics', 'mathematical model',
  'astrophysics', 'astronomy', 'astrobiology', 'cosmology', 'quantum',
  'particle physics', 'nuclear physics', 'optics', 'photonics',
  'condensed matter', 'plasma physics', 'geology', 'geophysics', 'hydrology',
  'oceanography', 'atmospheric science', 'climatology', 'groundwater',
  'electrical engineering', 'mechanical engineering', 'civil engineering',
  'aerospace engineering', 'chemical engineering', 'materials science',
  'robotics', 'philosophy', 'sociology', 'anthropology', 'archaeology',
  'linguistics', 'literature', 'political science', 'economics',
  'health economics', 'epidemiology', 'public health',
  'marine ecology', 'fisheries', 'aquaculture', 'forest ecology',
  'computer science', '6g ', 'cybersecurity', 'human-computer interaction',
  // Engineering / Materials / Physics False Positives
  'nanofiltration', 'electrodialysis', 'photocatalytic membrane', 'membrane filtration',
  'electrochemical', 'catalyst ink', 'water-driven materials', 'high-entropy-alloy',
  'nuclear structural', 'ion-irradiated', 'hpc/gpu computing', 'gpu computing',
  'bubble dynamics', 'water electrolysis', 'hydrogen production', 'water treatment',
  'test and reliability', 'gs-imtr'
];

const POSTDOC_EXCLUDES = [
  'postdoctoral', 'postdoc', 'post-doctoral', 'post-doc', 'postdoctorate',
  'postdoktor', 'postdoktoral', 'postdoktorand', 'forskarassistent',
  'forskardoktor', 'bitrdande forskare', 'forsker', 'tutkijatohtori',
  'yliopistotutkija', 'postdoctorant', 'chercheur postdoctoral', 'postdottorato',
  'wissenschaftliche*r mitarbeiter*in postdoc', 'marie curie postdoctoral',
  'erc postdoctoral', 'postdoc-fellow', 'postdoktorandenstelle', 'forskare',
  'postdok'
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

  // Handle ambiguous titles containing "Wissenschaftlicher Mitarbeiter" in German
  if (t.includes('wissenschaftlicher mitarbeiter') || t.includes('wissenschaftliche mitarbeiterin') || t.includes('wissenschaftliche mitarbeitende')) {
    if (desc.includes('promotion abgeschlossen') || 
        desc.includes('abgeschlossene promotion') || 
        desc.includes('promotion vorausgesetzt') ||
        desc.includes('phd required') || 
        desc.includes('phd completion') || 
        desc.includes('postdoc') ||
        desc.includes('dr. rer. nat.') ||
        desc.includes('promoviert')) {
      return { type: 'postdocExclude', match: 'wissenschaftlicher mitarbeiter (postdoc)' };
    }
  }

  // Handle generic English titles that are postdocs (e.g. Research Associate / Researcher / Fellow)
  const isAmbiguousTitle = t.includes('researcher') || t.includes('research associate') || t.includes('research fellow') || t.includes('fellow');
  if (isAmbiguousTitle) {
    if (desc.includes('phd required') || desc.includes('ph.d. required') || desc.includes('completed phd') || desc.includes('doctoral degree required')) {
      return { type: 'postdocExclude', match: 'research associate (phd required)' };
    }
  }

  return null;
}

function checkIsPostdocTitle(title) {
  const t = String(title || '').toLowerCase();
  for (const x of POSTDOC_EXCLUDES) {
    if (t.includes(x)) return true;
  }
  return false;
}

function checkIsRATechTitle(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('assistant') || t.includes('technician') || t.includes('engineer') || t.includes('assistent') || t.includes('tekniker');
}

function checkIsIndustryScientistTitle(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('scientist') || t.includes('researcher') || t.includes('forskare') || t.includes('utvecklare');
}

function isGenericNavigationLink(title) {
  const t = String(title || '').trim().toLowerCase();
  
  // Too short to be a real job title
  if (t.length < 8) return true;

  // Exact matches for common navigation/UI elements
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
    'our purpose - code of conduct',
    // Pharma-site specific navigation items (from Roche, Novartis, etc.)
    'why join us', 'inclusion & belonging', 'our locations', 'job search', 'view role',
    'international', 'americas', 'asia pacific', 'europe', 'middle east & africa',
    'see all jobs', 'load more', 'show more', 'back to top', 'view all jobs',
    'no results found', 'jobs found', 'search again', 'refine search',
    'employee benefits', 'life at roche', 'life at novartis', 'life at bayer',
    'explore jobs', 'find jobs', 'join our team', 'be part of', 'work with us',
    'apply here', 'submit application', 'job alerts', 'talent network',
    'our culture', 'diversity', 'benefits', 'locations'
  ]);
  
  if (exactMenuTitles.has(t)) return true;
  
  // Substring matches for obvious menu elements
  const menuSubstrings = [
    'cookie settings', 'privacy policy', 'terms of use', 'terms & conditions', 
    'social media community', 'community guidelines', 'sort ascending', 'sort descending',
    'no jobs found', 'no results', 'results found', 'load more jobs'
  ];
  for (const sub of menuSubstrings) {
    if (t.includes(sub)) return true;
  }
  
  // Geographic region names often scraped as "jobs" from pharma sites
  const regionOnly = new Set(['north america', 'latin america', 'emea', 'apac', 'china', 
    'japan', 'australia', 'africa', 'south america']);
  if (regionOnly.has(t)) return true;
  
  return false;
}

function classifyRoleType(title, text) {
  const t = String(title || '').toLowerCase();
  const tx = String(text || '').toLowerCase();

  if (t.includes('phd') || t.includes('doctoral') || t.includes('doktorand') || t.includes('stipendiat') || t.includes('promovendus') || t.includes('aio')) {
    return 'phd';
  }
  if (t.includes('qa') || t.includes('qc') || t.includes('quality assurance') || t.includes('quality control') || t.includes('glp') || t.includes('gmp') || t.includes('compliance') || t.includes('validation')) {
    return 'qa-qc';
  }
  if (t.includes('technician') || t.includes('tekniker') || t.includes('laborant') || t.includes('lab assistant') || t.includes('laboratory assistant')) {
    return 'technician';
  }
  if (t.includes('research assistant') || t.includes('forskningsassistent') || t.includes('project assistant') || t.includes('projektassistent') || t.includes('lab engineer') || t.includes('laboratorieingenjör')) {
    return 'research-assistant';
  }
  
  const isScientist = t.includes('scientist') || t.includes('researcher') || t.includes('forskar') || t.includes('forsker') || t.includes('wissenschaftlicher mitarbeiter') || t.includes('wissenschaftliche mitarbeiterin');
  const isCorporate = tx.includes('biotech') || tx.includes('pharma') || tx.includes('industry') || tx.includes('corporat') || tx.includes('novartis') || tx.includes('astrazeneca') || tx.includes('roche') || tx.includes('novo nordisk') || tx.includes('biontech');
  
  if (isScientist) {
    if (isCorporate) return 'industry-scientist';
    return 'junior-scientist';
  }

  if (isCorporate) return 'industry-scientist';
  return 'research-assistant'; 
}

function classifyDomain(title, text) {
  const t = (String(title) + ' ' + String(text || '')).toLowerCase();

  if (t.includes('stem cell') || t.includes('stamcell') || t.includes('pluripotent') || t.includes('hesc') || t.includes('mesc') || t.includes('embryonic stem')) {
    return 'stem-cell';
  }
  if (t.includes('epigenet') || t.includes('methylation') || t.includes('metylering') || t.includes('methylierung') || t.includes('pyrosequencing') || t.includes('bisulfite')) {
    return 'epigenetics';
  }
  // Swedish collision safeguard: 'giften' (poisons) should not match 'uppgiften' (the task) or 'utgiften' (the expense)
  const hasGenuineGiften = t.includes('giften') && !t.includes('uppgiften') && !t.includes('utgiften');
  if (t.includes('toxic') || t.includes('disruptor') || hasGenuineGiften || t.includes('hazard') || t.includes('adme') || t.includes('cytotoxicity')) {
    return 'toxicology';
  }
  if (t.includes('neuro') || t.includes('brain') || t.includes('sh-sy5y') || t.includes('degeneration') || t.includes('alzheimer') || t.includes('parkinson') || t.includes('forebrain') || t.includes('dorsal forebrain')) {
    return 'neurobiology';
  }
  return 'generic-biology';
}

function scoreJobMultiDimensional(title, description, sourceName) {
  const excl = checkExclusionReason(title, description);
  if (excl && !DEBUG_MODE) {
    return { score: -1, matchedMultilingual: false, nicheHit: false, glpHit: false };
  }
  
  const text = (String(title) + ' ' + String(description || '')).toLowerCase();
  
  // Double check body text for hard exclusions
  for (const x of HARD_EXCLUDES) {
    if (text.includes(x) && !DEBUG_MODE) {
      return { score: -1, matchedMultilingual: false, nicheHit: false, glpHit: false };
    }
  }

  // Swedish collision safeguard helper
  const hasKeyword = (srcText, kw) => {
    if (kw === 'giften') {
      let idx = srcText.indexOf('giften');
      while (idx !== -1) {
        const isUppgiften = idx >= 3 && srcText.substring(idx - 3, idx + 6) === 'uppgiften';
        const isUtgiften = idx >= 2 && srcText.substring(idx - 2, idx + 6) === 'utgiften';
        if (!isUppgiften && !isUtgiften) return true;
        idx = srcText.indexOf('giften', idx + 1);
      }
      return false;
    }
    return srcText.includes(kw);
  };

  let matchedMultilingual = false;

  // Dimension 1: Niche Domain Match (Max: 45)
  let dim1 = 0;
  const nicheKeywords = [
    // Developmental Epigenomics / Epigenetics / Methylation
    { kw: 'developmental epigenomics', w: 45 },
    { kw: 'developmental epigenetics', w: 45 },
    { kw: 'environmental epigenetics', w: 40 },
    { kw: 'dna methylation', w: 35 },
    { kw: 'dna-metylering', w: 35, multi: true },
    { kw: 'dna-methylierung', w: 35, multi: true },
    { kw: 'pyrosequencing', w: 35 },
    { kw: 'epigenetic', w: 20 },
    { kw: 'epigenomics', w: 20 },
    { kw: 'epigenetik', w: 20, multi: true },
    { kw: 'epigenetisk', w: 20, multi: true },
    { kw: 'epigenetische', w: 20, multi: true },
    { kw: 'epigenetica', w: 20, multi: true },
    { kw: 'epigenetikk', w: 20, multi: true },
    { kw: 'epigenetiikka', w: 20, multi: true },
    { kw: 'methylation', w: 25 },
    { kw: 'metylering', w: 25, multi: true },
    { kw: 'methylierung', w: 25, multi: true },
    { kw: 'metylaatio', w: 25, multi: true },

    // Environmental / Molecular Toxicology / Endocrine Disruptors / Toxins / Pesticides
    { kw: 'environmental toxicology', w: 40 },
    { kw: 'endocrine disruptor', w: 40 },
    { kw: 'endocrine disrupt', w: 40 },
    { kw: 'molecular toxicology', w: 35 },
    { kw: 'neurotoxicology', w: 35 },
    { kw: 'toxicology', w: 20 },
    { kw: 'toxikologi', w: 20, multi: true },
    { kw: 'toxikologisk', w: 20, multi: true },
    { kw: 'toxikologie', w: 20, multi: true },
    { kw: 'toxikologischen', w: 20, multi: true },
    { kw: 'toxicologie', w: 20, multi: true },
    { kw: 'toksikologi', w: 20, multi: true },
    { kw: 'toksikologia', w: 20, multi: true },
    { kw: 'miljötoxikologi', w: 30, multi: true },
    { kw: 'umwelttoxikologie', w: 30, multi: true },
    { kw: 'parkinson', w: 35 },
    { kw: 'alzheimer', w: 35 },
    { kw: 'huntington', w: 35 },
    { kw: 'dementia', w: 25 },
    { kw: 'pesticide', w: 30 },
    { kw: 'pesticides', w: 30 },
    { kw: 'pestizid', w: 30, multi: true },
    { kw: 'pestizide', w: 30, multi: true },
    { kw: 'bestrijdingsmiddel', w: 30, multi: true },
    { kw: 'bestrijdingsmiddelen', w: 30, multi: true },
    { kw: 'bekämpningsmedel', w: 30, multi: true },
    { kw: 'torjunta-aine', w: 30, multi: true },
    { kw: 'toxin', w: 25 },
    { kw: 'toxins', w: 25 },
    { kw: 'giften', w: 25, multi: true },
    { kw: 'giftstoffe', w: 25, multi: true },
    { kw: 'myrkky', w: 25, multi: true },
    { kw: 'toxic', w: 20 },
    { kw: 'toxicity', w: 20 },
    { kw: 'toxicant', w: 20 },
    { kw: 'toxicants', w: 20 },
    { kw: 'toxische', w: 20, multi: true },
    { kw: 'toxisch', w: 20, multi: true },
    { kw: 'toxizität', w: 20, multi: true },
    { kw: 'myrkyllisyys', w: 20, multi: true },

    // Stem-Cell Differentiation / Culture
    { kw: 'stem cell differentiation', w: 40 },
    { kw: 'stem-cell differentiation', w: 40 },
    { kw: 'hesc', w: 30 },
    { kw: 'mesc', w: 30 },
    { kw: 'embryonic stem', w: 30 },
    { kw: 'pluripotent', w: 15 },
    { kw: 'stem cell', w: 15 },
    { kw: 'stamcell', w: 15, multi: true },
    { kw: 'stamceller', w: 15, multi: true },
    { kw: 'stammzelle', w: 15, multi: true },
    { kw: 'stammzellen', w: 15, multi: true },
    { kw: 'stamcellen', w: 15, multi: true },
    { kw: 'stamcelle', w: 15, multi: true },
    { kw: 'kantasolu', w: 15, multi: true },
    { kw: 'kantasolujen', w: 15, multi: true },
    { kw: 'pluripotenta', w: 15, multi: true },
    { kw: 'pluripotente', w: 15, multi: true },

    // Neurodevelopment / Neurodegeneration Disease Modeling
    { kw: 'dorsal forebrain differentiation', w: 35 },
    { kw: 'dorsal forebrain', w: 35 },
    { kw: 'neurodevelopment', w: 40 },
    { kw: 'neurodegeneration', w: 30 },
    { kw: 'neurodegenerative', w: 30 },
    { kw: 'neurodegenerativ', w: 30, multi: true },
    { kw: 'neurodegenerativen', w: 30, multi: true },
    { kw: 'neurodegeneratie', w: 30, multi: true },
    { kw: 'neurodegenerasjon', w: 30, multi: true },
    { kw: 'neurodegeneraatio', w: 30, multi: true },
    { kw: 'sh-sy5y', w: 35 },
    { kw: 'caco-2', w: 35 },
    { kw: 'caco2', w: 35 },
    
    // Industry Curation Boosting
    { kw: 'assay development', w: 25 },
    { kw: 'translational science', w: 20 },
    { kw: 'molecular diagnostics', w: 20 },
    { kw: 'in vitro assays', w: 20 },
    { kw: 'cell-based assay', w: 20 },
    { kw: 'cell-based assays', w: 20 },
    { kw: 'automation biology', w: 15 },
    { kw: 'bioanalytics', w: 15 },
    { kw: 'analytical development', w: 15 },
    { kw: 'cell culture scientist', w: 15 },

    // Immunology & Oncology / Cancer Biology
    { kw: 'immunology', w: 35 },
    { kw: 'immunological', w: 30 },
    { kw: 'immunotherapy', w: 35 },
    { kw: 'car-t', w: 35 },
    { kw: 'car t', w: 35 },
    { kw: 'antibody', w: 25 },
    { kw: 'antibodies', w: 25 },
    { kw: 'antigen', w: 25 },
    { kw: 'oncology', w: 35 },
    { kw: 'cancer', w: 30 },
    { kw: 'tumor', w: 25 },
    { kw: 'tumour', w: 25 },
    
    // Multilingual Immunology & Oncology
    { kw: 'immunologie', w: 35, multi: true },
    { kw: 'immunologi', w: 35, multi: true },
    { kw: 'immuntherapie', w: 35, multi: true },
    { kw: 'onkologie', w: 35, multi: true },
    { kw: 'onkologi', w: 35, multi: true },
    { kw: 'tumorbiologie', w: 30, multi: true },
    { kw: 'krebs', w: 30, multi: true },
    { kw: 'kanker', w: 30, multi: true }
  ];

  for (const { kw, w, multi } of nicheKeywords) {
    if (hasKeyword(text, kw)) {
      dim1 += w;
      if (multi) matchedMultilingual = true;
    }
  }
  dim1 = Math.min(dim1, 45);

  // Dimension 2: Methodology Match (Max: 25)
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
    { kw: 'western blot', w: 7 },
    
    // Multilingual methods
    { kw: 'cellodling', w: 10, multi: true },
    { kw: 'cellkultur', w: 10, multi: true },
    { kw: 'zellkultur', w: 10, multi: true },
    { kw: 'zellkulturen', w: 10, multi: true },
    { kw: 'celkweek', w: 10, multi: true },
    { kw: 'cellekultur', w: 10, multi: true },
    { kw: 'soluviljely', w: 10, multi: true },
    { kw: 'mikroskopie', w: 15, multi: true },
    { kw: 'differenzierung', w: 10, multi: true },
    { kw: 'microscopie', w: 15, multi: true },
    { kw: 'differentiatie', w: 10, multi: true },
    { kw: 'mikroskopi', w: 15, multi: true },
    { kw: 'differentiering', w: 10, multi: true },
    { kw: 'mikroskopia', w: 15, multi: true },
    { kw: 'differentiaatio', w: 10, multi: true }
  ];

  for (const { kw, w, multi } of methodKeywords) {
    if (hasKeyword(text, kw)) {
      dim2 += w;
      if (multi) matchedMultilingual = true;
    }
  }
  dim2 = Math.min(dim2, 25);

  // Dimension 3: Level & Logistics Match (Max: 20)
  let dim3 = 0;
  const levelKeywords = [
    { kw: 'marie curie', w: 20 },
    { kw: 'msca', w: 20 },
    { kw: 'phd', w: 10 },
    { kw: 'doctoral', w: 10 },
    { kw: 'doktorand', w: 10, multi: true },
    { kw: 'stipendiat', w: 10, multi: true },
    { kw: 'promovendus', w: 10, multi: true },
    { kw: 'aio', w: 10, multi: true },
    { kw: 'research assistant', w: 8 },
    { kw: 'research engineer', w: 8 },
    { kw: 'forskningsassistent', w: 8, multi: true },
    { kw: 'associate scientist', w: 8 },
    { kw: 'junior scientist', w: 8 },
    { kw: 'scientist', w: 8 },
    { kw: 'specialist', w: 8 },
    { kw: 'associate', w: 8 },
    { kw: 'lab technician', w: 5 },
    { kw: 'laboratory technician', w: 5 },
    { kw: 'wissenschaftlicher mitarbeiter', w: 8, multi: true },
    { kw: 'wissenschaftliche mitarbeiterin', w: 8, multi: true }
  ];

  for (const { kw, w, multi } of levelKeywords) {
    if (hasKeyword(text, kw)) {
      dim3 += w;
      if (multi) matchedMultilingual = true;
    }
  }
  dim3 = Math.min(dim3, 20);

  // Dimension 4: Operational & GLP Match (Max: 10)
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
    { kw: 'sop', w: 5 },
    
    // Multilingual operational
    { kw: 'dokumentation', w: 5, multi: true },
    { kw: 'dokumentasjon', w: 5, multi: true },
    { kw: 'documentatie', w: 5, multi: true },
    { kw: 'dokumentointi', w: 5, multi: true },
    { kw: 'kvalitetssäkring', w: 8, multi: true },
    { kw: 'qualitätssicherung', w: 8, multi: true },
    { kw: 'kwaliteitscontrole', w: 8, multi: true },
    { kw: 'laadunvalvonta', w: 8, multi: true }
  ];

  for (const { kw, w, multi } of opKeywords) {
    if (hasKeyword(text, kw)) {
      dim4 += w;
      if (multi) matchedMultilingual = true;
    }
  }
  dim4 = Math.min(dim4, 10);

  // Context boost for life sciences
  let boost = 0;
  if (/life science|biolog|biomed|biochem|biotech|pharmaceutical|health|medical|research|laborator|scientist/i.test(text)) {
    boost = 5;
  }
  const isIndustry = (sourceName === 'industry' || sourceName === 'novo' || text.includes('biotech') || text.includes('pharma') || text.includes('diagnostics'));
  if (isIndustry) {
    boost += 10;
  }

  // Anti-Generic Penalty & Industry Exemptions/Waivers
  let penalty = 0;
  if (dim1 === 0 && dim4 === 0) {
    const isIndustry = (sourceName === 'industry' || sourceName === 'novo' || text.includes('biotech') || text.includes('pharma') || text.includes('diagnostics'));
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
    matchedMultilingual,
    nicheHit: dim1 > 0,
    glpHit: dim4 > 0
  };
}

function tierFromScore(score) {
  return score >= 76 ? 'high' : score >= 58 ? 'medium' : 'stretch';
}

function typeFromText(text) {
  const t = text.toLowerCase();
  const phdTerms = ['phd', 'ph.d', 'doctoral', 'doctorate', 'doktorand', 'stipendiat', 'promovendus', 'aio'];
  for (const term of phdTerms) {
    if (t.includes(term)) return 'phd';
  }
  return 'industry';
}

// ─── TIERED DEDUPLICATION SYSTEM ─────────────────────────────────────────────
const SOURCE_TIERS = {
  'swedish': 1, 'dutch': 1, 'danish': 1, 'embl': 1, 'novo': 1, 'industry': 1, 'norway': 1, 'finland': 1, 'austria': 1,
  'euraxess': 2,
  'nature': 3, 'academicpos': 3, 'findaphd': 3,
  'default': 4
};

function getSourceTier(src) {
  return SOURCE_TIERS[src] || SOURCE_TIERS.default;
}

function deduplicateJobsTiered(jobsArr) {
  const groups = new Map();
  for (const j of jobsArr) {
    const fp = j._fp || fingerprint(j.title, j.org);
    let foundFp = null;
    for (const existingFp of groups.keys()) {
      const [existingOrg, existingTitle] = existingFp.split('||');
      const [currOrg, currTitle] = fp.split('||');
      
      const existingJobGroup = groups.get(existingFp);
      const firstExistingJob = existingJobGroup[0];
      if (firstExistingJob && firstExistingJob.type !== j.type) {
        continue;
      }
      
      if (existingOrg === currOrg && existingTitle.trim().length > 0 && currTitle.trim().length > 0) {
        if (tokenSimilarity(existingTitle, currTitle) > 0.7) {
          foundFp = existingFp;
          break;
        }
      }
    }
    const key = foundFp || fp;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(j);
  }

  const out = [];
  for (const groupJobs of groups.values()) {
    groupJobs.sort((a, b) => {
      const tierA = getSourceTier(a.sourceName);
      const tierB = getSourceTier(b.sourceName);
      if (tierA !== tierB) return tierA - tierB;
      return (b.score || 0) - (a.score || 0);
    });
    
    // Save telemetry logs for duplicates
    if (groupJobs.length > 1) {
      for (let i = 1; i < groupJobs.length; i++) {
        metrics.rejections.deduplicated++;
        metrics.dedupExamples.push({
          retained: { title: groupJobs[0].title, org: groupJobs[0].org, sourceName: groupJobs[0].sourceName, tier: getSourceTier(groupJobs[0].sourceName) },
          merged: { title: groupJobs[i].title, org: groupJobs[i].org, sourceName: groupJobs[i].sourceName, tier: getSourceTier(groupJobs[i].sourceName) },
          similarity: tokenSimilarity(cleanTitle(groupJobs[0].title), cleanTitle(groupJobs[i].title)),
          normalizedRetained: fingerprint(groupJobs[0].title, groupJobs[0].org),
          normalizedMerged: fingerprint(groupJobs[i].title, groupJobs[i].org)
        });
      }
    }
    out.push(groupJobs[0]);
  }
  return out;
}

// ─── OPTIONAL GEMINI AI CURATION LAYER ─────────────────────────────────────────
async function refineWithGemini(jobs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (DEBUG_MODE) console.log('  ℹ GEMINI_API_KEY not set. Using rule-based matrix curation.');
    return jobs;
  }

  console.log(`\n🤖 Waking Gemini Curation Layer to evaluate top candidates...`);
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const refinedJobs = [];

  const rulesSorted = [...jobs].sort((a, b) => (b.score || 0) - (a.score || 0));
  const toRefine = rulesSorted.slice(0, 5);
  const remaining = rulesSorted.slice(5);

  for (let i = 0; i < toRefine.length; i++) {
    const job = toRefine[i];
    const prompt = `You are a career matching AI for Kavya, a researcher with a unique profile:
- Core strengths: developmental epigenomics, DNA methylation, pyrosequencing, hESC/mESC culture, dorsal forebrain differentiation, SH-SY5Y and Caco-2 models, immunofluorescence, molecular toxicology, endocrine disruptors, neurodegeneration disease modeling.
- Experience: 3 years QA/QC industry experience, GLP compliance, documentation standards, teaching/mentoring.

Analyze if the following job listing is a good fit for her.
Job Title: "${job.title}"
Organization: "${job.org}"
Job Description Summary: "${job.description ? job.description.substring(0, 1500) : 'No description available.'}"

Return a JSON object with these exact keys:
- "isMatch": boolean (false if it is a postdoc requiring completed PhD, senior professor, or out of field)
- "refinedScore": integer (0-100, adjusting the base score based on alignment. Core matches get >75, general bio gets 55-75, stretch <55)
- "why": string (max 140 characters, explaining the personal fit reasoning, e.g. "Fits your experience with Caco-2 models and molecular toxicology.")
- "suggestedTier": string ("high" | "medium" | "stretch")`;

    let attempts = 0;
    const maxAttempts = 3;
    let delay = 3000; // Start with 3s delay
    let success = false;

    while (attempts < maxAttempts && !success) {
      try {
        attempts++;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await axios.post(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        }, { timeout: 30000 });

        if (res.data && res.data.candidates && res.data.candidates[0].content.parts[0].text) {
          const rawText = res.data.candidates[0].content.parts[0].text.trim();
          let result;
          try {
            result = JSON.parse(rawText);
          } catch (jsonErr) {
            // Fallback: Check if response has markdown wrapper ```json ... ```
            const match = rawText.match(/```json\s*([\s\S]*?)\s*```/);
            if (match) {
              result = JSON.parse(match[1].trim());
            } else {
              throw jsonErr;
            }
          }

          if (result.isMatch) {
            job.score = Math.max(0, Math.min(Math.round(result.refinedScore), 100));
            job.why = String(result.why).substring(0, 150);
            job.tier = result.suggestedTier || tierFromScore(job.score);
            refinedJobs.push(job);
            if (DEBUG_MODE) console.log(`   [AI Match] ${job.title.substring(0, 45)}... Score: ${job.score} (Why: ${job.why})`);
          } else {
            metrics.rejections.lowScore++;
            if (DEBUG_MODE) console.log(`   [AI Exclude] ${job.title.substring(0, 45)}... (Reason: Failed match criteria)`);
          }
          success = true;
        } else {
          throw new Error("Empty response");
        }
      } catch (e) {
        const status = e.response ? e.response.status : null;
        const isRateLimit = status === 429;
        const isServerError = status === 503;
        const isTimeout = e.code === 'ECONNABORTED' || e.message.includes('timeout');

        if (attempts < maxAttempts && (isRateLimit || isServerError || isTimeout)) {
          console.warn(`   ⚠️ Gemini call attempt ${attempts} failed for "${job.title.substring(0, 25)}" (${status || e.message}). Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          delay *= 2; // Exponential backoff
        } else {
          // Fall back to rule-based score
          console.warn(`   ⚠ Gemini call failed for "${job.title.substring(0, 25)}" after ${attempts} attempts: ${e.message}. Falling back to rule-based score.`);
          refinedJobs.push(job);
          success = true; // Exit loop
        }
      }
    }
    // Add a small spacer delay between successive job queries to respect rate limits
    if (i < toRefine.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return [...refinedJobs, ...remaining];
}

// ─── SOURCE HELPERS ───────────────────────────────────────────────────────────
function buildJob(raw, source) {
  // Telemetry: increment raw logs
  if (!metrics.sources[source]) {
    metrics.sources[source] = { raw: 0, cleaned: 0, scored: 0, excluded: 0, retained: 0 };
  }
  metrics.sources[source].raw++;

  // Malformed / Generic Link check
  if (!raw.title || raw.title.length < 6 || isGenericNavigationLink(raw.title)) {
    metrics.rejections.malformedData++;
    return null;
  }
  metrics.sources[source].cleaned++;

  // Exclusion check (for metrics logging)
  const excl = checkExclusionReason(raw.title, raw.description || '');
  if (excl) {
    metrics.rejections[excl.type]++;
    metrics.sources[source].excluded++;
    if (!DEBUG_MODE) return null; // Drop immediately unless in debug mode
  }

  // Scoring (passing the source so we can waive penalty for industry sources)
  const scoreResult = scoreJobMultiDimensional(raw.title, raw.description || '', source);
  const score = scoreResult.score;
  // Industry sources use a slightly lower threshold (40 vs 45) since real biotech
  // job titles may use methodology keywords but not niche epigenomics/toxicology terms
  const isIndustrySource = (source === 'industry' || source === 'novo');
  const threshold = DEBUG_MODE ? 10 : (isIndustrySource ? 40 : MIN_SCORE_THRESHOLD);

  if (scoreResult.matchedMultilingual) metrics.multilingualMatches++;
  if (scoreResult.nicheHit) metrics.nicheHits++;
  if (scoreResult.glpHit) metrics.glpHits++;

  if (score < threshold) {
    metrics.rejections.lowScore++;
    if (!DEBUG_MODE) return null; // Drop immediately unless in debug mode
  }
  metrics.sources[source].scored++;

  const country = raw._forcedCountry || resolveCountry(raw.country || raw.location);
  if (!country) {
    metrics.rejections.disciplineExclude++; // Filter out region-excluded positions
    metrics.sources[source].excluded++;
    if (!DEBUG_MODE) return null; // Drop immediately unless in debug mode
  }
  const tier    = tierFromScore(score);

  // Classifications
  const roleType = classifyRoleType(raw.title, raw.description || '');
  const domain = classifyDomain(raw.title, raw.description || '');
  const sourceType = (source === 'industry' || source === 'novo') ? 'industry' : 'academic';
  
  // Clean type categorization (phd vs industry) to power toggle buttons
  const finalType = (sourceType === 'industry' || roleType === 'industry-scientist' || roleType === 'qa-qc') ? 'industry' : 'phd';

  // Track career level counts in metrics
  if (finalType === 'phd') metrics.categories.phd++;
  else if (checkIsPostdocTitle(raw.title)) metrics.categories.postdoc++;
  else if (checkIsRATechTitle(raw.title)) metrics.categories.researchAssistantOrTech++;
  else if (checkIsIndustryScientistTitle(raw.title)) metrics.categories.industryScientist++;
  else metrics.categories.genericBiology++;

  const why = raw.description && raw.description.length >= 60
    ? raw.description.replace(/\s+/g, ' ').trim().substring(0, 160) + '…'
    : `Scraped from ${source}. Rule-based score: ${score} matches Kavya's profile keywords.`;

  const id = `${source}-${fingerprint(raw.title, raw.org).replace(/[^a-z0-9]/g, '-').substring(0, 48)}`;

  metrics.sources[source].retained++;

  let portal = 'Other';
  const orgName = raw.org || '';
  if (source === 'swedish') {
    if (orgName === 'SciLifeLab') portal = 'SciLifeLab';
    else portal = 'Varbi (Sweden)';
  }
  else if (source === 'norway') portal = 'Jobbnorge (Norway)';
  else if (source === 'dutch') portal = 'AcademicTransfer (Netherlands)';
  else if (source === 'germany') portal = 'DAAD (Germany)';
  else if (source === 'danish') portal = 'Danish Portals';
  else if (source === 'embl') portal = 'Workday API';
  else if (source === 'industry') {
    if (orgName.includes('AstraZeneca')) portal = 'AstraZeneca Careers';
    else if (orgName.includes('Illumina') || orgName.includes('Lonza') || orgName.includes('BioNTech')) portal = 'Workday API';
    else portal = 'Industry Careers';
  }
  else if (source === 'euraxess') portal = 'Euraxess';
  else if (source === 'academicpos') portal = 'Academic Positions';
  else if (source === 'nature') portal = 'Nature Careers';
  else if (source === 'findaphd') portal = 'FindAPhD';
  else if (source === 'novo') portal = 'Novo Nordisk Careers';
  else if (source === 'resteurope') portal = 'Max Planck / German Portals';
  else if (source === 'finland') portal = 'Finland Portals';
  else if (source === 'austria') portal = 'Austria Portals';
  else if (source === 'canada') portal = 'Canada Portals';
  else if (source === 'singapore') portal = 'Singapore Portals';
  else if (source === 'australia') portal = 'Australia Portals';

  return {
    id,
    country: country || 'unknown',
    tier,
    type: finalType,
    org: raw.org || 'Unknown Organisation',
    score,
    title: raw.title,
    tags: buildTags(raw.title, raw.org, country || 'sweden', raw.location),
    why,
    deadline: raw.deadline || '📅 Rolling',
    deadlineWarn: raw.deadlineWarn || false,
    url: raw.url || '#',
    source: 'live',
    sourceName: source,
    portal,
    fetchedAt: new Date().toISOString(),
    dateFound: new Date().toISOString(),
    _fp: fingerprint(raw.title, raw.org),
    roleType,
    domain,
    sourceType,
  };
}

const COUNTRY_MAP = {
  'sweden': 'sweden', 'se': 'sweden', 'svenska': 'sweden',
  'netherlands': 'netherlands', 'nl': 'netherlands', 'holland': 'netherlands',
  'denmark': 'denmark', 'dk': 'denmark', 'danish': 'denmark',
  'germany': 'germany', 'de': 'germany', 'deutschland': 'germany',
  'belgium': 'belgium', 'be': 'belgium',
  'switzerland': 'switzerland', 'ch': 'switzerland',
  'luxembourg': 'luxembourg', 'lu': 'luxembourg',
  'norway': 'norway', 'no': 'norway', 'norge': 'norway',
  'finland': 'finland', 'fi': 'finland', 'suomi': 'finland',
  'austria': 'austria', 'at': 'austria', 'österreich': 'austria',
  'canada': 'canada', 'ca': 'canada',
  'singapore': 'singapore', 'sg': 'singapore',
  'australia': 'australia', 'au': 'australia',
};

const CITY_COUNTRY_MAP = {
  'gothenburg': 'sweden', 'stockholm': 'sweden', 'uppsala': 'sweden', 'lund': 'sweden', 'umea': 'sweden', 'linkoping': 'sweden', 'solna': 'sweden',
  'amsterdam': 'netherlands', 'utrecht': 'netherlands', 'leiden': 'netherlands', 'rotterdam': 'netherlands', 'groningen': 'netherlands', 'wageningen': 'netherlands', 'delft': 'netherlands', 'eindhoven': 'netherlands', 'nijmegen': 'netherlands', 'maastricht': 'netherlands',
  'copenhagen': 'denmark', 'aarhus': 'denmark', 'odense': 'denmark', 'aalborg': 'denmark', 'bagsværd': 'denmark', 'bagsvaerd': 'denmark',
  'heidelberg': 'germany', 'mainz': 'germany', 'berlin': 'germany', 'munich': 'germany', 'hamburg': 'germany', 'frankfurt': 'germany', 'gottingen': 'germany', 'göttingen': 'germany', 'cologne': 'germany', 'bonn': 'germany', 'freiburg': 'germany', 'tubingen': 'germany', 'tübingen': 'germany',
  'brussels': 'belgium', 'ghent': 'belgium', 'leuven': 'belgium', 'antwerp': 'belgium', 'liege': 'belgium',
  'basel': 'switzerland', 'zurich': 'switzerland', 'zürich': 'switzerland', 'bern': 'switzerland', 'geneva': 'switzerland', 'lausanne': 'switzerland',
  'luxembourg': 'luxembourg',
  'oslo': 'norway', 'bergen': 'norway', 'trondheim': 'norway', 'tromso': 'norway',
  'helsinki': 'finland', 'turku': 'finland', 'tampere': 'finland', 'oulu': 'finland',
  'vienna': 'austria', 'graz': 'austria', 'innsbruck': 'austria', 'salzburg': 'austria',
  'toronto': 'canada', 'vancouver': 'canada', 'montreal': 'canada', 'ottawa': 'canada',
  'singapore': 'singapore',
  'melbourne': 'australia', 'sydney': 'australia', 'brisbane': 'australia', 'adelaide': 'australia', 'perth': 'australia', 'canberra': 'australia'
};

function resolveCountry(raw = '') {
  const l = String(raw || '').toLowerCase().trim();
  if (!l) return null;
  
  if (COUNTRY_MAP[l]) return COUNTRY_MAP[l];
  if (CITY_COUNTRY_MAP[l]) return CITY_COUNTRY_MAP[l];
  
  // Split by common delimiters and check both maps
  const parts = l.split(/[-–,/\s\(\)]+/).map(x => x.trim()).filter(Boolean);
  for (const part of parts) {
    if (COUNTRY_MAP[part]) return COUNTRY_MAP[part];
    if (CITY_COUNTRY_MAP[part]) return CITY_COUNTRY_MAP[part];
  }
  
  return null;
}

function buildTags(title, org, country, location) {
  const tags = [];
  const t = (title + '').toLowerCase();
  const isPhd = typeFromText(title) === 'phd';
  
  if (isPhd) tags.push('🎓 PhD');
  else tags.push('🏢 Industry');
  
  if (location) tags.push(`📍 ${location}`);
  else {
    const cityMap = {
      sweden: 'Sweden', netherlands: 'Netherlands', denmark: 'Denmark',
      germany: 'Germany', belgium: 'Belgium', switzerland: 'Switzerland',
      luxembourg: 'Luxembourg', norway: 'Norway', finland: 'Finland',
      austria: 'Austria', canada: 'Canada', singapore: 'Singapore', australia: 'Australia',
    };
    tags.push(`📍 ${cityMap[country] || country}`);
  }
  if (t.includes('marie curie') || t.includes('msca')) tags.push('MSCA · Fully Funded');
  else if (t.includes('fully funded') || t.includes('fullt finansierad') || t.includes('helfinansierad')) tags.push('Fully Funded');
  if (t.includes('stem cell') || t.includes('stamcell')) tags.push('Stem Cells');
  if (t.includes('epigenet') || t.includes('methylation')) tags.push('Epigenetics');
  if (t.includes('toxicology') || t.includes('toxicologi') || t.includes('toxic')) tags.push('Toxicology');
  if (t.includes('glp') || t.includes('qa/qc') || t.includes('quality control')) tags.push('GLP/QA-QC');
  return tags.slice(0, 5);
}

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(link = '', base = '') {
  if (!link) return base || '#';
  try {
    return new URL(link, base).toString();
  } catch {
    return link.startsWith('http') ? link : '#';
  }
}

function pushJob(jobs, raw, defaults = {}) {
  const title = cleanText(raw.title);
  if (!title || title.length < 6) return;
  const baseUrl = defaults.baseUrl || raw.baseUrl || raw.url || '';
  jobs.push({
    title,
    org: cleanText(raw.org || defaults.org || 'Unknown Organisation'),
    country: raw.country || defaults.country || '',
    location: cleanText(raw.location || defaults.location || ''),
    description: cleanText(raw.description || defaults.description || ''),
    type: raw.type || defaults.type,
    deadline: raw.deadline || defaults.deadline,
    deadlineWarn: raw.deadlineWarn || false,
    url: absoluteUrl(raw.url || raw.link || '', baseUrl),
  });
}

function parseJsonSafely(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
}

function walkJson(value, visitor, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach(item => walkJson(item, visitor, seen));
  } else {
    Object.values(value).forEach(item => walkJson(item, visitor, seen));
  }
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return '';
}

function jsonValue(value) {
  if (Array.isArray(value)) return value.map(jsonValue).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    return value.name || value.title || value.label || value.city || value.country || '';
  }
  return value || '';
}

function extractJobsFromJson(value, defaults = {}) {
  const jobs = [];
  walkJson(value, obj => {
    const type = String(obj['@type'] || obj.type || obj.contentType || '').toLowerCase();
    const title = firstDefined(obj, [
      'title', 'jobTitle', 'name', 'externalTitle', 'postingTitle', 'displayTitle',
      'positionTitle', 'requisitionTitle',
    ]);
    const href = firstDefined(obj, [
      'url', 'jobUrl', 'externalUrl', 'canonicalPositionUrl', 'positionUrl',
      'absolute_url', 'applyUrl',
    ]);
    const looksLikeJob = type.includes('jobposting')
      || href && /job|career|vacanc|position|phd/i.test(String(href))
      || /job|vacanc|position|phd|doctoral|scientist|research/i.test(String(title));
    if (!title || !looksLikeJob) return;

    const org = jsonValue(firstDefined(obj, [
      'hiringOrganization', 'organization', 'employer', 'company', 'department',
      'institution', 'organisationName',
    ]));
    const location = jsonValue(firstDefined(obj, [
      'jobLocation', 'location', 'locations', 'city', 'workLocation',
    ]));
    const country = jsonValue(firstDefined(obj, ['country', 'countryCode']));
    const description = jsonValue(firstDefined(obj, [
      'description', 'summary', 'jobAbstract', 'teaser', 'shortDescription',
    ]));
    const deadline = jsonValue(firstDefined(obj, [
      'validThrough', 'applicationDeadline', 'deadline', 'endDate',
    ]));

    pushJob(jobs, {
      title: jsonValue(title),
      org,
      location,
      country,
      description,
      url: jsonValue(href),
      deadline: deadline ? `📅 ${deadline}` : undefined,
      type: defaults.type,
    }, defaults);
  });
  return deduplicateRawJobs(jobs);
}

function extractEmbeddedJobs(html, defaults = {}) {
  const jobs = [];
  const $ = cheerio.load(html);

  $('script[type="application/ld+json"]').each((_, el) => {
    const data = parseJsonSafely($(el).contents().text());
    if (data) jobs.push(...extractJobsFromJson(data, defaults));
  });

  $('script').each((_, el) => {
    const text = $(el).contents().text();
    if (!text || !/(JobPosting|jobTitle|jobs|vacancies|positions)/i.test(text)) return;
    const nextMatch = text.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    const jsonText = nextMatch ? nextMatch[1] : null;
    if (jsonText) {
      const data = parseJsonSafely(jsonText);
      if (data) jobs.push(...extractJobsFromJson(data, defaults));
    }
  });

  const nextData = $('#__NEXT_DATA__').contents().text();
  if (nextData) {
    const data = parseJsonSafely(nextData);
    if (data) jobs.push(...extractJobsFromJson(data, defaults));
  }
  return deduplicateRawJobs(jobs);
}

function parseHtmlCards(html, defaults, selectors) {
  const jobs = [];
  const $ = cheerio.load(html);
  const cardSelector = selectors?.card || 'article, li, .job, .vacancy, .position';
  $(cardSelector).each((_, el) => {
    const title = cleanText($(el).find(selectors?.title || 'h1, h2, h3, a, [class*="title"]').first().text());
    const link = $(el).find(selectors?.link || 'a[href]').first().attr('href') || '';
    const org = cleanText($(el).find(selectors?.org || '[class*="employer"], [class*="company"], [class*="organisation"], [class*="organization"], [class*="institution"], [class*="university"]').first().text());
    const location = cleanText($(el).find(selectors?.location || '[class*="location"], [class*="country"], [class*="place"]').first().text());
    const description = cleanText($(el).find(selectors?.description || 'p, [class*="summary"], [class*="description"], [class*="teaser"]').first().text());
    const deadline = cleanText($(el).find(selectors?.deadline || '[class*="deadline"], time').first().text());
    if (title && (link || /phd|doctoral|scientist|research|assistant|engineer/i.test(title))) {
      pushJob(jobs, {
        title, org, location, description, url: link,
        deadline: deadline ? `📅 ${deadline}` : undefined,
      }, defaults);
    }
  });
  return deduplicateRawJobs(jobs);
}

function parseRssItems(xml, defaults = {}) {
  const jobs = [];
  const $ = cheerio.load(xml, { xmlMode: true });
  $('item, entry').each((_, el) => {
    pushJob(jobs, {
      title: $(el).find('title').first().text(),
      org: $(el).find('author name, author, source').first().text(),
      description: $(el).find('description, summary, content').first().text(),
      url: $(el).find('link').first().attr('href') || $(el).find('link').first().text() || $(el).find('guid').first().text(),
      deadline: $(el).find('validThrough, deadline').first().text(),
    }, defaults);
  });
  return jobs;
}

function deduplicateRawJobs(jobsArr) {
  const seen = new Set();
  return jobsArr.filter(j => {
    const key = `${cleanText(j.title).toLowerCase()}||${cleanText(j.org).toLowerCase()}||${cleanText(j.url).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── SOURCE SCRAPERS ─────────────────────────────────────────────────────────

async function scrapeEuraxess() {
  const jobs = [];
  const queries = [
    'stem cell epigenetics',
    'neurodevelopmental toxicology',
    'epigenetics molecular biology',
    'molecular toxicology phd',
    'marie curie stem cell',
    'msca doctoral fellowship',
    'neurodegeneration models',
  ];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const htmlUrl = `https://euraxess.ec.europa.eu/jobs/search?keywords=${encodeURIComponent(q)}`;
    const html = await safeFetch(htmlUrl);
    if (html) {
      const defaults = { org: 'EURAXESS', country: 'sweden', baseUrl: htmlUrl };
      jobs.push(...extractEmbeddedJobs(html, defaults));
      jobs.push(...parseHtmlCards(html, defaults, {
        card: '.job-result, .views-row, article.job, article, li[class*="result"]',
        link: 'a[href*="/jobs/"], a[href]',
        title: 'h3, h2, a',
        org: '.organisation-name',
        location: '.country',
        description: '.field-name-body, p',
      }));
    }
    if (i > 0 && i % 3 === 0) await new Promise(r => setTimeout(r, 1500));
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeAcademicPositions() {
  const jobs = [];
  const jobrxivQueries = [
    'stem cell differentiation', 'epigenetics toxicology',
    'neurodegeneration molecular biology', 'marie curie',
  ];
  for (const q of jobrxivQueries) {
    const url = `https://jobrxiv.org/job/?search=${encodeURIComponent(q)}`;
    const html = await safeFetch(url);
    if (!html) continue;
    const defaults = { baseUrl: url, country: 'sweden' };
    jobs.push(...extractEmbeddedJobs(html, defaults));
    jobs.push(...parseHtmlCards(html, defaults, {
      card: 'article, .job-item, li',
      title: 'h2, h3, a',
      link: 'a[href*="/job/"]',
      org: '[class*="company"], [class*="employer"]',
      location: '[class*="location"]',
      description: 'p',
    }));
  }
  const apRssUrls = [
    'https://academicpositions.com/rss/jobs.xml',
    'https://academicpositions.com/rss/phd.xml',
  ];
  for (const rssUrl of apRssUrls) {
    const xml = await safeFetch(rssUrl);
    if (xml) {
      jobs.push(...parseRssItems(xml, { country: 'sweden', baseUrl: 'https://academicpositions.com' }));
    }
  }
  return deduplicateRawJobs(jobs);
}

async function fetchAcademicTransferToken() {
  const url = 'https://www.academictransfer.com/en/jobs/';
  try {
    const html = await safeFetch(url);
    if (!html) return null;
    
    const $ = cheerio.load(html);
    let token = null;
    
    $('script').each((_, el) => {
      const text = $(el).contents().text();
      if (text.includes('satDataApiPublicAccessToken')) {
        const tokenRegex = /"([a-zA-Z0-9]{42})"/g;
        let match;
        while ((match = tokenRegex.exec(text)) !== null) {
          const candidate = match[1];
          const hasUpper = /[A-Z]/.test(candidate);
          const hasLower = /[a-z]/.test(candidate);
          const hasDigit = /[0-9]/.test(candidate);
          if (hasUpper && hasLower && hasDigit) {
            token = candidate;
          }
        }
      }
    });
    return token;
  } catch (e) {
    console.warn(`  ⚠ Failed to dynamically extract AcademicTransfer token: ${e.message}`);
    return null;
  }
}

async function scrapeAcademicTransfer() {
  const jobs = [];
  const token = await fetchAcademicTransferToken() || 'hR4StejFirdAn4XVlJPGZn0tRZpG12ger4wgHEgp2K';
  if (DEBUG_MODE) {
    console.log(`  ℹ Using AcademicTransfer Bearer Token: ${token.substring(0, 10)}...`);
  }
  
  const queries = ['epigenetics', 'toxicology', 'stem cell'];
  
  for (const q of queries) {
    const apiUrl = `https://api.academictransfer.com/vacancies/?search=${encodeURIComponent(q)}&is_active=true&limit=100`;
    try {
      const res = await axios.get(apiUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json; version=2',
          'User-Agent': USER_AGENTS[0]
        },
        timeout: REQUEST_TIMEOUT
      });
      
      const results = res.data?.results || [];
      for (const item of results) {
        if (!item.title) continue;
        
        // Strip HTML tags from description details
        const rawDesc = [
          item.teaser || '',
          item.description || '',
          item.requirements || ''
        ].join('\n');
        const description = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        
        // Parse end_date to clean date string
        let deadline = '📅 Rolling';
        if (item.end_date) {
          try {
            const date = new Date(item.end_date);
            if (!isNaN(date)) {
              deadline = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            }
          } catch (e) {}
        }
        
        pushJob(jobs, {
          title: item.title,
          org: item.organisation_name || 'AcademicTransfer',
          country: item.country_code ? resolveCountry(item.country_code) : 'netherlands',
          location: item.city || 'Netherlands',
          description,
          url: item.absolute_url || item.short_url || '#',
          deadline
        }, { type: 'phd' });
      }
    } catch (e) {
      console.warn(`  ⚠ AcademicTransfer API search failed for "${q}": ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeGermanyDAAD() {
  const jobs = [];
  const rssUrl = 'https://api.daad.de/api/feeds/rss/en/phd.xml';

  try {
    const res = await axios.get(rssUrl, {
      headers: {
        'Accept': 'application/xml, text/xml, */*',
        'User-Agent': USER_AGENTS[0]
      },
      timeout: REQUEST_TIMEOUT
    });

    const $ = cheerio.load(res.data, { xmlMode: true });
    const items = $('item');

    if (DEBUG_MODE) {
      console.log(`  ℹ Found ${items.length} items in Germany DAAD RSS feed.`);
    }

    items.each((idx, el) => {
      const item = $(el);
      const title = item.find('title').text().trim();
      const org = item.find('company').text().trim() || 'German Research Institution';
      const location = item.find('location').text().trim() || 'Germany';
      const url = item.find('link').text().trim() || '#';
      const rawDesc = item.find('description').text() || '';
      const description = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

      const deadText = item.find('applicationDeadline').text().trim();
      let deadline = '📅 Rolling';
      if (deadText) {
        try {
          const date = new Date(deadText);
          if (!isNaN(date)) {
            deadline = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          } else {
            deadline = deadText;
          }
        } catch (e) {
          deadline = deadText;
        }
      }

      if (title) {
        pushJob(jobs, {
          title,
          org,
          country: 'germany',
          location,
          description,
          url,
          deadline
        }, { type: 'phd' });
      }
    });

  } catch (e) {
    console.warn(`  ⚠ Germany DAAD RSS fetch failed: ${e.message}`);
  }

  return deduplicateRawJobs(jobs);
}

async function scrapeNatureCareers() {
  const jobs = [];
  const queries = ['stem cell', 'epigenetics', 'toxicology', 'neuroscience'];
  for (const q of queries) {
    const searchUrl = `https://www.nature.com/naturecareers/jobs/science-jobs/europe/?keywords=${encodeURIComponent(q)}`;
    const rssUrl = `${searchUrl}&rss=1`;
    const rss = await safeFetch(rssUrl);
    if (rss) {
      jobs.push(...parseRssItems(rss, { org: 'Nature Careers', country: 'sweden', baseUrl: searchUrl }));
    }
    const html = await safeFetch(searchUrl);
    if (html) {
      const defaults = { baseUrl: searchUrl, org: 'Nature Careers', country: 'sweden' };
      jobs.push(...extractEmbeddedJobs(html, defaults));
      jobs.push(...parseHtmlCards(html, defaults, {
        card: 'li[class*="ResultsList"], article, .c-card, li',
        link: 'a[href*="/naturecareers/job/"], a[href*="/jobs/"]',
        title: 'h2, h3, a',
        org: '[class*="employer"], [class*="organization"]',
        location: '[class*="location"]',
        description: 'p',
      }));
    }
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeFindAPhD() {
  const jobs = [];
  const phdStudiesUrls = [
    'https://www.phdstudies.com/phd/europe/molecular-biology/',
    'https://www.phdstudies.com/phd/europe/cell-biology/',
    'https://www.phdstudies.com/phd/sweden/',
    'https://www.phdstudies.com/phd/netherlands/',
    'https://www.phdstudies.com/phd/germany/',
    'https://www.phdstudies.com/phd/denmark/',
  ];
  for (const url of phdStudiesUrls) {
    const countryMatch = url.match(/phdstudies\.com\/phd\/([^/]+)\/?$/);
    const country = countryMatch ? resolveCountry(countryMatch[1]) : 'germany';
    const defaults = { baseUrl: url, country, type: 'phd' };
    const pageJobs = await parseProtectedPage(url, defaults, {
      card: 'article, li, .program-card, .result',
      title: 'h2, h3, a',
      link: 'a[href*="/phd/"], a[href]',
      org: '[class*="school"], [class*="university"]',
      location: '[class*="location"]',
      description: 'p',
    }, { minRenderedFallback: 1 });
    jobs.push(...pageJobs);
    await new Promise(r => setTimeout(r, 500));
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeSwedishUniversities() {
  const jobs = [];
  
  // List of Varbi-based Swedish universities and core facilities
  const feeds = [
    { url: 'https://uu.varbi.com/what:rssfeed/', org: 'Uppsala University', location: 'Uppsala' },
    { url: 'https://lu.varbi.com/what:rssfeed/', org: 'Lund University', location: 'Lund' },
    { url: 'https://ki.varbi.com/what:rssfeed/', org: 'Karolinska Institutet', location: 'Stockholm' },
    { url: 'https://su.varbi.com/what:rssfeed/', org: 'Stockholm University', location: 'Stockholm' },
    { url: 'https://gu.varbi.com/what:rssfeed/', org: 'Gothenburg University', location: 'Gothenburg' },
    { url: 'https://slu.varbi.com/what:rssfeed/', org: 'Swedish University of Agricultural Sciences', location: 'Uppsala/Alnarp/Umeå' },
    { url: 'https://liu.varbi.com/what:rssfeed/', org: 'Linköping University', location: 'Linköping' },
    { url: 'https://umu.varbi.com/what:rssfeed/', org: 'Umeå University', location: 'Umeå' },
    { url: 'https://oru.varbi.com/what:rssfeed/', org: 'Örebro University', location: 'Örebro' },
    { url: 'https://kth.varbi.com/what:rssfeed/', org: 'KTH Royal Institute of Technology', location: 'Stockholm' },
    { url: 'https://chalmers.varbi.com/what:rssfeed/', org: 'Chalmers University', location: 'Gothenburg' }
  ];

  for (const feed of feeds) {
    try {
      const rss = await safeFetch(feed.url);
      if (rss) {
        const parsed = parseRssItems(rss, { org: feed.org, country: 'sweden', location: feed.location, baseUrl: feed.url.replace('what:rssfeed/', 'en/') });
        jobs.push(...parsed);
      }
    } catch (e) {
      console.warn(`  ⚠ Failed to scrape Varbi RSS for ${feed.org}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 200)); // Be gentle with Varbi
  }

  // Also keep SciLifeLab careers page
  try {
    const sllHtml = await safeFetch('https://www.scilifelab.se/careers/');
    if (sllHtml) {
      const $ = cheerio.load(sllHtml);
      $('article, .position, li').each((_, el) => {
        const title = $(el).find('h2, h3, a').first().text().trim();
        const link  = $(el).find('a').first().attr('href') || '';
        if (title && title.length > 8) {
          jobs.push({ title, org: 'SciLifeLab', country: 'sweden', location: 'Stockholm/Uppsala', url: link.startsWith('http') ? link : `https://www.scilifelab.se${link}` });
        }
      });
    }
  } catch (e) {
    console.warn(`  ⚠ Failed to scrape SciLifeLab: ${e.message}`);
  }

  return deduplicateRawJobs(jobs);
}

async function scrapeDutchUniversities() {
  const jobs = [];
  const sources = [
    { name: 'Leiden University', country: 'netherlands', location: 'Leiden', url: 'https://www.universiteitleiden.nl/en/vacancies?query=epigenetics+toxicology+stem+cell' },
    { name: 'University of Amsterdam', country: 'netherlands', location: 'Amsterdam', url: 'https://www.uva.nl/en/working-at-the-uva/job-openings/job-openings.html?q=biology' },
    { name: 'VU Amsterdam', country: 'netherlands', location: 'Amsterdam', url: 'https://workingat.vu.nl/vacancies?query=biology' },
    { name: 'Utrecht University', country: 'netherlands', location: 'Utrecht', url: 'https://www.uu.nl/en/organisation/working-at-utrecht-university/jobs?q=biology' },
    { name: 'Wageningen University', country: 'netherlands', location: 'Wageningen', url: 'https://www.wur.nl/en/jobs.htm?query=molecular+biology' },
  ];
  for (const src of sources) {
    const defaults = { org: src.name, country: src.country, location: src.location, baseUrl: src.url };
    const pageJobs = await parseProtectedPage(src.url, defaults, {
      card: 'article, .vacancy, .job-item, li[class*="job"], .result-item',
      title: 'h2, h3, a',
      link: 'a[href]',
      description: 'p',
    }, { waitForSelector: 'article, li' });
    jobs.push(...pageJobs);
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeDanishInstitutions() {
  const jobs = [];
  const sources = [
    { name: 'University of Copenhagen', country: 'denmark', location: 'Copenhagen', url: 'https://employment.ku.dk/phd/?q=epigenetics+toxicology+stem+cell' },
    { name: 'University of Copenhagen (DanStem)', country: 'denmark', location: 'Copenhagen', url: 'https://danstem.ku.dk/join-us/jobs_and_vacancies/' },
    { name: 'DTU', country: 'denmark', location: 'Lyngby', url: 'https://www.dtu.dk/english/about/job-and-career/vacant-positions?q=molecular+biology' },
    { name: 'Aarhus University', country: 'denmark', location: 'Aarhus', url: 'https://phd.au.dk/admission/vacancies?q=biology' },
  ];
  for (const src of sources) {
    const defaults = { org: src.name, country: src.country, location: src.location, baseUrl: src.url };
    const pageJobs = await parseProtectedPage(src.url, defaults, {
      card: 'article, .vacancy, .job, li[class*="job"]',
      title: 'h2, h3, a',
      link: 'a[href]',
    }, { waitForSelector: 'article, li, a' });
    jobs.push(...pageJobs);
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeWorkdayAPI(tenant, site, wd_server, org, country, location, queries = ['']) {
  // Uses the Workday CXS JSON API directly (much more reliable than HTML parsing)
  const jobs = [];
  const baseUrl = `https://${tenant}.${wd_server}.myworkdayjobs.com`;
  const apiUrl = `${baseUrl}/wday/cxs/${tenant}/${site}/jobs`;
  
  for (const query of queries) {
    try {
      const res = await axios.post(apiUrl, {
        appliedFacets: {},
        limit: 20,
        offset: 0,
        searchText: query
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': USER_AGENTS[0]
        },
        timeout: REQUEST_TIMEOUT
      });
      const postings = res.data.jobPostings || [];
      for (const p of postings) {
        const title = p.title || '';
        const url = p.externalPath ? `${baseUrl}${p.externalPath}` : '';
        if (title && url) {
          // Resolve country and location dynamically from locationsText
          let jobCountry = country;
          let jobLocation = location;
          if (p.locationsText) {
            const resolved = resolveCountry(p.locationsText);
            if (resolved) {
              jobCountry = resolved;
              jobLocation = p.locationsText;
            } else {
              // Mark country as null so it gets excluded in buildJob
              jobCountry = null;
              jobLocation = p.locationsText;
            }
          }
          jobs.push({ title, org, country: jobCountry, location: jobLocation, url, baseUrl });
        }
      }
    } catch (e) {
      console.warn(`  ⚠ Workday API failed [${apiUrl}] (q=${query}): ${e.message}`);
    }
    if (queries.indexOf(query) < queries.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeEMBL() {
  // Use Workday JSON API directly - it returns 24 real jobs reliably
  const jobs = await scrapeWorkdayAPI(
    'embl', 'EMBL', 'wd103',
    'EMBL', 'germany', 'Heidelberg',
    ['epigenetics', 'cell biology', 'biochemistry', 'molecular biology', '']
  );
  return jobs;
}

async function scrapeRestOfEurope() {
  const jobs = [];
  const sources = [
    { name: 'Max Planck Society', country: 'germany', location: 'Germany', url: 'https://www.mpg.de/jobboard?search=epigenetics+stem+cell+toxicology' },
    { name: 'Helmholtz Association', country: 'germany', location: 'Germany', url: 'https://www.helmholtz.de/en/career/job-vacancies/?tx_solr%5Bq%5D=biology' },
    { name: 'DKFZ', country: 'germany', location: 'Heidelberg', url: 'https://www.dkfz.de/en/stellenangebote/index.php' },
    { name: 'VIB', country: 'belgium', location: 'Ghent', url: 'https://vib.be/careers?filter=PhD' },
    { name: 'KU Leuven', country: 'belgium', location: 'Leuven', url: 'https://www.kuleuven.be/personeel/jobsite/en/jobs?q=biology' },
    { name: 'ETH Zurich', country: 'switzerland', location: 'Zurich', url: 'https://jobs.ethz.ch/page/en/open-positions?text=epigenetics+stem+cell+toxicology' },
    { name: 'University of Basel', country: 'switzerland', location: 'Basel', url: 'https://jobs.unibas.ch/en/vacancies/?q=biology' },
    { name: 'University of Bern', country: 'switzerland', location: 'Bern', url: 'https://jobs.unibe.ch' },
    { name: 'LIST Luxembourg', country: 'luxembourg', location: 'Luxembourg', url: 'https://www.list.lu/en/career/job-offers/' }
  ];
  for (const src of sources) {
    const defaults = { org: src.name, country: src.country, location: src.location, baseUrl: src.url };
    const pageJobs = await parseProtectedPage(src.url, defaults, {
      card: 'article, .vacancy, .job, .position, li[class*="job"]',
      title: 'h2, h3, a',
      link: 'a[href]',
    }, { waitForSelector: 'article, li, a' });
    jobs.push(...pageJobs);
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeNovoNordisk() {
  const jobs = [];
  // Novo Nordisk jobs are at job-ad pages linked via `a[href*="job-ad"]`
  const queries = ['scientist cell culture', 'molecular biology', 'stem cell', 'toxicology', 'epigenetics'];
  for (const q of queries) {
    const url = `https://www.novonordisk.com/careers/find-a-job.html?searchText=${encodeURIComponent(q)}&country=Denmark`;
    const defaults = { org: 'Novo Nordisk', country: 'denmark', location: 'Bagsværd, Denmark', baseUrl: 'https://www.novonordisk.com' };
    const nnJobs = await parseProtectedPage(url, defaults, {
      card: 'a[href*="job-ad"]',
      title: 'h2, h3, [class*="title"]',
      link: null
    }, { waitForSelector: 'a[href*="job-ad"]' });
    
    // Also try extracting directly from the rendered Playwright HTML
    const html = await renderPageHtml(url, { waitForSelector: 'a[href*="job-ad"]' }).catch(() => null);
    if (html) {
      const $ = require('cheerio').load(html);
      $('a[href*="job-ad"]').each((_, el) => {
        const href = $(el).attr('href');
        const title = $(el).text().trim();
        if (title && href && title.length > 8 && !isGenericNavigationLink(title)) {
          jobs.push({
            title,
            org: 'Novo Nordisk',
            country: 'denmark',
            location: 'Bagsværd, Denmark',
            url: href.startsWith('http') ? href : `https://www.novonordisk.com${href}`
          });
        }
      });
    } else {
      const filtered = nnJobs.filter(j => !isGenericNavigationLink(j.title));
      jobs.push(...filtered);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeAstraZeneca() {
  // AstraZeneca jobs are rendered as `a[href*="/job/"]` links — not article/li
  const jobs = [];
  const queries = [
    'https://careers.astrazeneca.com/search-jobs?location=Sweden&keywords=epigenetics+cell+biology+research',
    'https://careers.astrazeneca.com/search-jobs?location=Sweden&keywords=toxicology+scientist',
    'https://careers.astrazeneca.com/search-jobs?location=Germany&keywords=cell+biology+scientist',
    'https://careers.astrazeneca.com/search-jobs?location=Denmark&keywords=molecular+biology'
  ];
  for (const url of queries) {
    const pageJobs = await parseProtectedPage(url, {
      org: 'AstraZeneca',
      country: url.includes('Sweden') ? 'sweden' : url.includes('Germany') ? 'germany' : url.includes('Denmark') ? 'denmark' : 'europe',
      location: url.includes('Sweden') ? 'Gothenburg' : url.includes('Germany') ? 'Germany' : url.includes('Denmark') ? 'Denmark' : 'Europe',
      baseUrl: 'https://careers.astrazeneca.com'
    }, {
      // AstraZeneca uses <a href="/job/..."> elements that include the job title
      card: 'a[href*="/job/"]',
      title: null, // title is the link's own text
      link: null   // link is the href of the card itself
    }, { waitForSelector: 'a[href*="/job/"]', minRenderedFallback: 1 });
    
    // Parse AstraZeneca-specific structure where `a[href*="/job/"]` IS the job card
    const html = await renderPageHtml(url, { waitForSelector: 'a[href*="/job/"]' }).catch(() => null);
    if (html) {
      const $ = require('cheerio').load(html);
      $('a[href*="/job/"]').each((_, el) => {
        const href = $(el).attr('href');
        const rawText = $(el).text().trim();
        // Title is the first line of text, before the location
        const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
        const title = lines[0] || rawText;
        const location = lines.slice(1).join(', ').trim();
        if (title && href && title.length > 8 && !isGenericNavigationLink(title) && !title.toLowerCase().includes('view role')) {
          const resolved = resolveCountry(location);
          jobs.push({
            title,
            org: 'AstraZeneca',
            country: resolved || null, // Will be excluded in buildJob if outside target list
            location: location || 'Europe',
            url: href.startsWith('http') ? href : `https://careers.astrazeneca.com${href}`
          });
        }
      });
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeIndustryCareers() {
  const jobs = [];

  // 1. AstraZeneca (link-based scraper)
  jobs.push(...await scrapeAstraZeneca());

  // 2. Workday-based companies — use CXS JSON API (verified working endpoints only)
  const workdayCompanies = [
    // Confirmed working: EMBL-style JSON API
    { tenant: 'lonza', site: 'Lonza_Careers', server: 'wd3', org: 'Lonza', country: 'switzerland', location: 'Basel' },
    { tenant: 'illumina', site: 'Illumina-Careers', server: 'wd1', org: 'Illumina', country: 'europe', location: 'Europe' },
  ];
  const workdayQueries = ['cell biology', 'molecular biology', 'toxicology', 'cell culture', 'epigenetics', 'scientist', ''];
  for (const co of workdayCompanies) {
    const apiJobs = await scrapeWorkdayAPI(co.tenant, co.site, co.server, co.org, co.country, co.location, workdayQueries);
    jobs.push(...apiJobs.filter(j => !isGenericNavigationLink(j.title)));
  }

  // 3. BioNTech (Playwright HTML — JSON API requires session auth)
  const bionTechJobs = await parseProtectedPage(
    'https://biontech.wd3.myworkdayjobs.com/BNT',
    { org: 'BioNTech', country: 'germany', location: 'Mainz', baseUrl: 'https://biontech.wd3.myworkdayjobs.com' },
    { card: '[data-automation-id="promptOption"], li[class*="css"], article', title: '[data-automation-id="jobTitle"], h2, h3, a', link: 'a[href*="/job/"]' },
    { waitForSelector: '[data-automation-id="jobTitle"]', minRenderedFallback: 1 }
  ).catch(() => []);
  jobs.push(...bionTechJobs.filter(j => !isGenericNavigationLink(j.title)));

  // 4. Bayer AG (HTML scraper with specific selectors)
  const bayerJobs = await parseProtectedPage(
    'https://career.bayer.de/en/jobs?keywords=molecular+biology',
    { org: 'Bayer AG', country: 'germany', location: 'Germany', baseUrl: 'https://career.bayer.de' },
    { card: 'li, article, [class*="result"]', title: 'h2, h3, a[href*="/job"]', link: 'a[href*="/job"]' },
    { waitForSelector: 'a[href*="/job"]', minRenderedFallback: 1 }
  ).catch(() => []);
  jobs.push(...bayerJobs.filter(j => !isGenericNavigationLink(j.title)));

  // 5. Thermo Fisher (HTML)
  const tfJobs = await parseProtectedPage(
    'https://jobs.thermofisher.com/global/en/search-results?keywords=scientist+cell+biology&location=Europe',
    { org: 'Thermo Fisher Scientific', country: 'europe', location: 'Europe', baseUrl: 'https://jobs.thermofisher.com' },
    { card: '[class*="job-card"], article, li[class*="job"]', title: 'h2, h3, a', link: 'a[href*="/job"]' },
    { waitForSelector: '[class*="job-card"], article', minRenderedFallback: 1 }
  ).catch(() => []);
  jobs.push(...tfJobs.filter(j => !isGenericNavigationLink(j.title)));

  return deduplicateRawJobs(jobs);
}

async function scrapeNorway() {
  const jobs = [];
  const jbUrl = 'https://www.jobbnorge.no/search?q=phd&AdCategoryId=64';
  const jbJobs = await parseProtectedPage(jbUrl, { country: 'norway', baseUrl: 'https://www.jobbnorge.no/search' }, {
    card: 'article, li, [class*="vacancy"], [class*="job"]',
    title: 'h2, h3, a',
    link: 'a[href]',
  }, { waitForSelector: 'article, li' });
  jobs.push(...jbJobs);

  const uioUrl = 'https://www.uio.no/english/about/vacancies/academic/';
  const html = await safeFetch(uioUrl);
  if (html) {
    const defaults = { org: 'University of Oslo', country: 'norway', location: 'Oslo', baseUrl: uioUrl };
    jobs.push(...extractEmbeddedJobs(html, defaults));
    jobs.push(...parseHtmlCards(html, defaults, { card: 'article, li, .vrtx-resource', title: 'h2, h3, a', link: 'a[href]' }));
  }

  const ntnuUrl = 'https://www.ntnu.edu/vacancies';
  const ntnuHtml = await safeFetch(ntnuUrl);
  if (ntnuHtml) {
    const defaults = { org: 'NTNU', country: 'norway', location: 'Trondheim', baseUrl: ntnuUrl };
    jobs.push(...extractEmbeddedJobs(ntnuHtml, defaults));
    jobs.push(...parseHtmlCards(ntnuHtml, defaults, { card: 'article, li, tr', title: 'h2, h3, a', link: 'a[href]' }));
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeFinland() {
  const jobs = [];
  const sources = [
    { org: 'University of Helsinki', country: 'finland', location: 'Helsinki', url: 'https://www.helsinki.fi/en/about-us/careers/open-positions' },
    { org: 'University of Turku', country: 'finland', location: 'Turku', url: 'https://www.utu.fi/en/university/come-work-with-us' },
    { org: 'Åbo Akademi', country: 'finland', location: 'Turku', url: 'https://www.abo.fi/en/about-abo-akademi-university/come-work-with-us/' },
    { org: 'Finnish Institute for Health and Welfare (THL)', country: 'finland', location: 'Helsinki', url: 'https://thl.fi/en/about-thl/open-vacancies' },
    { org: 'University of Oulu', country: 'finland', location: 'Oulu', url: 'https://www.oulu.fi/en/jobs' }
  ];
  for (const src of sources) {
    const html = await safeFetch(src.url);
    if (html) {
      const defaults = { org: src.org, country: src.country, location: src.location, baseUrl: src.url };
      jobs.push(...extractEmbeddedJobs(html, defaults));
      jobs.push(...parseHtmlCards(html, defaults, {
        card: 'article, li, .vacancy, .job, [class*="position"]',
        title: 'h2, h3, a',
        link: 'a[href]',
      }));
    }
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeAustria() {
  const jobs = [];
  const sources = [
    { org: 'IMP Vienna', country: 'austria', location: 'Vienna', url: 'https://www.imp.ac.at/career/open-positions/' },
    { org: 'IMBA Vienna', country: 'austria', location: 'Vienna', url: 'https://www.imba.oeaw.ac.at/about-imba/careers/open-positions/' },
    { org: 'CeMM Vienna', country: 'austria', location: 'Vienna', url: 'https://cemm.at/career/' },
    { org: 'Medical University of Vienna', country: 'austria', location: 'Vienna', url: 'https://jobs.meduniwien.ac.at/en/open-positions/' },
    { org: 'University of Vienna', country: 'austria', location: 'Vienna', url: 'https://jobcenter.univie.ac.at/en/jobs-and-vacancies/' },
  ];
  for (const src of sources) {
    const defaults = { org: src.org, country: src.country, location: src.location, baseUrl: src.url };
    const apJobs = await parseProtectedPage(src.url, defaults, {
      card: 'article, li, .vacancy, .job, [class*="position"]',
      title: 'h2, h3, a',
      link: 'a[href]',
    }, { waitForSelector: 'article, li, a' });
    jobs.push(...apJobs);
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeCanada() {
  const jobs = [];
  const sources = [
    { org: 'University of Toronto', country: 'canada', location: 'Toronto', url: 'https://jobs.utoronto.ca/search/?q=epigenetics+toxicology+stem+cell&climit=25' },
    { org: 'McGill University', country: 'canada', location: 'Montreal', url: 'https://mcgill.wd3.myworkdayjobs.com/mcgill_careers?q=biology' },
    { org: 'University of British Columbia', country: 'canada', location: 'Vancouver', url: 'https://www.hr.ubc.ca/careers/?q=biology' },
  ];
  for (const src of sources) {
    const defaults = { org: src.org, country: src.country, location: src.location, baseUrl: src.url };
    const pageJobs = await parseProtectedPage(src.url, defaults, {
      card: 'article, li, .job, [class*="position"]',
      title: 'h2, h3, a',
      link: 'a[href]',
    }, { waitForSelector: 'article, li' });
    jobs.push(...pageJobs);
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeSingapore() {
  const jobs = [];
  const sources = [
    { org: 'A*STAR', country: 'singapore', location: 'Singapore', url: 'https://careers.a-star.edu.sg/search/?q=biology' },
    { org: 'NUS', country: 'singapore', location: 'Singapore', url: 'https://careers.nus.edu.sg/NUS/go/View-All-Jobs/568701/' },
    { org: 'Duke-NUS Medical School', country: 'singapore', location: 'Singapore', url: 'https://www.duke-nus.edu.sg/about/careers?search=biology' },
  ];
  for (const src of sources) {
    const html = await safeFetch(src.url);
    if (html) {
      const defaults = { org: src.org, country: src.country, location: src.location, baseUrl: src.url };
      jobs.push(...extractEmbeddedJobs(html, defaults));
      jobs.push(...parseHtmlCards(html, defaults, { card: 'article, li, .job', title: 'h2, h3, a', link: 'a[href]' }));
    }
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeAustralia() {
  const jobs = [];
  const sources = [
    { org: 'WEHI', country: 'australia', location: 'Melbourne', url: 'https://www.wehi.edu.au/careers/' },
    { org: 'Garvan Institute', country: 'australia', location: 'Sydney', url: 'https://www.garvan.org.au/careers' },
    { org: 'Monash University', country: 'australia', location: 'Melbourne', url: 'https://careers.pageuppeople.com/513/cw/en/listing/?search=biology' }
  ];
  for (const src of sources) {
    const html = await safeFetch(src.url);
    if (html) {
      const defaults = { org: src.org, country: src.country, location: src.location, baseUrl: src.url };
      jobs.push(...extractEmbeddedJobs(html, defaults));
      jobs.push(...parseHtmlCards(html, defaults, { card: 'article, li', title: 'h2, h3, a', link: 'a[href]' }));
    }
  }
  return deduplicateRawJobs(jobs);
}

// ─── STATE & CACHE LOADING ────────────────────────────────────────────────────
function loadSourceState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn(`  ⚠ Failed to read source-state.json: ${e.message}`);
  }
  return { sources: {} };
}

function saveSourceState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    if (DEBUG_MODE) console.log(`💾 Source state written: ${STATE_FILE}`);
  } catch (e) {
    console.error(`  ⚠ Failed to write source-state.json: ${e.message}`);
  }
}

function loadPreviousJobs() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return Array.isArray(data.jobs) ? data.jobs : [];
    }
  } catch (e) {
    console.warn(`  ⚠ Failed to read jobs-db.json: ${e.message}`);
  }
  return [];
}

// ─── MAIN ORCHESTRATOR ─────────────────────────────────────────────────────────

const ALL_SCRAPERS = [
  { name: 'swedish',       fn: scrapeSwedishUniversities, forcedCountry: null, url: 'https://uu.varbi.com/en/', method: 'varbi rss + playwright' },
  { name: 'dutch',         fn: scrapeAcademicTransfer, forcedCountry: null, url: 'https://www.academictransfer.com/en/', method: 'cheerio html' },
  { name: 'germany',       fn: scrapeGermanyDAAD, forcedCountry: 'germany', url: 'https://api.daad.de/api/feeds/rss/en/phd.xml', method: 'cheerio rss' }
];

async function runScraperPipeline() {
  console.log('\n📡 Starting Multi-Source Telemetry Live Scrape...\n');
  if (DEBUG_MODE) {
    console.log('🐞 [DEBUG MODE ENABLED] Cooldowns disabled. Strict filters bypassed. Score gates lowered to 10.');
  }

  const sourceState = loadSourceState();
  const previousJobs = loadPreviousJobs();
  const now = new Date();
  
  const allScrapes = [];
  const healthReport = {};

  for (const scraper of ALL_SCRAPERS) {
    const state = sourceState.sources[scraper.name] || {
      status: 'healthy',
      consecutiveErrors: 0,
      lastSuccess: null,
      contentHash: null
    };

    // Initialize source metrics
    metrics.sources[scraper.name] = {
      raw: 0,
      cleaned: 0,
      scored: 0,
      excluded: 0,
      retained: 0,
      status: state.status,
      method: scraper.method,
      targetUrl: scraper.url,
      tier: getSourceTier(scraper.name)
    };

    // Cooldown check (Skip in debug mode)
    if (!DEBUG_MODE && state.status === 'healthy' && state.lastSuccess) {
      const hoursSinceSuccess = (now - new Date(state.lastSuccess)) / (1000 * 60 * 60);
      if (hoursSinceSuccess < COOLDOWN_HOURS) {
        console.log(`⚡ Cooldown active for ${scraper.name} (${Math.round(hoursSinceSuccess)}h ago). Skip scrape.`);
        metrics.rejections.skippedCooldown++;
        allScrapes.push(Promise.resolve({ name: scraper.name, skipped: true, success: true }));
        healthReport[scraper.name] = state.status;
        continue;
      }
    }

    // Circuit Breaker (Skip in debug mode)
    if (!DEBUG_MODE && state.status === 'disabled' && state.lastFailure) {
      const hoursSinceFailure = (now - new Date(state.lastFailure)) / (1000 * 60 * 60);
      if (hoursSinceFailure < OFFLINE_RETRY_HOURS) {
        console.log(`❌ Circuit Breaker active for ${scraper.name} (${Math.round(hoursSinceFailure)}h ago). Skip scrape.`);
        allScrapes.push(Promise.resolve({ name: scraper.name, skipped: true, success: false }));
        healthReport[scraper.name] = state.status;
        continue;
      }
    }

    const execPromise = (async () => {
      try {
        console.log(`📡 Fetching live listings: ${scraper.name}...`);
        const rawResults = await scraper.fn();
        
        const hashInput = JSON.stringify(rawResults);
        const newHash = crypto.createHash('md5').update(hashInput).digest('hex');

        if (!DEBUG_MODE && state.contentHash === newHash) {
          console.log(`✓ Source ${scraper.name} yields unchanged contents. Skip parse.`);
          state.status = 'healthy';
          state.consecutiveErrors = 0;
          state.lastSuccess = now.toISOString();
          sourceState.sources[scraper.name] = state;
          return { name: scraper.name, success: true, unchanged: true, raw: [] };
        }

        const typedResults = rawResults.map(j => ({
          ...j,
          _sourceName: scraper.name,
          ...(scraper.forcedCountry ? { _forcedCountry: scraper.forcedCountry } : {})
        }));

        state.status = 'healthy';
        state.consecutiveErrors = 0;
        state.lastSuccess = now.toISOString();
        state.contentHash = newHash;
        sourceState.sources[scraper.name] = state;

        return { name: scraper.name, success: true, unchanged: false, raw: typedResults };
      } catch (e) {
        state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
        state.lastFailure = now.toISOString();
        if (state.consecutiveErrors >= 3) {
          state.status = 'disabled';
          console.error(`🔴 Source ${scraper.name} DISABLED after ${state.consecutiveErrors} errors: ${e.message}`);
        } else {
          state.status = 'degraded';
          console.warn(`⚠️ Source ${scraper.name} DEGRADED: ${e.message}`);
        }
        sourceState.sources[scraper.name] = state;
        return { name: scraper.name, success: false, raw: [] };
      }
    })();

    allScrapes.push(execPromise);
  }

  const results = await Promise.all(allScrapes);
  await closeBrowser();

  let livePool = [];
  for (const res of results) {
    const sMetric = metrics.sources[res.name];
    sMetric.status = sourceState.sources[res.name]?.status || 'healthy';
    healthReport[res.name] = sMetric.status;

    if (res.skipped || res.unchanged || !res.success) {
      const cached = previousJobs.filter(j => j.sourceName === res.name);
      livePool.push(...cached);
      sMetric.retained = cached.length;
      if (res.skipped) sMetric.diagStatus = 'COOLDOWN-SKIPPED';
      else if (res.unchanged) sMetric.diagStatus = 'UNCHANGED-SKIPPED';
      else sMetric.diagStatus = sMetric.status === 'disabled' ? 'CIRCUIT-BROKEN' : 'FAILED';
    } else {
      sMetric.diagStatus = 'SUCCESS';
      const scored = [];
      for (const r of res.raw) {
        const job = buildJob(r, res.name);
        if (job) scored.push(job);
      }
      livePool.push(...scored);
      sMetric.retained = scored.length;
    }
  }

  // Deduplicate and filter duplicates across sources
  const uniqueJobs = deduplicateJobsTiered(livePool);

  // Optional Gemini AI refinement
  const refinedJobs = await refineWithGemini(uniqueJobs);

  const finalJobs = refinedJobs.map(j => {
    delete j._fp;
    delete j._sourceName;
    delete j._forcedCountry;
    return j;
  });

  // Dataset Protection Mechanism
  let previousJobCount = 0;
  if (fs.existsSync(DB_FILE)) {
    try {
      const prevDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (prevDb && Array.isArray(prevDb.jobs)) {
        previousJobCount = prevDb.jobs.length;
      }
    } catch (err) {
      console.warn(`⚠️ Failed to parse previous database for count comparison: ${err.message}`);
    }
  }

  const FORCE_UPDATE = process.env.FORCE_UPDATE === 'true' || process.argv.includes('--force');
  const countThreshold = Math.round(previousJobCount * 0.5);

  if (previousJobCount > 0 && finalJobs.length < countThreshold && !FORCE_UPDATE && !DEBUG_MODE) {
    console.error(`❌ DATASET PROTECTION TRIGGERED: New job count (${finalJobs.length}) is significantly lower than previous count (${previousJobCount}) (threshold: < 50%, minimum allowed: ${countThreshold}). Overwrite aborted to protect production dashboard.`);
    process.exit(1); // Exit with error to notify GitHub Actions
  }

  const jobsDbContent = {
    lastUpdated: now.toISOString(),
    sourceHealth: healthReport,
    jobs: finalJobs
  };

  // Ensure jobs-db.json and jobs-db.js are perfectly synchronized
  const dbJsonString = JSON.stringify(jobsDbContent, null, 2);
  fs.writeFileSync(DB_FILE, dbJsonString);
  fs.writeFileSync(JS_FILE, `window.KAVYA_JOBS_DB = ${dbJsonString};`);
  saveSourceState(sourceState);

  // Compile and Save Diagnostics Telemetry Report
  metrics.completedAt = new Date().toISOString();
  metrics.finalRetainedJobsCount = finalJobs.length;
  metrics.sourceStateLog = sourceState.sources;
  fs.writeFileSync(DIAGNOSTICS_FILE, JSON.stringify(metrics, null, 2));
  
  // Print Diagnostic Console Summary Table
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('📊 TELEMETRY DIAGNOSTIC REPORT SUMMARY');
  console.log('═══════════════════════════════════════════════════════');
  console.log('Source Name        Tier   Raw    Clean  Scored Excl   Retained Status');
  console.log('---------------------------------------------------------------------');
  for (const name of Object.keys(metrics.sources)) {
    const s = metrics.sources[name];
    console.log(
      `${name.padEnd(18)} ` +
      `${String(s.tier).padEnd(6)} ` +
      `${String(s.raw).padEnd(6)} ` +
      `${String(s.cleaned).padEnd(6)} ` +
      `${String(s.scored).padEnd(6)} ` +
      `${String(s.excluded).padEnd(6)} ` +
      `${String(s.retained).padEnd(10)} ` +
      `${s.diagStatus}`
    );
  }
  console.log('---------------------------------------------------------------------');
  console.log(`Final unique active jobs retained: ${finalJobs.length}`);
  console.log(`Rejections Log:`);
  console.log(` - Malformed Data: ${metrics.rejections.malformedData}`);
  console.log(` - Low Profile Scores: ${metrics.rejections.lowScore}`);
  console.log(` - Excluded by Hard Keywords: ${metrics.rejections.hardExclude}`);
  console.log(` - Excluded by Postdoc Filters: ${metrics.rejections.postdocExclude}`);
  console.log(` - Excluded by Senior Academia Filters: ${metrics.rejections.seniorExclude}`);
  console.log(` - Excluded by Off-Discipline Filters: ${metrics.rejections.disciplineExclude}`);
  console.log(` - Merged by Deduplication: ${metrics.rejections.deduplicated}`);
  console.log(` - Skipped Cooldowns: ${metrics.rejections.skippedCooldown}`);
  console.log(`Category Distributions:`);
  console.log(` - PhD Positions: ${metrics.categories.phd}`);
  console.log(` - Postdoc Positions: ${metrics.categories.postdoc}`);
  console.log(` - Research Assistants/Technicians: ${metrics.categories.researchAssistantOrTech}`);
  console.log(` - Industry Scientists: ${metrics.categories.industryScientist}`);
  console.log(` - Generic Biology (retained/debug): ${metrics.categories.genericBiology}`);
  console.log(`Relevance Hit Rates:`);
  console.log(` - Multilingual Matches: ${metrics.multilingualMatches}`);
  console.log(` - Niche Domain Hits: ${metrics.nicheHits}`);
  console.log(` - GLP/QA Hits: ${metrics.glpHits}`);
  console.log(`Diagnostic payload written to: ${DIAGNOSTICS_FILE}\n`);
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🔬 KAVYA JOB BOARD — Serverless Scraper Starting');
  console.log(`   ${new Date().toUTCString()}`);
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    await runScraperPipeline();
    process.exit(0);
  } catch (e) {
    console.error('❌ Pipeline run crashed:', e);
    process.exit(1);
  }
})();
