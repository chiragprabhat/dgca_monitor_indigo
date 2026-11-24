// Rule-based priority for a DGCA publication, judged from an airline operator's
// point of view. Used on its own, or as the fallback when no AI summary is available.

const HIGH_RULES = [
  // These two only look at the title and opening lines: body text often cites CARs in passing.
  { label: 'Draft regulation open for comments', re: /\bdraft\b[\s\S]{0,80}\b(car|regulation|rules?|amendment)\b|\bcomments?\s+(are\s+)?invited\b/, opening: true },
  { label: 'Civil Aviation Requirement (CAR)', re: /\bcar\b|civil aviation requirement/, opening: true },
  { label: 'Flight safety', re: /\bsafety\b|\baccident\b|\bincident\b|\bemergenc/ },
  { label: 'Airworthiness', re: /airworthiness|\bad\s*no\b|maintenance organi[sz]ation|\bcamo\b/ },
  { label: 'Flight operations', re: /commercial air transport|(?<!non[- ]?)scheduled (air transport|operator)|(?<!non[- ]?scheduled )air operator|\baoc\b|flight operations? (circular|requirement)|operations circular|\bops circular\b|\boc\s*\d+\s*of\s*\d{4}/ },
  { label: 'Crew duty time', re: /flight duty|\bfdtl\b|duty time|rest period|flight crew|cabin crew/ },
  { label: 'Dangerous goods', re: /dangerous goods/ },
  { label: 'Aerodrome / air navigation', re: /aerodrome|airport operator|air navigation|\bnotam\b|\baic\b|airspace/ },
  { label: 'Enforcement or restriction', re: /suspen(d|sion)|prohibit|\bban(ned)?\b|penalt|enforcement|with immediate effect|effective:?\s*forthwith|mandatory/ }
];

const MEDIUM_RULES = [
  { label: 'Circular / guidance', re: /circular|guidance|guidelines?|advisory|clarification/ },
  { label: 'Training / examiners', re: /training|examiner|\bfto\b|simulator|instructor/ },
  { label: 'Licensing / approvals', re: /licen[cs]|\batpl\b|\bcpl\b|\bspl\b|approval|certificat|registration|permit/ },
  { label: 'Drones / UAS', re: /\buas\b|drone|unmanned/ },
  { label: 'Date or deadline notice', re: /last date|extension|deadline|due date/ }
];

const LOW_RULES = [
  { label: 'Tender / procurement', re: /tender|quotation|\brfp\b|\beoi\b|expression of interest|empanelment|auction|scrap|annual maintenance contract|\bamc\b|furniture|procurement/ },
  { label: 'Administrative / HR', re: /recruitment|vacanc|deputation|hiring|internship|hindi|library|canteen|housekeeping|holiday|transfer order|posting/ }
];

const SECTION_DEFAULT = {
  tenders: { priority: 'low', reason: 'Tender / procurement notice' },
  regulation: { priority: 'medium', reason: 'Regulatory publication' },
  guidance: { priority: 'medium', reason: 'Guidance publication' },
  announcements: { priority: 'low', reason: 'General announcement' }
};

const RANK = { low: 0, medium: 1, high: 2 };
const NEAR_DEADLINE_DAYS = 7;

export function classifyPriority({ title, section, text = '', publicationDate, deadline }) {
  const norm = s => s.toLowerCase().replace(/-\s*\n\s*/g, '-').replace(/\s+/g, ' ');
  const head = norm(`${title}\n${text.slice(0, 4000)}`);
  // Many titles are Hindi-only; the English subject usually sits in the PDF's first lines.
  const subject = norm(`${title}\n${text.slice(0, 900)}`);
  const opening = norm(`${title}\n${text.slice(0, 600)}`);
  const matches = rules => rules.filter(r => r.re.test(r.opening ? opening : head)).map(r => r.label);

  const high = matches(HIGH_RULES);
  const titleIsLow = LOW_RULES.some(r => r.re.test(subject));
  const titleIsHigh = HIGH_RULES.some(r => r.re.test(r.opening ? opening : subject));

  let priority;
  let reasons;
  if ((section === 'tenders' || titleIsLow) && !titleIsHigh) {
    priority = 'low';
    reasons = matches(LOW_RULES).slice(0, 1);
    if (!reasons.length) reasons = [SECTION_DEFAULT.tenders.reason];
  } else if (high.length) {
    priority = 'high';
    reasons = high.slice(0, 3);
  } else {
    const medium = matches(MEDIUM_RULES);
    const fallback = SECTION_DEFAULT[section] || { priority: 'medium', reason: 'DGCA publication' };
    priority = medium.length ? 'medium' : fallback.priority;
    reasons = medium.length ? medium.slice(0, 2) : [fallback.reason];
  }

  const days = daysUntil(deadline, publicationDate);
  if (days !== null && days >= 0 && days <= NEAR_DEADLINE_DAYS && RANK[priority] < RANK.high) {
    priority = 'high';
    reasons.unshift(`Deadline in ${days} day${days === 1 ? '' : 's'}`);
  }

  return { priority, reason: reasons.join('; ') };
}

export function higherPriority(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

// Finds the earliest response/compliance deadline mentioned, e.g. "by 12th November 2026",
// "on or before 15.11.2026", "last date ... 30/10/2026". Returns YYYY-MM-DD or null.
export function extractDeadline(text, publicationDate) {
  const src = (text || '').slice(0, 20000);
  const cue = String.raw`(?:by|before|till|until|latest\s+by|on\s+or\s+before|last\s+date[^\n.]{0,60}?|due\s+(?:date|by)[^\n.]{0,20}?)`;
  const named = new RegExp(String.raw`${cue}\s*:?\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s*(\d{4})`, 'gi');
  const numeric = new RegExp(String.raw`${cue}\s*:?\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})`, 'gi');

  const found = [];
  for (const m of src.matchAll(named)) found.push(isoDate(m[3], MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)], m[1]));
  for (const m of src.matchAll(numeric)) found.push(isoDate(m[3], m[2], m[1]));

  const floor = publicationDate || '0000-00-00';
  const valid = found.filter(d => d && d >= floor).sort();
  return valid[0] || null;
}

function isoDate(y, m, d) {
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function daysUntil(deadline, fromDate) {
  if (!deadline) return null;
  const from = fromDate ? new Date(`${fromDate}T00:00:00Z`) : new Date(`${todayIST()}T00:00:00Z`);
  const to = new Date(`${deadline}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

// IST calendar date (YYYY-MM-DD) of the given moment, default now.
export function todayIST(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(at));
}
