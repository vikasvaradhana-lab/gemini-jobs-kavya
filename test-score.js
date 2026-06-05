const fs = require('fs');

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

  const isAmbiguousTitle = t.includes('researcher') || t.includes('research associate') || t.includes('research fellow') || t.includes('fellow');
  if (isAmbiguousTitle) {
    if (desc.includes('phd required') || desc.includes('ph.d. required') || desc.includes('completed phd') || desc.includes('doctoral degree required')) {
      return { type: 'postdocExclude', match: 'research associate (phd required)' };
    }
  }

  return null;
}

function checkIsRATechTitle(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('assistant') || t.includes('technician') || t.includes('engineer') || t.includes('assistent') || t.includes('tekniker');
}

function scoreJobMultiDimensional(title, description, sourceName) {
  const excl = checkExclusionReason(title, description);
  if (excl) {
    return { score: -1, reason: `Excluded: ${excl.type} (${excl.match})` };
  }
  
  const text = (String(title) + ' ' + String(description || '')).toLowerCase();
  
  for (const x of HARD_EXCLUDES) {
    if (text.includes(x)) {
      return { score: -1, reason: `Hard exclude: ${x}` };
    }
  }

  let matchedMultilingual = false;
  let dim1 = 0;
  const nicheKeywords = [
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
  for (const { kw, w, multi } of nicheKeywords) {
    if (text.includes(kw)) {
      dim1 += w;
      if (multi) matchedMultilingual = true;
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
    { kw: 'western blot', w: 7 },
    { kw: 'cellodling', w: 10, multi: true },
    { kw: 'cellkultur', w: 10, multi: true },
    { kw: 'zellkultur', w: 10, multi: true },
    { kw: 'zellkulturen', w: 10, multi: true },
    { kw: 'celkweek', w: 10, multi: true },
    { kw: 'cellekultur', w: 10, multi: true },
    { kw: 'soluviljely', w: 10, multi: true }
  ];
  for (const { kw, w, multi } of methodKeywords) {
    if (text.includes(kw)) {
      dim2 += w;
      if (multi) matchedMultilingual = true;
    }
  }
  dim2 = Math.min(dim2, 25);

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
    { kw: 'lab technician', w: 5 },
    { kw: 'laboratory technician', w: 5 },
    { kw: 'wissenschaftlicher mitarbeiter', w: 8, multi: true },
    { kw: 'wissenschaftliche mitarbeiterin', w: 8, multi: true }
  ];
  for (const { kw, w, multi } of levelKeywords) {
    if (text.includes(kw)) {
      dim3 += w;
      if (multi) matchedMultilingual = true;
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
    { kw: 'sop', w: 5 },
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
    if (text.includes(kw)) {
      dim4 += w;
      if (multi) matchedMultilingual = true;
    }
  }
  dim4 = Math.min(dim4, 10);

  let boost = 0;
  if (/life science|biolog|biomed|biochem|biotech|pharmaceutical|health|medical|research|laborator/i.test(text)) {
    boost = 5;
  }

  let penalty = 0;
  let penaltyReason = 'none';
  if (dim1 === 0 && dim4 === 0) {
    const isIndustry = (sourceName === 'industry' || sourceName === 'novo' || text.includes('biotech') || text.includes('pharma') || text.includes('diagnostics'));
    const isRaOrTech = checkIsRATechTitle(title);
    
    if (isIndustry) {
      penalty = 0; 
      penaltyReason = 'exempt (industry)';
    } else if (isRaOrTech && dim2 >= 15) {
      penalty = 0; 
      penaltyReason = 'exempt (RA/tech with methods)';
    } else if (dim2 >= 20) {
      penalty = -10; 
      penaltyReason = 'reduced (-10, high methods)';
    } else {
      penalty = -35; 
      penaltyReason = 'strict gate (-35)';
    }
  }

  const base = 25;
  const score = base + dim1 + dim2 + dim3 + dim4 + boost + penalty;

  return {
    score: Math.max(0, Math.min(Math.round(score), 100)),
    breakdown: { base, dim1, dim2, dim3, dim4, boost, penalty, penaltyReason }
  };
}

const db = require('./jobs-db.json');
const job = db.jobs.find(j => j.title.includes('Pesticide'));
if (job) {
  console.log('Title:', job.title);
  console.log('why (summary):', job.why);
  console.log('Scoring (using summary as description):', scoreJobMultiDimensional(job.title, job.why, 'dutch'));
} else {
  console.log('Job not found');
}
