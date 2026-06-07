// ═══════════════════════════════════════════════════════════════════
// KAVYA JOB BOARD — REDESIGNED AI-CURATED opportunity ENGINE
// Supports: Verbose Diagnostic Logging & Circuit Breakers
// ═══════════════════════════════════════════════════════════════════

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');


// ─── DEBUG MODE CONFIGURATION ────────────────────────────────────────────────
const DEBUG_MODE = process.argv.includes('--debug') || process.env.SCRAPER_DEBUG === 'true';

const REQUEST_TIMEOUT = 15000; 
const MAX_JOBS_PER_SOURCE = 30;
const GEMINI_BATCH_SIZE = 25;
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
  'test and reliability', 'gs-imtr', 'environmental engineering', 'life cycle assessment',
  // Veterinary / Animal husbandry exclusions
  'veterinary', 'veterinär', 'djursjukskötare', 'animal facility', 'animal keeper',
  // Humanities / Non-Bio / Cognitive / computational exclusions
  'psychology', 'psychiatry', 'law', 'legal', 'cognitive', 'computational neuroscience',
  'generative ai', 'artificial intelligence', 'machine learning',
  
  // Multilingual / Nordic discipline exclusions
  'sosiologi', 'pedagogikk', 'didaktikk', 'lærerutdanning', 'barnevern',
  'arkeologi', 'historie', 'litteratur', 'forfatterskap', 'fagspråk',
  'filosofi', 'rettsvitenskap', 'juridisk', 'statsvitenskap', 'samfunnsvitenskap',
  'psykologi', 'sosialt arbeid', 'sosialfag', 'kunstnerisk', 'opera',
  'musikk', 'teater', 'fysioterapi', 'rehabilitering', 'idrettsvitenskap',
  'anestesisykepleie', 'operasjonssykepleie', 'odontologi', 'odontology',
  'bore- og brønnteknologi', 'luft–hav-utvekslingsprosessar', 'bedriftsøkonomi',
  'samfunnspsykologi', 'personnamngransking', 'grensestudier', 'urfolksforskning'
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
  'senior project manager', 'head of', 'director', 'team lead', 'principal scientist',
  'senior laboratory technician', 'senior analyst', 'senior specialist',
  // VP / executive level
  'vice president', 'vp ', 'associate vice president', 'executive director',
  'chief ', 'c-suite', 'president',
  // Management exclusions
  'group manager', 'project manager', 'business manager', 'operations manager',
  'portfolio manager', 'program director', 'strategy partner'
];

