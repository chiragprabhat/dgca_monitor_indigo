import { diffArrays } from 'diff';
import { checkWorkerDeadline, remainingWorkerMs } from './worker-deadline.js';
import { getDatabase, transaction } from '../config/database.js';
import { fetchPdfWithText, FULL_DOCUMENT_PAGES, SUMMARY_PAGES } from './pdf-service.js';
import { savePdfText } from './state-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('revision-service');

const MAX_LINES = 12000;
const KEY_CHANGES_ADDED = 5;
const KEY_CHANGES_REMOVED = 3;

const ROMAN = { I: 1, V: 5, X: 10, L: 50 };
function partNumber(raw) {
  const s = raw.toUpperCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]], next = ROMAN[s[i + 1]] || 0;
    total += v < next ? -v : v;
  }
  return total;
}

const CIRCULAR_PREFIX = {
  'OPERATIONS CIRCULAR': 'OC', 'MEDICAL CIRCULAR': 'MC', 'GENERAL CIRCULAR': 'GC',
  'ENFORCEMENT CIRCULAR': 'EC', 'SSP CIRCULAR': 'SSPC', 'AIRWORTHINESS CIRCULAR': 'AAC'
};

// The document a title refers to, independent of its revision, e.g.
// "Draft CAR Section-3 Series-C Part-1 Rev 2" -> "CAR S3 C 1", "OC 2 of 2020 Revision 2" -> "OC 2/2020".
// Publications with the same key are versions of one document. Returns null when none is recognised.
export function revisionKey(title) {
  const t = String(title || '').toUpperCase().replace(/[‘’“”'"`´]/g, ' ').replace(/[–—]/g, '-');

  const section = t.match(/SECTI?ON\s*-?\s*(\d{1,2})\b/);
  if (section) {
    const afterSection = t.slice(section.index, section.index + 160);
    const series = afterSection.match(/SERIES\s*-?\s*([A-Z])\b/);
    if (series) {
      const afterSeries = afterSection.slice(series.index + series[0].length, series.index + series[0].length + 50);
      const part = afterSeries.match(/^[\s,.:-]*PART\s*-?\s*([IVXL]+|\d{1,2})\b/);
      return `CAR S${parseInt(section[1], 10)} ${series[1]}${part ? ` ${partNumber(part[1])}` : ''}`;
    }
  }

  const circular = t.match(/\b(OPERATIONS CIRCULAR|MEDICAL CIRCULAR|GENERAL CIRCULAR|ENFORCEMENT CIRCULAR|SSP CIRCULAR|AIRWORTHINESS CIRCULAR|[A-Z]{2,5})\s*(?:NO\.?\s*)?0*(\d{1,3})\s*(?:OF|\/)\s*(\d{4})\b/);
  if (circular && !['CAR', 'ORDER', 'DATED', 'NO', 'REV', 'ISSUE', 'PART', 'BY'].includes(circular[1])) {
    return `${CIRCULAR_PREFIX[circular[1]] || circular[1]} ${circular[2]}/${circular[3]}`;
  }

  const itso = t.match(/\bITSO\s*-?\s*(C\d{1,3})[A-Z]?\b/);
  if (itso) return `ITSO ${itso[1]}`;

  // Part-CARs; their AMC appendices are separate documents.
  const car = t.match(/\bCAR\s*-?\s*(66|145|147|21|M|ML|CAO|CAMO)\b(\s*\(?BASIC)?/);
  if (car) return `CAR ${car[1]}${car[2] ? ' BASIC' : ''}${/\bAMC\b/.test(t) ? ' AMC' : ''}`;

  return null;
}

// Splits into sentences/clauses rather than PDF lines, so text that merely
// re-wraps between two versions isn't reported as changed. Running headers and
// footers (lines repeated on 3+ pages, ignoring numbers) are dropped first, since
// their dates and page numbers differ in every revision.
export function toLines(text) {
  const raw = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const shape = l => l.replace(/\d+/g, '#').replace(/[_\s]+/g, ' ').toLowerCase();
  const seen = new Map();
  for (const l of raw) if (l.length < 160) seen.set(shape(l), (seen.get(shape(l)) || 0) + 1);
  return raw
    .filter(l => !(l.length < 160 && seen.get(shape(l)) >= 3))
    .filter(l => !/^(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i.test(l))
    .join(' ')
    .replace(/-\s+(?=[a-z])/g, '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;:!?])\s+(?=[A-Z0-9(“"'])|\s+(?=\(?\d+(?:\.\d+)+\)?\s+[A-Z])/)
    .map(s => s.trim())
    .filter(s => s.length > 1)
    .slice(0, MAX_LINES);
}

export function diffTexts(leftText, rightText) {
  const leftLines = toLines(leftText);
  const rightLines = toLines(rightText);
  checkWorkerDeadline();
  const remaining = remainingWorkerMs();
  const parts = diffArrays(leftLines, rightLines, Number.isFinite(remaining) ? { timeout: remaining } : {});
  if (!parts) throw new DOMException('Document comparison deadline exceeded', 'TimeoutError');
  let added = 0, removed = 0, same = 0;
  const chunks = parts.map(p => {
    const type = p.added ? 'added' : p.removed ? 'removed' : 'same';
    if (type === 'added') added += p.value.length;
    else if (type === 'removed') removed += p.value.length;
    else same += p.value.length;
    return { type, lines: p.value };
  });
  const similarity = leftLines.length + rightLines.length
    ? Math.round((200 * same) / (leftLines.length + rightLines.length))
    : 0;
  return { leftLines, rightLines, chunks, stats: { added, removed, unchanged: same, similarity } };
}

// Sentences worth showing in an email: real clauses, not headers, page furniture or contact addresses.
function isSubstantive(line) {
  return line.length >= 40 && line.length <= 600
    && /[a-z]{3}/.test(line)
    && (line.match(/[a-z]/gi) || []).length >= line.length * 0.6
    && !/subject\s*:$/i.test(line)
    && !/@|safd\w*j\w*ng|aurobindo marg|new delhi\s*-?\s*110/i.test(line);
}

const comparable = l => l.toLowerCase().replace(/[^a-z0-9]/g, '');

// The first substantive sentences of one kind of change, skipping ones that
// only moved (the same wording also appears on the other side).
function keyChanges(chunks, type, max) {
  const other = new Set(chunks.filter(c => c.type !== type && c.type !== 'same').flatMap(c => c.lines.map(comparable)));
  const out = [];
  for (const c of chunks) {
    if (c.type !== type) continue;
    for (const l of c.lines) {
      if (isSubstantive(l) && !other.has(comparable(l))) out.push(l.length > 300 ? `${l.slice(0, 297)}...` : l);
      if (out.length >= max) return out;
    }
  }
  return out;
}

// The latest earlier version of the same document, preferring one whose PDF has text.
export async function findPreviousVersion(row) {
  const key = row.revision_key ?? revisionKey(row.title);
  if (!key) return null;
  return await getDatabase().prepare(`
    SELECT * FROM updates
    WHERE revision_key = $1 AND id <> $2 AND COALESCE(attach_id, '') <> COALESCE($3, '#')
      AND publication_date <= $4
    ORDER BY (pdf_text IS NOT NULL AND length(pdf_text) > 80) DESC, publication_date DESC NULLS LAST, detected_at DESC NULLS LAST
    LIMIT 1
  `).get(key, row.id, row.attach_id, row.publication_date) || null;
}

// The publication's whole text. Text stored by the monitor covers only the first
// pages of long PDFs, so those are read again in full (once) before comparing.
export async function fullTextOf(row) {
  if (row.pdf_text != null && (row.pdf_text_full || !row.pdf_pages || row.pdf_pages <= SUMMARY_PAGES)) return row.pdf_text;
  const url = (() => { try { return JSON.parse(row.pdf_urls || '[]')[0]; } catch { return null; } })();
  const pdf = url ? await fetchPdfWithText(url, { maxPages: FULL_DOCUMENT_PAGES }) : null;
  if (!pdf && row.pdf_text != null) return row.pdf_text;
  await savePdfText(row.id, pdf ? pdf.text : '', pdf ? pdf.pageCount : null, true);
  return pdf ? pdf.text : '';
}
const textOf = fullTextOf;

// Compares a publication with its previous version and stores the result on the row.
// Returns null when there is no earlier version. Never throws.
export async function compareWithPrevious(row) {
  try {
    const previous = await findPreviousVersion(row);
    if (!previous) {
      await saveRevision(row.id, null);
      return null;
    }
    const [oldText, newText] = await Promise.all([textOf(previous), textOf(row)]);
    const revision = {
      key: row.revision_key ?? revisionKey(row.title),
      previous: { id: previous.id, title: previous.title, publication_date: previous.publication_date, section: previous.section },
      compared_at: new Date().toISOString()
    };
    if ((oldText || '').length < 80 || (newText || '').length < 80) {
      revision.note = 'One of the two PDFs has no readable text (probably scanned), so the wording could not be compared.';
    } else {
      const diff = diffTexts(oldText, newText);
      revision.stats = diff.stats;
      revision.added = keyChanges(diff.chunks, 'added', KEY_CHANGES_ADDED);
      revision.removed = keyChanges(diff.chunks, 'removed', KEY_CHANGES_REMOVED);
      if (diff.stats.similarity < 20) revision.note = 'The documents differ almost entirely - this may be a full rewrite rather than a revision.';
    }
    await saveRevision(row.id, revision);
    return revision;
  } catch (error) {
    logger.warn('Revision comparison failed', { id: row.id, error: error.message });
    return null;
  }
}

async function saveRevision(id, revision) {
  await getDatabase().prepare('UPDATE updates SET revision = $1 WHERE id = $2').run(revision ? JSON.stringify(revision) : '', id);
}

export function parseRevision(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Keys for rows stored before revision matching existed.
export async function backfillRevisionKeys() {
  const db = getDatabase();
  const rows = await db.prepare('SELECT id, title FROM updates WHERE revision_key IS NULL').all();
  await transaction(async db => {
    const set = db.prepare('UPDATE updates SET revision_key = $1 WHERE id = $2 AND revision_key IS NULL');
    for (const r of rows) await set.run(revisionKey(r.title) || '', r.id);
  });
  if (rows.length) logger.info(`Document keys set for ${rows.length} publication(s)`);
}
