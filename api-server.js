// ═════════════════════════════════════════════════════════
// KAVYA'S JOB BOARD API SERVER
// Deploy to: Render.com or Railway.app (free tier)
// ═════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'jobs-db.json');

// Initialize jobs database if it doesn't exist
function initializeDB() {
  if (!fs.existsSync(DATA_FILE)) {
    const defaultJobs = {
      lastUpdated: new Date().toISOString(),
      jobs: [
        { id: 'new-1', country: 'sweden', tier: 'high', type: 'phd', org: 'Karolinska Institutet', score: 88, title: 'PhD — Stem Cell Biology & Epigenetics', tags: ['🎓 PhD', 'Stockholm', 'Fully funded'], why: 'ESC culture, DNA methylation, immunology. Direct match to your thesis background.', deadline: '📅 Rolling', deadlineWarn: false, url: 'https://education.ki.se/doctoral-education', source: 'scraper' },
        { id: 'new-2', country: 'netherlands', tier: 'high', type: 'phd', org: 'Leiden University', score: 86, title: 'PhD — Molecular Immunology & Cell Therapy', tags: ['🎓 PhD', 'Leiden', 'EU funded'], why: 'T-cell immunology, cell differentiation, fully funded EU program.', deadline: '📅 June 2026', deadlineWarn: true, url: 'https://www.universiteitleiden.nl/en/vacancies', source: 'scraper' },
        { id: 'new-3', country: 'denmark', tier: 'high', type: 'phd', org: 'University of Copenhagen (DanStem)', score: 89, title: 'PhD — Pluripotency & Epigenomics', tags: ['🎓 PhD', 'Copenhagen', 'Fully funded'], why: 'ESC pluripotency, epigenetic markers, stem cell biology center.', deadline: '📅 June 2026', deadlineWarn: true, url: 'https://danstem.ku.dk/join-us/jobs_and_vacancies/', source: 'scraper' }
      ]
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultJobs, null, 2));
  }
}

// Load jobs from database
function loadJobs() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Error loading jobs:', e);
    return { lastUpdated: new Date().toISOString(), jobs: [] };
  }
}

// Save jobs to database
function saveJobs(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('Jobs saved successfully');
  } catch (e) {
    console.error('Error saving jobs:', e);
  }
}

// GET /api/jobs - Return all jobs
app.get('/api/jobs', (req, res) => {
  const data = loadJobs();
  res.json(data);
});

// POST /api/jobs - Update jobs (called by GitHub Actions scraper)
// IMPORTANT: Merges new jobs with existing ones instead of overwriting
app.post('/api/jobs', (req, res) => {
  const { jobs: incomingJobs, apiKey } = req.body;

  // Simple auth - use environment variable
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!Array.isArray(incomingJobs)) {
    return res.status(400).json({ error: 'Invalid jobs array' });
  }

  // Load EXISTING jobs from database
  const existing = loadJobs();
  const existingJobIds = new Set(existing.jobs.map(j => j.id));

  // Find GENUINELY NEW jobs (not already on board)
  const newJobs = incomingJobs.filter(j => !existingJobIds.has(j.id));

  // MERGE STRATEGY: Keep existing jobs + add new ones (don't delete old jobs)
  const merged = [...existing.jobs, ...newJobs];

  // Save merged result
  const data = {
    lastUpdated: new Date().toISOString(),
    jobs: merged,
    stats: {
      totalJobs: merged.length,
      newJobsAdded: newJobs.length,
      existingJobsPreserved: existing.jobs.length
    }
  };

  saveJobs(data);
  res.json({ 
    success: true, 
    totalCount: merged.length,
    newAdded: newJobs.length,
    preserved: existing.jobs.length,
    lastUpdated: data.lastUpdated 
  });
});

// GET /api/health - Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', lastUpdated: loadJobs().lastUpdated });
});

// Initialize and start server
initializeDB();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kavya's Job Board API running on port ${PORT}`);
  console.log(`GET  /api/jobs - Fetch all jobs`);
  console.log(`POST /api/jobs - Update jobs (requires API_KEY)`);
  console.log(`GET  /api/health - Health check`);
});