const HARD_EXCLUDES = [
  'software engineer', 'software developer', 'devops engineer', 'it engineer',
  'nursing', 'nurse practitioner', 'full professor', 'associate professor',
  'assistant professor', 'business development manager', 'sales representative',
  'account manager', 'hr manager', 'finance manager',
  // Non-research / Business development / Part-time student jobs
  'business development', 'student assistant', 'studenterassistent', 'studentmedhjælper', 'studenterformidler',
  // Clinical / medical roles (require MD, not relevant to Kavya)
  'physician', 'medical doctor', 'clinical research physician', 'clinical physician',
  // Animal care (not research — Danish/Norwegian terms included)
  'dyrepasser', 'animal caretaker', 'animal technician', 'laboratory animal care',
  // Pharmacovigilance / drug safety / regulatory ops (not research)
  'safety surveillance', 'pharmacovigilance', 'drug safety officer', 'safety officer',
  'regulatory professional', 'regulatory affairs specialist',
  // IT / infrastructure / engineering (non-bio)
  'security technician', 'test engineer', 'mechanical engineer', 'electrical engineer',
  'commissioning engineer', 'automation technician', 'building management',
  // Sales / commercial
  'medical representative', 'sales specialist', 'account director', 'medical account'
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
    if (kw.length <= 4) {
      const escaped = kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp('\\b' + escaped + '\\b', 'i');
      return regex.test(srcText);
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
    { kw: 'dna-methylering', w: 35, multi: true },
    { kw: 'méthylation de l\'adn', w: 35, multi: true },
    { kw: 'pyrosequencing', w: 35 },
    { kw: 'epigenetic', w: 20 },
    { kw: 'epigenomics', w: 20 },
    { kw: 'epigenetik', w: 20, multi: true },
    { kw: 'epigenetisk', w: 20, multi: true },
    { kw: 'epigenetische', w: 20, multi: true },
    { kw: 'epigenetica', w: 20, multi: true },
    { kw: 'epigenetikk', w: 20, multi: true },
    { kw: 'epigenetiikka', w: 20, multi: true },
    { kw: 'épigénétique', w: 20, multi: true },
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
    { kw: 'plantevernmiddel', w: 30, multi: true },
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
    // Specific Toxicants & EDCs from Master's Thesis
    { kw: 'bisphenol', w: 35 },
    { kw: 'bpa', w: 30 },
    { kw: 'bpf', w: 30 },
    { kw: ' endocrine-disrupting', w: 40 },
    { kw: ' edc ', w: 25 },
    // Endocrine disruptor translations
    { kw: 'endokriner disruptor', w: 40, multi: true },
    { kw: 'endokrinschädigend', w: 40, multi: true },
    { kw: 'endokrine disruptoren', w: 40, multi: true },
    { kw: 'hormonstörande', w: 40, multi: true },
    { kw: 'hormonforstyrrende', w: 40, multi: true },
    { kw: 'hormoonontregelaar', w: 40, multi: true },
    { kw: 'hormoonverstorend', w: 40, multi: true },
    { kw: 'hormonitoimintaa häiritsevä', w: 40, multi: true },
    { kw: 'hormonihäiritsijä', w: 40, multi: true },
    { kw: 'perturbateur endocrinien', w: 40, multi: true },

    // Circadian Biology / Rhythms
    { kw: 'circadian biology', w: 35 },
    { kw: 'circadian rhythm', w: 35 },
    { kw: 'circadian clock', w: 30 },
    { kw: 'chronobiology', w: 30 },
    { kw: 'circadian', w: 20 },
    { kw: 'zirkadian', w: 20, multi: true },
    { kw: 'circadianer rhythmus', w: 35, multi: true },
    { kw: 'dygnsrytm', w: 35, multi: true },
    { kw: 'dygnsrytmik', w: 35, multi: true },
    { kw: 'døgnrytme', w: 35, multi: true },
    { kw: 'vuorokausirytmi', w: 35, multi: true },
    { kw: 'circadiaans ritme', w: 35, multi: true },
    { kw: 'rythme circadien', w: 35, multi: true },
    { kw: 'sömn', w: 25, multi: true },
    { kw: 'søvn', w: 25, multi: true },
    { kw: 'slaap', w: 25, multi: true },

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
    { kw: 'neuroutveckling', w: 40, multi: true },
    { kw: 'neuroutvikling', w: 40, multi: true },
    { kw: 'hjernens udvikling', w: 40, multi: true },
    { kw: 'hermostollinen kehitys', w: 40, multi: true },
    { kw: 'neuroentwicklung', w: 40, multi: true },
    { kw: 'neuro-ontwikkeling', w: 40, multi: true },
    { kw: 'développement neurologique', w: 40, multi: true },
    { kw: 'sh-sy5y', w: 35 },
    { kw: 'caco-2', w: 35 },
    { kw: 'caco2', w: 35 },
    { kw: 'glutamatergic', w: 35 },
    { kw: 'neural induction', w: 30 },
    
    // Developmental Biology
    { kw: 'developmental biology', w: 45 },
    { kw: 'utvecklingsbiologi', w: 45, multi: true },
    { kw: 'udviklingsbiologi', w: 45, multi: true },
    { kw: 'utviklingsbiologi', w: 45, multi: true },
    { kw: 'kehitysbiologia', w: 45, multi: true },
    { kw: 'entwicklungsbiologie', w: 45, multi: true },
    { kw: 'ontwikkelingsbiologie', w: 45, multi: true },
    { kw: 'biologie du développement', w: 45, multi: true },
    
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
    // MicroRNA & Chemoresistance from M.Sc. Ovarian Cancer research
    { kw: 'microrna', w: 30 },
    { kw: 'mirna', w: 30 },
    { kw: 'chemoresistance', w: 30 },
    { kw: 'cisplatin', w: 25 },
    
    // Multilingual Immunology & Oncology
    { kw: 'immunologie', w: 35, multi: true },
    { kw: 'immunologi', w: 35, multi: true },
    { kw: 'immuntherapie', w: 35, multi: true },
    { kw: 'onkologie', w: 35, multi: true },
    { kw: 'onkologi', w: 35, multi: true },
    { kw: 'tumorbiologie', w: 30, multi: true },
    { kw: 'krebs', w: 30, multi: true },
    { kw: 'kanker', w: 30, multi: true },
    { kw: 'kræft', w: 30, multi: true },
    { kw: 'kreft', w: 30, multi: true },
    { kw: 'svulst', w: 25, multi: true },
    { kw: 'syöpä', w: 30, multi: true },
    { kw: 'kasvain', w: 25, multi: true },
    { kw: 'tuumori', w: 25, multi: true },
    { kw: 'immunohoito', w: 35, multi: true },
    { kw: 'tumeur', w: 25, multi: true },
    { kw: 'immunothérapie', w: 35, multi: true },

    // Model Organisms (Zebrafish / Drosophila)
    { kw: 'zebrafish', w: 15 },
    { kw: 'drosophila', w: 15 }
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
    // New methods from resume
    { kw: 'in situ hybridisation', w: 20 },
    { kw: 'in situ hybridization', w: 20 },
    { kw: 'live-cell imaging', w: 15 },
    { kw: 'rna extraction', w: 10 },
    { kw: 'dna extraction', w: 10 },
    
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
    { kw: 'sop', w: 5 },
    
    // Multilingual operational
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
  const isIndustry = (sourceName === 'industry' || sourceName === 'novo' || sourceName === 'medicon');
  if (isIndustry) {
    boost += 10;
  }

  // Anti-Generic Penalty & Industry Exemptions/Waivers
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
  'swedish': 1, 'dutch': 1, 'danish': 1, 'embl': 1, 'novo': 1, 'industry': 1, 'norway': 1, 'finland': 1, 'austria': 1, 'switzerland': 1,
  'medicon': 1,
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
async function callGeminiWithRetry(url, payload, maxRetries = 3) {
  let attempt = 0;
  let delay = 3000;
  while (attempt < maxRetries) {
    try {
      return await axios.post(url, payload, { timeout: 10000 });
    } catch (err) {
      attempt++;
      const isRateLimit = err.response && err.response.status === 429;
      const isServerErr = err.response && err.response.status === 503;
      if (attempt >= maxRetries || (!isRateLimit && !isServerErr)) {
        throw err;
      }
      console.warn(`   ⚠ Gemini rate limit/server error (Attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function refineWithGemini(jobs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (DEBUG_MODE) console.log('  ℹ GEMINI_API_KEY not set. Using rule-based matrix curation.');
    return jobs;
  }

  console.log(`\n🤖 Waking Gemini Curation Layer to evaluate top candidates...`);
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const refinedJobs = [];

  const rulesSorted = [...jobs].sort((a, b) => (b.score || 0) - (a.score || 0));
  const toRefine = rulesSorted.slice(0, GEMINI_BATCH_SIZE);
  const remaining = rulesSorted.slice(GEMINI_BATCH_SIZE);

  if (toRefine.length === 0) {
    return jobs;
  }

  console.log(`🤖 Preparing to batch evaluate ${toRefine.length} candidates in a single request.`);

  // Construct batch input array
  const batchInput = toRefine.map(job => ({
    id: job.id,
    title: job.title,
    description: job.description ? job.description.substring(0, 1200) : 'No description available.',
    score: job.score
  }));

  const prompt = `You are a career matching AI for Kavya, a researcher with a unique profile:
- Core strengths: developmental epigenomics, DNA methylation, pyrosequencing, hESC/mESC culture, dorsal forebrain differentiation, SH-SY5Y and Caco-2 models, immunofluorescence, molecular toxicology, endocrine disruptors, neurodegeneration disease modeling.
- Experience: 3 years QA/QC industry experience, GLP compliance, documentation standards, teaching/mentoring.

You will be given a JSON array of job opportunities to evaluate. For each job, analyze if it is a good fit for Kavya's profile.
Jobs to evaluate:
${JSON.stringify(batchInput, null, 2)}

Return ONLY a valid JSON array of objects, one for each job, with these exact keys:
- "id": string (must match the input id exactly)
- "isMatch": boolean (false if it is a postdoc requiring completed PhD, senior professor, or out of field)
- "fitTier": string ("excellent" | "good" | "stretch" | "poor")
- "scoreAdjustment": integer (an integer between -30 and +30 to adjust the base score, e.g. +10 for excellent alignment, -15 for partial fit, 0 for neutral)
- "why": string (max 140 characters, explaining the personal fit reasoning, e.g. "Fits your experience with Caco-2 models.")

Rules:
- Return ONLY the JSON array. Do not include markdown code fences (like \`\`\`json), explanations, or prose outside JSON.
- Ensure the response parses as a valid JSON array.`;

  let responseData = null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await callGeminiWithRetry(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    if (res.data && res.data.candidates && res.data.candidates[0].content.parts[0].text) {
      let text = res.data.candidates[0].content.parts[0].text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```[a-z]*\n/i, '').replace(/\n```$/g, '').trim();
      }
      responseData = JSON.parse(text);
    } else {
      throw new Error("Empty response from Gemini API");
    }
  } catch (e) {
    console.warn(`   ⚠ Gemini batch API call failed: ${e.message}. Falling back to rule-based scores for all ${toRefine.length} jobs.`);
    return jobs;
  }

  // Map evaluations back to jobs
  const evaluationsMap = new Map();
  if (Array.isArray(responseData)) {
    responseData.forEach(evalItem => {
      if (evalItem && typeof evalItem === 'object' && evalItem.id) {
        evaluationsMap.set(evalItem.id, evalItem);
      }
    });
  }

  let successfullyEvaluatedCount = 0;
  let fallbackCount = 0;

  for (const job of toRefine) {
    const evaluation = evaluationsMap.get(job.id);

    if (evaluation) {
      if (evaluation.isMatch === false) {
        job.tier = 'stretch';
        job.why = String(evaluation.why ? `[Stretch] ${evaluation.why}` : 'Gemini evaluated as lower relevance.').substring(0, 150);
        refinedJobs.push(job);
        if (DEBUG_MODE) {
          console.log(`   [AI Demoted to Stretch] "${job.title.substring(0, 45)}..." (Reason: ${job.why})`);
        }
      } else {
        const adj = parseInt(evaluation.scoreAdjustment, 10) || 0;
        job.score = Math.max(0, Math.min(Math.round(job.score + adj), 100));
        job.why = String(evaluation.why || '').substring(0, 150) || job.why;
        
        const tierMap = {
          'excellent': 'high',
          'good': 'medium',
          'high': 'high',
          'medium': 'medium',
          'stretch': 'stretch',
          'poor': 'stretch'
        };
        const fitTierLower = String(evaluation.fitTier || '').toLowerCase();
        job.tier = tierMap[fitTierLower] || tierFromScore(job.score);
        
        refinedJobs.push(job);
        successfullyEvaluatedCount++;
        if (DEBUG_MODE) {
          console.log(`   [AI Match] "${job.title.substring(0, 45)}..." Adjusted Score: ${job.score} (Why: ${job.why})`);
        }
      }
    } else {
      refinedJobs.push(job);
      fallbackCount++;
      if (DEBUG_MODE) {
        console.log(`   [AI Fallback] "${job.title.substring(0, 45)}..." Omitted by Gemini, retained with rule score: ${job.score}`);
      }
    }
  }

  console.log(`🤖 Gemini Curation Report:`);
  console.log(` - Batch size sent: ${toRefine.length}`);
  console.log(` - Successfully evaluated: ${successfullyEvaluatedCount}`);
  console.log(` - Using fallback scoring (omitted by Gemini): ${fallbackCount}`);

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
  const isIndustrySource = (source === 'industry' || source === 'novo' || source === 'medicon');
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
  const sourceType = (source === 'industry' || source === 'novo' || source === 'medicon') ? 'industry' : 'academic';
  
  // Clean type categorization (phd vs industry) to power toggle buttons
  const finalType = (roleType === 'phd') ? 'phd' : ((sourceType === 'industry' || roleType === 'industry-scientist' || roleType === 'qa-qc') ? 'industry' : 'phd');

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
  else if (source === 'medicon') portal = 'Medicon Village';
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
  else if (source === 'uk') portal = 'FindAPhD (UK)';
  else if (source === 'switzerland') {
    if (orgName.includes('ETH')) portal = 'ETH Zurich';
    else if (orgName.includes('Basel')) portal = 'University of Basel';
    else if (orgName.includes('Bern')) portal = 'University of Bern';
    else portal = 'Swiss Portals';
  }
  else if (source === 'novo') portal = 'Novo Nordisk Careers';
  else if (source === 'resteurope') portal = 'Max Planck / German Portals';
  else if (source === 'finland') {
    if (orgName.includes('Helsinki')) portal = 'University of Helsinki';
    else if (orgName.includes('Turku')) portal = 'University of Turku';
    else if (orgName.includes('Åbo Akademi')) portal = 'Åbo Akademi';
    else if (orgName.includes('Oulu')) portal = 'University of Oulu';
    else portal = 'Finland Portals';
  }
  else if (source === 'austria') {
    if (orgName.includes('BioCenter') || orgName.includes('IMP') || orgName.includes('IMBA') || orgName.includes('GMI') || orgName.includes('VBCF')) portal = 'Vienna BioCenter';
    else if (orgName.includes('CeMM')) portal = 'CeMM Vienna';
    else if (orgName.includes('Medical University') || orgName.includes('MedUni')) portal = 'Medical University of Vienna';
    else if (orgName.includes('University of Vienna') || orgName.includes('Univie')) portal = 'University of Vienna';
    else portal = 'Austria Portals';
  }
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
  'france': 'france', 'fr': 'france',
  'ireland': 'ireland', 'ie': 'ireland',
  'united kingdom': 'united kingdom', 'uk': 'united kingdom', 'gb': 'united kingdom',
  'england': 'united kingdom', 'scotland': 'united kingdom', 'wales': 'united kingdom',
  'northern ireland': 'united kingdom',
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
  'melbourne': 'australia', 'sydney': 'australia', 'brisbane': 'australia', 'adelaide': 'australia', 'perth': 'australia', 'canberra': 'australia',
  'london': 'united kingdom', 'oxford': 'united kingdom', 'cambridge': 'united kingdom',
  'manchester': 'united kingdom', 'edinburgh': 'united kingdom', 'glasgow': 'united kingdom',
  'bristol': 'united kingdom', 'birmingham': 'united kingdom', 'leeds': 'united kingdom',
  'sheffield': 'united kingdom', 'liverpool': 'united kingdom', 'newcastle': 'united kingdom',
  'nottingham': 'united kingdom', 'southampton': 'united kingdom', 'cardiff': 'united kingdom',
  'belfast': 'united kingdom', 'leicester': 'united kingdom', 'exeter': 'united kingdom',
  'paris': 'france', 'strasbourg': 'france', 'lyon': 'france', 'marseille': 'france',
  'dublin': 'ireland', 'galway': 'ireland', 'cork': 'ireland',
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

function decodeHtmlEntities(str) {
  if (!str) return '';
  return cheerio.load(`<body>${str}</body>`)('body').text().trim();
}

function pushJob(jobs, raw, defaults = {}) {
  const rawTitle = decodeHtmlEntities(raw.title);
  const title = cleanText(rawTitle);
  if (!title || title.length < 6) return;
  const baseUrl = defaults.baseUrl || raw.baseUrl || raw.url || '';
  jobs.push({
    title,
    org: cleanText(decodeHtmlEntities(raw.org || defaults.org || 'Unknown Organisation')),
    country: raw.country || defaults.country || '',
    location: cleanText(decodeHtmlEntities(raw.location || defaults.location || '')),
    description: cleanText(decodeHtmlEntities(raw.description || defaults.description || '')),
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
  
  const queries = ['epigenetics', 'toxicology', 'stem cell', 'circadian', 'bisphenol', 'microrna', 'chemoresistance', 'zebrafish', 'drosophila'];
  
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

async function scrapeDenmark() {
  const jobs = [];
  
  // 1. Copenhagen University (UCPH / KU) RSS Feed
  try {
    const rssUrl = 'https://employment.ku.dk/all-vacancies/?get_rss=1';
    const res = await axios.get(rssUrl, {
      headers: {
        'Accept': 'application/xml, text/xml, */*',
        'User-Agent': USER_AGENTS[0]
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: true }),
      timeout: REQUEST_TIMEOUT
    }).catch(async (err) => {
      // Retry with rejectUnauthorized false if SSL fails
      if (err.message.includes('certificate') || err.message.includes('SSL') || err.message.includes('unable to verify')) {
        return axios.get(rssUrl, {
          headers: {
            'Accept': 'application/xml, text/xml, */*',
            'User-Agent': USER_AGENTS[0]
          },
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
          timeout: REQUEST_TIMEOUT
        });
      }
      throw err;
    });
    
    const $ = cheerio.load(res.data, { xmlMode: true });
    const items = $('item');
    if (DEBUG_MODE) {
      console.log(`  ℹ Found ${items.length} items in UCPH (Copenhagen) RSS feed.`);
    }
    
    items.each((_, el) => {
      const item = $(el);
      const title = item.find('title').text().trim();
      const rawUrl = item.find('link').text().trim() || item.find('guid').text().trim() || '';
      
      // Reconstruct link: extract show=XXXXXX
      const idMatch = rawUrl.match(/[?&]show=(\d+)/);
      const url = idMatch ? `https://employment.ku.dk/all-vacancies/?show=${idMatch[1]}` : 'https://employment.ku.dk/all-vacancies/';
      
      const rawDesc = item.find('description').text() || '';
      const description = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      
      // Parse deadline from description
      let deadline = '📅 Rolling';
      const deadlineRegex = /(?:application\s+)?deadline(?:\s+for\s+applications)?\s*:\s*([0-9]+\s+[a-zA-Z]+\s+[0-9]{4}|[a-zA-Z]+\s+[0-9]+,\s+[0-9]{4})/i;
      const match = description.match(deadlineRegex);
      if (match) {
        deadline = match[1].trim();
      }
      
      if (title) {
        pushJob(jobs, {
          title,
          org: 'University of Copenhagen',
          country: 'denmark',
          location: 'Copenhagen, Denmark',
          description,
          url,
          deadline
        }, { type: 'phd' });
      }
    });
  } catch (e) {
    console.warn(`  ⚠ UCPH (Copenhagen) RSS scrape failed: ${e.message}`);
  }
  
  // 2. Aarhus University (AU) Emply preloaded JSON list
  try {
    const url = 'https://www.au.dk/en/about/vacant-positions/';
    const res = await axios.get(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'User-Agent': USER_AGENTS[0]
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Aarhus can also use standard/unauthorized agent
      timeout: REQUEST_TIMEOUT
    });
    
    const text = res.data;
    const match = text.match(/DYCON\.EmplyData\..*?\.vacancies\s*=\s*([\s\S]*?);\s*DYCON/);
    if (match) {
      const vacancies = JSON.parse(match[1]);
      if (DEBUG_MODE) {
        console.log(`  ℹ Found ${vacancies.length} vacancies in Aarhus JSON.`);
      }
      
      for (const item of vacancies) {
        if (!item.title) continue;
        
        // deadline_date is usually "YYYY-MM-DD"
        let deadline = '📅 Rolling';
        if (item.deadline_date) {
          try {
            const date = new Date(item.deadline_date);
            if (!isNaN(date)) {
              deadline = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            } else {
              deadline = item.deadline_date;
            }
          } catch (e) {
            deadline = item.deadline_date;
          }
        }
        
        const relativeLink = item.link || '';
        const fullLink = relativeLink.startsWith('http') ? relativeLink : `https://international.au.dk${relativeLink}`;
        
        pushJob(jobs, {
          title: item.title,
          org: 'Aarhus University',
          country: 'denmark',
          location: item.location?.name ? `${item.location.name}, Denmark` : 'Aarhus, Denmark',
          description: item.teaser || item.faculty || '',
          url: fullLink,
          deadline
        }, { type: 'phd' });
      }
    } else {
      console.warn(`  ⚠ Could not find Aarhus (AU) JSON script variable on page.`);
    }
  } catch (e) {
    console.warn(`  ⚠ Aarhus University scrape failed: ${e.message}`);
  }
  
  return deduplicateRawJobs(jobs);
}

async function scrapeNatureCareers() {
  const jobs = [];
  const queries = ['stem cell', 'epigenetics', 'toxicology', 'neuroscience'];
  
  for (const q of queries) {
    const searchUrl = `https://www.nature.com/naturecareers/jobs/science-jobs/europe/?keywords=${encodeURIComponent(q)}`;
    const rssUrl = `${searchUrl}&rss=1`;
    
    // 1. Fetch Nature RSS (resilient to blocks)
    try {
      const rss = await safeFetch(rssUrl);
      if (rss) {
        const $ = cheerio.load(rss, { xmlMode: true });
        $('item, entry').each((_, el) => {
          const title = $(el).find('title').first().text().trim();
          const org = $(el).find('author name, author, source').first().text().trim();
          const url = $(el).find('link').first().attr('href') || $(el).find('link').first().text() || $(el).find('guid').first().text();
          const desc = $(el).find('description, summary, content').first().text().trim();

          if (!title) return;

          // Attempt country resolution from description text or org
          let country = resolveCountry(org);
          if (!country && desc) {
            country = resolveCountry(desc);
          }

          if (country) {
            pushJob(jobs, {
              title,
              org: org || 'Nature Careers',
              country,
              location: country.toUpperCase(),
              description: desc.replace(/<[^>]*>/g, ' '),
              url,
              deadline: '📅 Rolling'
            }, { type: 'phd' });
          }
        });
      }
    } catch (e) {
      console.warn(`  ⚠ Nature Careers RSS failed for "${q}": ${e.message}`);
    }

    // 2. Fetch Nature HTML (supplemental cards)
    try {
      const html = await safeFetch(searchUrl);
      if (html) {
        const $ = cheerio.load(html);
        $('li[class*="ResultsList"], article, .c-card, li').each((_, el) => {
          const titleLink = $(el).find('h3 a, h2 a, a[href*="/naturecareers/job/"]').first();
          const title = titleLink.text().trim();
          const link = titleLink.attr('href') || '';
          const org = $(el).find('[class*="employer"], [class*="organization"]').first().text().trim();
          const locText = $(el).find('[class*="location"]').first().text().trim();
          const desc = $(el).find('p').first().text().trim();

          if (title && link) {
            let country = resolveCountry(locText);
            if (!country && org) country = resolveCountry(org);

            if (country) {
              pushJob(jobs, {
                title,
                org: org || 'Nature Careers',
                country,
                location: locText || country.toUpperCase(),
                description: desc,
                url: link.startsWith('http') ? link : `https://www.nature.com${link}`,
                deadline: '📅 Rolling'
              }, { type: 'phd' });
            }
          }
        });
      }
    } catch (e) {
      console.warn(`  ⚠ Nature Careers HTML failed for "${q}": ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 1000));
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

async function scrapeMediconVillage() {
  const jobs = [];
  const url = 'https://www.mediconvillage.se/en/open-positions/';
  try {
    const html = await safeFetch(url);
    if (html) {
      const $ = cheerio.load(html);
      $('article.teaser-job').each((_, el) => {
        const title = cleanText($(el).find('.teaser__title').text());
        const link = $(el).find('a.teaser__inner').attr('href') || $(el).find('a').attr('href') || '';
        const org = cleanText($(el).find('.teaser__text').text()) || 'Medicon Village Member';
        
        let deadline = '📅 Rolling';
        $(el).find('ul.teaser__date li').each((_, li) => {
          const text = $(li).text();
          if (text.includes('Application deadline:')) {
            const dateStr = cleanText(text.replace('Application deadline:', ''));
            if (dateStr) {
              deadline = `📅 ${dateStr}`;
            }
          }
        });

        if (title && link) {
          pushJob(jobs, {
            title,
            org,
            country: 'sweden',
            location: 'Lund, Sweden',
            url: link.startsWith('http') ? link : `https://www.mediconvillage.se${link}`,
            deadline
          }, { type: 'industry' });
        }
      });
    }
  } catch (e) {
    console.warn(`  ⚠ Medicon Village scrape failed: ${e.message}`);
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
      $('a.career-card').each((_, el) => {
        const title = cleanText($(el).find('.career-card__title').text());
        const link = $(el).attr('href') || '';
        const org = cleanText($(el).find('.career-card__data span').first().text()) || 'SciLifeLab';
        const deadlineText = cleanText($(el).find('.deadline u').text());
        let deadline = '📅 Rolling';
        if (deadlineText) {
          deadline = `📅 ${deadlineText}`;
        }
        if (title && title.length > 8) {
          jobs.push({
            title,
            org,
            country: 'sweden',
            location: 'Stockholm/Uppsala',
            url: link.startsWith('http') ? link : `https://www.scilifelab.se${link}`,
            deadline
          });
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
    { name: 'Helmholtz Association', country: 'germany', location: 'Germany', url: 'https://www.helmholtz.de/en/career/job-vacancies/?tx_solr%5Bq%5D=biology+epigenetics+stem+cell+toxicology+circadian' },
    { name: 'DKFZ', country: 'germany', location: 'Heidelberg', url: 'https://www.dkfz.de/en/stellenangebote/index.php' },
    { name: 'VIB', country: 'belgium', location: 'Ghent', url: 'https://vib.be/careers?filter=PhD' },
    { name: 'KU Leuven', country: 'belgium', location: 'Leuven', url: 'https://www.kuleuven.be/personeel/jobsite/en/jobs?q=biology' },
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
  // Novo Nordisk jobs are hosted on careers.novonordisk.com (SAP SuccessFactors).
  // IMPORTANT: Direct search URLs require a session cookie set by visiting home page first.
  // We use a single persistent Playwright context across all queries.
  const jobs = [];
  const queries = [
    'scientist',
    'cell biology',
    'molecular biology',
    'toxicology',
    'epigenetics',
    'laboratory technician',
    'research associate'
  ];

  // Denmark/Nordic location keywords to filter global (worldwide) results
  const nordicLocations = [
    'denmark', 'danish', 'bagsv', 'måløv', 'maalov', 'copenhagen', 'københavn',
    'søborg', 'kalundborg', 'hillerød', 'gentofte', 'lyngby', 'allerød',
    'sweden', 'stockholm', 'göteborg', 'gothenburg', 'malmö', 'lund'
  ];

  const seenUrls = new Set();

  await acquirePlaywrightSlot();
  let context;
  try {
    const browser = await getBrowser();
    if (!browser) {
      console.log('  ⚠ Novo Nordisk: browser unavailable');
      return [];
    }
    context = await browser.newContext({
      userAgent: USER_AGENTS[0],
      locale: 'en-GB',
      viewport: { width: 1366, height: 900 }
    });

    // Block images/fonts to speed up
    const page = await context.newPage();
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });

    // 1. Visit home page first to initialize SAP SuccessFactors session cookies
    console.log('  ↳ NN: Initializing session (home page)...');
    await page.goto('https://careers.novonordisk.com/?locale=en_GB', {
      waitUntil: 'networkidle', timeout: 30000
    }).catch(() => {});
    await page.waitForTimeout(2000);

    // 2. Iterate through each keyword query
    for (const q of queries) {
      const url = `https://careers.novonordisk.com/search/?q=${encodeURIComponent(q)}&locale=en_GB`;
      console.log(`  ↳ NN query: "${q}"`);

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForSelector('[class*="jobTitle"] a', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1500);

        const html = await page.content();
        const $ = require('cheerio').load(html);

        $('[class*="jobTitle"] a').each((_, el) => {
          const rawHref = $(el).attr('href') || '';
          const title = $(el).text().trim();

          // Skip header sort links and generic nav
          if (!title || title.length < 8 || title === 'Job Title' || isGenericNavigationLink(title)) return;
          if (!rawHref || !rawHref.includes('/job/')) return;

          // Resolve relative hrefs to full URL (page HTML uses relative paths)
          const href = rawHref.startsWith('http') ? rawHref : `https://careers.novonordisk.com${rawHref}`;
          if (seenUrls.has(href)) return;
          seenUrls.add(href);

          // Extract location from URL slug: /job/[City]-[Title]/[id]/
          const urlParts = href.split('/job/')[1] || '';
          const locationSlug = urlParts.split('-')[0] || '';
          let locationDecoded = '';
          try { locationDecoded = decodeURIComponent(locationSlug).toLowerCase(); } catch(e) { locationDecoded = locationSlug.toLowerCase(); }

          // Filter: only keep Nordic/Denmark locations
          const isNordic = nordicLocations.some(loc =>
            locationDecoded.includes(loc) || href.toLowerCase().includes(loc)
          );
          if (!isNordic) return;

          jobs.push({
            title,
            org: 'Novo Nordisk',
            country: 'denmark',
            location: locationSlug ? `${decodeURIComponent(locationSlug)}, Denmark` : 'Denmark',
            url: href
          });
        });

      } catch(e) {
        console.log(`  ⚠ NN query "${q}" failed: ${e.message.slice(0, 60)}`);
      }

      await new Promise(r => setTimeout(r, 1000));
    }

  } catch(e) {
    console.log(`  ⚠ scrapeNovoNordisk error: ${e.message.slice(0, 80)}`);
  } finally {
    if (context) await context.close().catch(() => {});
    releasePlaywrightSlot();
  }

  console.log(`  ✓ Novo Nordisk: ${jobs.length} raw jobs found (before dedup)`);
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

  // 2. Novo Nordisk (Playwright scraper — Denmark)
  jobs.push(...await scrapeNovoNordisk());

  // 3. Workday-based companies — use CXS JSON API (verified working endpoints only)
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
  const terms = ['phd', 'stipendiat', 'biology', 'biologi'];
  const uniqueItems = [];
  const seenIds = new Set();
  const headers = { 'User-Agent': USER_AGENTS[0] };

  for (const term of terms) {
    try {
      const url = `https://publicapi.jobbnorge.no/v1/Jobs?term=${encodeURIComponent(term)}`;
      const res = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT }).catch(() => null);
      const data = res?.data;
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item.id || !item.title) continue;
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            uniqueItems.push(item);
          }
        }
      }
    } catch (e) {
      console.warn(`  ⚠ Failed to fetch Jobbnorge listings for term "${term}": ${e.message}`);
    }
  }

  // Pre-filter with title exclusions
  const preFiltered = uniqueItems.filter(item => {
    const excl = checkExclusionReason(item.title, '');
    return !excl;
  });

  if (DEBUG_MODE) {
    console.log(`  ℹ Jobbnorge: Found ${uniqueItems.length} unique items, pre-filtered down to ${preFiltered.length}`);
  }

  // Fetch detailed descriptions in batches
  const batchSize = 10;
  for (let i = 0; i < preFiltered.length; i += batchSize) {
    const batch = preFiltered.slice(i, i + batchSize);
    await Promise.all(batch.map(async (item) => {
      try {
        // Fetch languages
        const langRes = await axios.get(`https://id.jobbnorge.no/api/joblisting/languages?jobId=${item.id}&templateId=0`, { headers, timeout: 5000 }).catch(() => null);
        const activeLangs = langRes?.data?.activeLanguages || [];
        if (activeLangs.length === 0) return;
        const langId = activeLangs[0];
        
        // Fetch detail
        const detailRes = await axios.get(`https://id.jobbnorge.no/api/joblisting?jobId=${item.id}&languageId=${langId}`, { headers, timeout: 5000 }).catch(() => null);
        const components = detailRes?.data?.components || [];
        const fullDescription = components.map(c => (c.heading || '') + ' ' + (c.text || '')).join(' ');
        
        const deadline = item.deadline ? `📅 ${item.deadline}` : '📅 Rolling';
        pushJob(jobs, {
          title: item.title,
          org: item.employer || 'Jobbnorge Norway',
          location: item.location || 'Norway',
          description: fullDescription || '',
          url: item.link,
          deadline: deadline
        }, { country: 'norway', baseUrl: 'https://www.jobbnorge.no/' });
      } catch (e) {
        console.warn(`  ⚠ Failed to fetch details for Jobbnorge job ${item.id}: ${e.message}`);
      }
    }));
    if (i + batchSize < preFiltered.length) {
      await new Promise(r => setTimeout(r, 100)); // Short throttle delay
    }
  }

  return deduplicateRawJobs(jobs);
}

async function scrapeFinland() {
  const jobs = [];

  // 1. University of Helsinki (SuccessFactors via Playwright)
  try {
    const helsinkiUrl = 'https://jobs.helsinki.fi/search/?q=biology';
    const helsinkiJobs = await parseProtectedPage(
      helsinkiUrl,
      { org: 'University of Helsinki', country: 'finland', location: 'Helsinki', baseUrl: 'https://jobs.helsinki.fi' },
      {
        card: 'tr.data-row',
        title: 'a.jobTitle-link',
        link: 'a.jobTitle-link',
        deadline: 'span.jobDate'
      },
      { waitForSelector: 'tr.data-row', minRenderedFallback: 1 }
    );
    jobs.push(...helsinkiJobs);
  } catch (e) {
    console.warn(`  ⚠ Failed to scrape University of Helsinki: ${e.message}`);
  }

  // 2. University of Turku (TalentAdore JSON API)
  try {
    const utuUrl = 'https://ats.talentadore.com/positions/3VMfJS4/json?v=2&display_language=en&tags=&notTags=&categories=tags_and_extras';
    const data = await safeFetch(utuUrl);
    if (data && Array.isArray(data.jobs)) {
      for (const j of data.jobs) {
        if (!j.name) continue;
        const deadline = j.due_date ? `📅 ${j.due_date}` : '📅 Rolling';
        pushJob(jobs, {
          title: j.name,
          org: 'University of Turku',
          location: j.city || 'Turku',
          description: j.description_text || '',
          url: j.link,
          deadline: deadline
        }, { country: 'finland', baseUrl: 'https://www.utu.fi' });
      }
    }
  } catch (e) {
    console.warn(`  ⚠ Failed to scrape University of Turku (TalentAdore): ${e.message}`);
  }

  // 3. Åbo Akademi (Rekrytointi html)
  try {
    const aboUrl = 'https://abo.rekrytointi.com/paikat/index.php?o=A_LOJ&list=1&key=&lang=en';
    const html = await safeFetch(aboUrl);
    if (html) {
      const $ = cheerio.load(html);
      const groups = {};
      $('a[href*="/paikat/index.php?jid="]').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (!groups[href]) groups[href] = [];
        groups[href].push(text);
      });

      for (const [href, texts] of Object.entries(groups)) {
        let title = '';
        let deadline = '📅 Rolling';
        for (const text of texts) {
          if (/\d{4}-\d{2}-\d{2}/.test(text)) {
            deadline = `📅 ${text}`;
          } else if (text && !title) {
            title = text;
          }
        }
        if (title) {
          pushJob(jobs, {
            title,
            org: 'Åbo Akademi University',
            location: 'Turku',
            description: '',
            url: href,
            deadline
          }, { country: 'finland', baseUrl: 'https://abo.rekrytointi.com' });
        }
      }
    }
  } catch (e) {
    console.warn(`  ⚠ Failed to scrape Åbo Akademi: ${e.message}`);
  }

  // 4. University of Oulu (Varbi RSS)
  try {
    const ouluUrl = 'https://oulunyliopisto.varbi.com/what:rssfeed/';
    const xml = await safeFetch(ouluUrl);
    if (xml) {
      const parsed = parseRssItems(xml, {
        org: 'University of Oulu',
        country: 'finland',
        location: 'Oulu',
        baseUrl: 'https://oulunyliopisto.varbi.com/en/'
      });
      jobs.push(...parsed);
    }
  } catch (e) {
    console.warn(`  ⚠ Failed to scrape University of Oulu: ${e.message}`);
  }

  return deduplicateRawJobs(jobs);
}

async function scrapeAustria() {
  const jobs = [];

  // 1. Vienna BioCenter (Centralized portal)
  try {
    const vbcUrl = 'https://www.viennabiocenter.org/career/open-positions/';
    const html = await renderPageHtml(vbcUrl, { waitForSelector: 'div.item' });
    if (html) {
      const $ = cheerio.load(html);
      $('div.item').each((_, el) => {
        const titleEl = $(el).find('div.title');
        const title = cleanText(titleEl.text());
        const linkEl = $(el).find('a[href]');
        const href = linkEl.attr('href') || '';
        const imgAlt = $(el).find('img').attr('alt') || '';
        
        let org = 'Vienna BioCenter';
        if (imgAlt) {
          org = imgAlt.trim();
        }
        
        const timeEl = $(el).find('div.time time');
        let deadline = undefined;
        if (timeEl.length > 0) {
          deadline = cleanText(timeEl.text());
        }

        if (title && href) {
          pushJob(jobs, {
            title,
            org,
            location: 'Vienna, Austria',
            url: href.startsWith('http') ? href : `https://www.viennabiocenter.org${href}`,
            deadline: deadline ? `📅 ${deadline}` : undefined
          }, { country: 'austria' });
        }
      });
    }
  } catch (e) {
    console.warn(`  ⚠ Vienna BioCenter scrape failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1000));

  // 2. CeMM Vienna
  try {
    const cemmUrl = 'https://cemm.at/join-cemm/open-positions';
    const html = await safeFetch(cemmUrl);
    if (html) {
      const $ = cheerio.load(html);
      $('div.row.py-3.py-md-4, div.row.py-3').each((_, el) => {
        const titleEl = $(el).find('.item-title, h3');
        const title = cleanText(titleEl.text());
        const linkEl = $(el).find('a[href]');
        const href = linkEl.attr('href') || '';
        const descText = cleanText($(el).find('.item-text').text());
        const descTag = cleanText($(el).find('.item-tag').text());
        const desc = `${descText} ${descTag}`.trim();
        const badgeEl = $(el).find('.item-badge, span.badge');
        let deadline = undefined;
        if (badgeEl.length > 0) {
          deadline = cleanText(badgeEl.text());
        }

        if (title && href) {
          pushJob(jobs, {
            title,
            org: 'CeMM Vienna',
            location: 'Vienna, Austria',
            description: desc,
            url: href.startsWith('http') ? href : `https://cemm.at${href}`,
            deadline: deadline ? `📅 ${deadline}` : undefined
          }, { country: 'austria' });
        }
      });
    }
  } catch (e) {
    console.warn(`  ⚠ CeMM Vienna scrape failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1000));

  // 3. University of Vienna (UniVie)
  try {
    const univieUrl = 'https://jobs.univie.ac.at/search/?q=biology';
    const pageJobs = await parseProtectedPage(univieUrl, { country: 'austria', location: 'Vienna' }, {
      card: 'tr.data-row',
      title: 'a.jobTitle-link',
      link: 'a.jobTitle-link',
      org: 'span.jobFacility',
      deadline: 'span.jobDate'
    }, { waitForSelector: 'tr.data-row', minRenderedFallback: 1 });

    for (const j of pageJobs) {
      const fac = j.org && j.org !== 'Unknown Organisation' ? j.org : '';
      j.org = fac ? `University of Vienna - ${fac}` : 'University of Vienna';
      j.location = 'Vienna, Austria';
      if (j.url && !j.url.startsWith('http')) {
        j.url = `https://jobs.univie.ac.at${j.url}`;
      }
      jobs.push(j);
    }
  } catch (e) {
    console.warn(`  ⚠ University of Vienna scrape failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1000));

  // 4. Medical University of Vienna (MedUni Wien)
  try {
    const meduniUrl = 'https://www.meduniwien.ac.at/web/en/karriere/offene-stellen/';
    const pageJobs = await parseProtectedPage(meduniUrl, { country: 'austria', location: 'Vienna' }, {
      card: '.accordion__collapse',
      title: 'strong',
      link: 'a[href]'
    }, { waitForSelector: '.accordion__collapse', minRenderedFallback: 1 });

    if (pageJobs && pageJobs.length > 0) {
      const renderedHtml = await renderPageHtml(meduniUrl, { waitForSelector: '#29980' });
      if (renderedHtml) {
        const $ = cheerio.load(renderedHtml);
        const academicSection = $('#29980');
        let currentDeadline = undefined;
        
        academicSection.find('h3, li').each((_, el) => {
          const tagName = $(el).prop('tagName').toLowerCase();
          if (tagName === 'h3') {
            currentDeadline = cleanText($(el).text());
          } else if (tagName === 'li') {
            const strongTitle = $(el).find('strong').first().text();
            const title = cleanText(strongTitle || $(el).text());
            const fullText = cleanText($(el).text());
            
            let dept = '';
            const htmlContent = $(el).html() || '';
            const parts = htmlContent.split(/<br\s*\/?>/i);
            if (parts.length > 1) {
              dept = cleanText(cheerio.load(parts[1]).text());
            }

            if (title) {
              pushJob(jobs, {
                title,
                org: dept ? `Medical University of Vienna - ${dept}` : 'Medical University of Vienna',
                location: 'Vienna, Austria',
                description: fullText,
                url: meduniUrl,
                deadline: currentDeadline ? `📅 ${currentDeadline}` : undefined
              }, { country: 'austria' });
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn(`  ⚠ Medical University of Vienna scrape failed: ${e.message}`);
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

async function scrapeFindAPhD() {
  const jobs = [];
  const queries = ['epigenetics', 'toxicology', 'stem cell', 'circadian'];
  
  for (const q of queries) {
    const url = `https://www.findaphd.com/phds/?Keywords=${encodeURIComponent(q)}`;
    try {
      const defaults = { baseUrl: url, type: 'phd' };
      const html = await parseProtectedPage(url, defaults, {
        card: 'div.resultsRow, .resultsRow',
        title: 'a[href*="/phds/project/"], a.h4.text-dark',
        link: 'a[href*="/phds/project/"], a.h4.text-dark',
        org: 'a.instLink, [class*="institution"], [class*="university"]',
        description: 'div.desc, [class*="description"]',
      }, { minRenderedFallback: 1 });

      const $ = cheerio.load(html || '');

      $('div.resultsRow, .resultsRow').each((_, el) => {
        const titleEl = $(el).find('a[href*="/phds/project/"], a.h4.text-dark').first();
        const title = titleEl.text().trim();
        const link = titleEl.attr('href') || '';
        const org = $(el).find('a.instLink, [class*="institution"], [class*="university"]').first().text().trim();
        const desc = $(el).find('div.desc, [class*="description"]').text().trim();

        if (!title) return;

        let country = null;

        // Step A: Parse country from href links in the card (e.g., /phds/germany/)
        $(el).find('a[href]').each((_, aEl) => {
          const href = $(aEl).attr('href') || '';
          const match = href.match(/\/phds\/([a-z\-]+)\//i);
          if (match) {
            const candidate = match[1].replace('-', ' ');
            const resolved = resolveCountry(candidate);
            if (resolved) {
              country = resolved;
              return false; // Break loop
            }
          }
        });

        // Step B: Fallback to resolving country from the organization (institution) name
        if (!country && org) {
          country = resolveCountry(org);
        }

        if (country) {
          let deadline = '📅 Rolling';
          const deadlineMatch = desc ? desc.match(/(?:Deadline|Closing date):\s*([^\n\r]+)/i) : null;
          if (deadlineMatch) {
            deadline = deadlineMatch[1].trim();
          }

          jobs.push({
            title,
            org: org || 'Unknown Institution',
            country,
            location: country.toUpperCase(),
            description: desc,
            url: link.startsWith('http') ? link : `https://www.findaphd.com${link}`,
            deadline
          });
        }
      });
    } catch (e) {
      console.warn(`  ⚠ FindAPhD scrape failed for "${q}": ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeJobsAcUK() {
  const jobs = [];
  const queries = ['epigenetics', 'toxicology', 'stem cell', 'circadian'];
  
  for (const q of queries) {
    const url = `https://www.jobs.ac.uk/search/?keywords=${encodeURIComponent(q)}`;
    try {
      const html = await safeFetch(url);
      if (html) {
        const $ = cheerio.load(html);
        $('.j-search-result__result').each((_, el) => {
          const titleLink = $(el).find('.j-search-result__text a');
          const title = titleLink.text().trim();
          const href = titleLink.attr('href');
          const org = $(el).find('.j-search-result__employer').text().trim();
          const dept = $(el).find('.j-search-result__department').text().trim();
          const expires = $(el).find('.j-search-result__date--blue').text().trim();
          
          let location = 'United Kingdom';
          $(el).find('div').each((_, divEl) => {
            const txt = $(divEl).text();
            if (txt.includes('Location:')) {
              location = txt.replace('Location:', '').trim();
            }
          });
          
          let desc = $(el).find('.j-search-result__info').text().trim();
          if (dept) desc = `${dept}. ${desc}`;
          
          let deadline = '📅 Rolling';
          if (expires) {
            deadline = expires;
          }
          
          if (title && href) {
            pushJob(jobs, {
              title,
              org: org || 'UK Institution',
              country: 'united kingdom',
              location,
              description: desc,
              url: href.startsWith('http') ? href : `https://www.jobs.ac.uk${href}`,
              deadline
            }, { type: 'phd' });
          }
        });
      }
    } catch (e) {
      console.warn(`  ⚠ Jobs.ac.uk scrape failed for "${q}": ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeSwitzerland() {
  const jobs = [];
  
  // 1. ETH Zurich Scraper (directly using Axios + Cheerio)
  try {
    const url = 'https://jobs.ethz.ch/';
    const html = await safeFetch(url);
    if (html) {
      const $ = cheerio.load(html);
      $('a[href*="/job/view/"]').each((_, el) => {
        const rawText = $(el).text().replace(/\s+/g, ' ').trim();
        const parts = rawText.split('|').map(p => p.trim());
        const mainPart = parts[0] || '';
        const dept = parts[1] || '';
        
        // Match Date (DD.MM.YYYY)
        const dateMatch = mainPart.match(/(\d{2}\.\d{2}\.\d{4})$/);
        const datePlaced = dateMatch ? dateMatch[1] : '';
        let titleAndDetails = dateMatch ? mainPart.replace(datePlaced, '').trim() : mainPart;
        
        // Match Percentage & Location
        const pctMatch = titleAndDetails.match(/(\d+%\s*,.*)$/);
        let title = titleAndDetails;
        let locationAndType = '';
        if (pctMatch) {
          locationAndType = pctMatch[1].trim();
          title = titleAndDetails.replace(locationAndType, '').trim();
        }
        
        if (title && title.length > 5) {
          pushJob(jobs, {
            title,
            org: 'ETH Zurich',
            country: 'switzerland',
            location: locationAndType || 'Zurich, Switzerland',
            description: `Department: ${dept}. Details: ${locationAndType}. Placed: ${datePlaced}.`,
            url: `https://jobs.ethz.ch${$(el).attr('href')}`,
          }, { type: 'phd' });
        }
      });
    }
  } catch (e) {
    console.warn(`  ⚠ ETH Zurich scrape failed: ${e.message}`);
  }

  // 2. University of Basel (direct iframe/localized page to avoid 403 blocks)
  try {
    const baselUrl = 'https://jobs.unibas.ch/?lang=en';
    const pageJobs = await parseProtectedPage(baselUrl, {
      org: 'University of Basel', country: 'switzerland', location: 'Basel', baseUrl: 'https://jobs.unibas.ch/'
    }, {
      card: '.job',
      title: 'a.job-title',
      link: 'a.job-title',
    }, { waitForSelector: '.job, a.job-title', minRenderedFallback: 1 });
    
    for (const j of pageJobs) {
      jobs.push(j);
    }
  } catch (e) {
    console.warn(`  ⚠ University of Basel scrape failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1000));

  // 3. University of Bern (crawling the English iframe directly to capture React rendering)
  try {
    const bernUrl = 'https://ohws.prospective.ch/public/v2/careercenter/1001892/?lang=en';
    const pageJobs = await parseProtectedPage(bernUrl, {
      org: 'University of Bern', country: 'switzerland', location: 'Bern', baseUrl: 'https://jobs.unibe.ch'
    }, {
      card: 'li.job-list-item',
      title: 'h4',
      link: 'a',
    }, { waitForSelector: 'li.job-list-item, h4', minRenderedFallback: 1 });
    
    for (const j of pageJobs) {
      jobs.push(j);
    }
  } catch (e) {
    console.warn(`  ⚠ University of Bern scrape failed: ${e.message}`);
  }

  return deduplicateRawJobs(jobs);
}

async function scrapeEPFL() {
  const jobs = [];
  const queries = ['phd', 'postdoc', 'stem cell', 'epigenetics', 'toxicology'];
  
  for (const q of queries) {
    const url = `https://careers.epfl.ch/search/?q=${encodeURIComponent(q)}`;
    try {
      const pageJobs = await parseProtectedPage(
        url,
        { 
          org: 'EPFL Lausanne', 
          country: 'switzerland', 
          location: 'Lausanne', 
          baseUrl: 'https://careers.epfl.ch',
          description: `EPFL position matching query: ${q}.`
        },
        {
          card: 'tr.data-row',
          title: 'a.jobTitle-link',
          link: 'a.jobTitle-link'
        },
        { waitForSelector: 'tr.data-row', minRenderedFallback: 1 }
      );
      jobs.push(...pageJobs);
    } catch (e) {
      console.warn(`  ⚠ EPFL search failed for "${q}": ${e.message}`);
    }
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeLeibniz() {
  const jobs = [];
  const url = 'https://www.leibniz-gemeinschaft.de/en/careers/jobs';
  try {
    const html = await safeFetch(url);
    if (html) {
      const $ = cheerio.load(html);
      $('ol.flow-ml li.listing-item').each((_, el) => {
        const a = $(el).find('h4.sans-h5 a.link').first();
        const title = a.text().trim();
        const link = a.attr('href') || '';
        const rawMeta = $(el).find('p.mono-i1').text().trim().replace(/\s+/g, ' ');
        
        if (!title || !link) return;
        
        const commaIdx = rawMeta.lastIndexOf(',');
        const org = commaIdx !== -1 ? rawMeta.substring(0, commaIdx).trim() : rawMeta;
        const loc = commaIdx !== -1 ? rawMeta.substring(commaIdx + 1).trim() : 'Germany';
        const country = resolveCountry(loc) || 'germany';

        pushJob(jobs, {
          title,
          org: org || 'Leibniz Association',
          country,
          location: loc,
          description: `Research post at ${org}. Location: ${loc}.`,
          url: link.startsWith('http') ? link : `https://www.leibniz-gemeinschaft.de${link}`
        }, { type: 'phd' });
      });
    }
  } catch (e) {
    console.warn(`  ⚠ Leibniz Association scrape failed: ${e.message}`);
  }
  return deduplicateRawJobs(jobs);
}

async function scrapeAcademics() {
  const jobs = [];
  const queries = ['phd', 'postdoc', 'stem cell', 'epigenetics', 'toxicology', 'circadian'];
  
  for (const q of queries) {
    const url = `https://www.academics.com/jobs?q=${encodeURIComponent(q)}`;
    try {
      const html = await renderPageHtml(url, { waitForSelector: 'li[id^="job-teaser-"]' });
      if (html) {
        const $ = cheerio.load(html);
        $('li[id^="job-teaser-"]').each((_, el) => {
          const a = $(el).find('a[href*="/jobs/"]').first();
          const title = a.attr('title') || $(el).find('h2').text().trim();
          const link = a.attr('href') || '';
          const org = $(el).find('p.text-style-paragraph-sm').first().text().trim();
          
          const grid = $(el).find('div.grid, div.lg\\:flex').last();
          const loc = grid.children().eq(0).text().trim() || 'Germany';
          const deadlineText = grid.children().eq(2).text().trim();
          const country = resolveCountry(loc) || 'germany';

          if (title && link) {
            pushJob(jobs, {
              title,
              org: org || 'Academics.com',
              country,
              location: loc,
              description: `Position at ${org} matching query: ${q}.`,
              url: link.startsWith('http') ? link : `https://www.academics.com${link}`,
              deadline: deadlineText ? `📅 ${deadlineText}` : '📅 Rolling'
            }, { type: 'phd' });
          }
        });
      }
    } catch (e) {
      console.warn(`  ⚠ Academics.com failed for "${q}": ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
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
  { name: 'medicon',       fn: scrapeMediconVillage, forcedCountry: 'sweden', url: 'https://www.mediconvillage.se/en/open-positions/', method: 'cheerio html' },
  { name: 'dutch',         fn: scrapeAcademicTransfer, forcedCountry: null, url: 'https://www.academictransfer.com/en/', method: 'cheerio html' },
  { name: 'germany',       fn: scrapeGermanyDAAD, forcedCountry: 'germany', url: 'https://api.daad.de/api/feeds/rss/en/phd.xml', method: 'cheerio rss' },
  { name: 'danish',        fn: scrapeDenmark, forcedCountry: 'denmark', url: 'https://employment.ku.dk/all-vacancies/?get_rss=1', method: 'cheerio rss + json' },
  // { name: 'findaphd',      fn: scrapeFindAPhD, forcedCountry: null, url: 'https://www.findaphd.com/', method: 'cheerio html + playwright' },
  { name: 'uk',            fn: scrapeJobsAcUK, forcedCountry: 'united kingdom', url: 'https://www.jobs.ac.uk/', method: 'cheerio html' },
  { name: 'nature',        fn: scrapeNatureCareers, forcedCountry: null, url: 'https://www.nature.com/naturecareers/', method: 'cheerio rss + html' },
  { name: 'switzerland',   fn: scrapeSwitzerland, forcedCountry: 'switzerland', url: 'https://jobs.ethz.ch/', method: 'cheerio html + playwright' },
  { name: 'austria',       fn: scrapeAustria, forcedCountry: 'austria', url: 'https://www.viennabiocenter.org/career/open-positions/', method: 'cheerio html + playwright' },
  { name: 'norway',        fn: scrapeNorway, forcedCountry: 'norway', url: 'https://publicapi.jobbnorge.no/v1/Jobs', method: 'REST API' },
  { name: 'finland',       fn: scrapeFinland, forcedCountry: 'finland', url: 'https://jobs.helsinki.fi/', method: 'cheerio html + playwright + TalentAdore API + Varbi RSS' },
  { name: 'industry',      fn: scrapeIndustryCareers, forcedCountry: null, url: 'https://careers.astrazeneca.com/search-jobs', method: 'playwright html + workday API' },
  { name: 'epfl',          fn: scrapeEPFL, forcedCountry: 'switzerland', url: 'https://careers.epfl.ch/', method: 'playwright html + SuccessFactors' },
  { name: 'leibniz',       fn: scrapeLeibniz, forcedCountry: 'germany', url: 'https://www.leibniz-gemeinschaft.de/en/careers/jobs', method: 'cheerio html' },
  { name: 'academics',     fn: scrapeAcademics, forcedCountry: null, url: 'https://www.academics.com/jobs', method: 'playwright html + academics.com' }
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

  const jobsDbContent = {
    lastUpdated: now.toISOString(),
    sourceHealth: healthReport,
    jobs: finalJobs
  };

  fs.writeFileSync(DB_FILE, JSON.stringify(jobsDbContent, null, 2));
  fs.writeFileSync(JS_FILE, `window.KAVYA_JOBS_DB = ${JSON.stringify(jobsDbContent, null, 2)};`);
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
