import axios from 'axios';
import * as cheerio from 'cheerio';
import { getDatabase, transaction } from '../config/database.js';
import { fetchPdfWithText, FULL_DOCUMENT_PAGES } from './pdf-service.js';
import { diffTexts } from './revision-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('car-service');

const BASE = 'https://www.dgca.gov.in/digigov-portal/';
// DGCA's rule book 6 = Civil Aviation Requirements; content 315 = Section 8, Aircraft Operations.
const SECTIONS = { 8: { contentId: '315', title: 'Aircraft Operations' } };
const PAUSE_BETWEEN_PDFS_MS = 1500;

const ROMAN = { I: 1, V: 5, X: 10, L: 50 };
function partNumber(raw) {
  const s = String(raw || '').toUpperCase().trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]] || 0, next = ROMAN[s[i + 1]] || 0;
    total += v < next ? -v : v;
  }
  return total;
}

// "17.08.2026" -> "2026-08-17"; anything else is kept as written.
function isoDate(text) {
  const m = String(text || '').match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

// Reads one CAR section's table from DGCA: series headings, then one row per Part.
export async function fetchSectionList(section = 8) {
  const { contentId } = SECTIONS[section];
  const body = new URLSearchParams({
    baseLocale: '', screenId: '10000001', classification: '', actionVal: 'viewDynamicRuleContLvl2',
    requestType: 'ApplicationRH', attachId: '', langType: '1', ruleBookId: '6', contentId,
    serviceName: 'fetchRulebookContentDtlsList', attr: 'CivilAviationReqContent'
  });
  const res = await axios.post(`${BASE}scan?`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 45000
  });
  const $ = cheerio.load(res.data);
  const rows = [];
  let series = null, seriesTitle = '';
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    const first = $(tds[0]);
    if (tds.length === 1 || first.attr('colspan')) {
      const m = clean($(tr).text()).match(/SERIES\s+([A-Z])\b\s*-?\s*(.*)$/i);
      if (m) { series = m[1].toUpperCase(); seriesTitle = clean(m[2]).replace(/^-\s*/, ''); }
      return;
    }
    if (!series || tds.length < 3) return;
    const partText = clean(first.text());
    const pm = partText.match(/PART\s+([IVXL]+|\d+)/i);
    if (!pm) return;
    const link = first.find('a[data-url]').attr('data-url') || $(tr).find('a[data-url*="dynamicPdf/"]').attr('data-url') || '';
    const attachId = (link.match(/dynamicPdf\/(.+)$/) || [])[1] || null;
    const issueText = clean($(tds[1]).text());
    const revoked = /revok/i.test(clean($(tr).text()));
    const part = pm[1].toUpperCase();
    rows.push({
      id: `CAR S${section} ${series} ${partNumber(part)}`,
      section, series, series_title: seriesTitle, part,
      issue: revoked ? '' : issueText,
      issue_date: isoDate(issueText),
      subject: revoked ? 'Revoked by DGCA' : clean($(tds[2]).text()),
      amendment: clean($(tds[3]).text()),
      amendment_date: isoDate($(tds[4]).text()),
      status: revoked ? 'revoked' : 'in force',
      attach_id: attachId,
      pdf_url: attachId ? `${BASE}Upload?flag=iframeAttachView&attachId=${attachId}` : null
    });
  });
  if (!rows.length) throw new Error(`No CARs found in the DGCA Section ${section} list`);
  return rows;
}

let syncing = false;
let lastSync = null;

const label = car => `CAR 8 ${car.series} Part ${car.part}`;
const inForceText = car => [car.issue, car.amendment && !/^no rev/i.test(car.amendment) ? car.amendment : ''].filter(Boolean).join(', ') || 'no revision';

// Brings the stored Section 8 CARs in line with DGCA, so the dashboard follows the official list:
// new Parts are added, amended ones (new PDF) re-read with the previous text kept in car_history,
// revoked ones marked, and Parts DGCA no longer lists marked removed. Each change goes to car_changes.
export async function syncCars({ section = 8 } = {}) {
  if (syncing) return { started: false, reason: 'already running' };
  syncing = true;
  const startedAt = new Date().toISOString();
  const summary = { listed: 0, added: 0, updated: 0, revoked: 0, removed: 0, changed: 0, read: 0, failed: 0 };
  try {
    const db = getDatabase();
    const rows = await fetchSectionList(section);
    summary.listed = rows.length;
    // CAR metadata, revision history, and change logs are committed together.
    const amendedChange = new Map();
    await transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(13694, $1::integer)', [section]);
      const stored = await db.prepare('SELECT * FROM car_documents WHERE section = $1').all(section);
      // The very first load is not news; changes are logged from the second refresh on.
      const firstLoad = stored.length === 0;
      const byId = new Map(stored.map(c => [c.id, c]));
      const insert = db.prepare(`INSERT INTO car_documents (id, section, series, series_title, part, issue, issue_date, subject, amendment, amendment_date, status, attach_id, pdf_url, listed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, dgca_utc_now())`);
      const update = db.prepare(`UPDATE car_documents SET series_title=$1, issue=$2, issue_date=$3, subject=$4, amendment=$5,
        amendment_date=$6, status=$7, attach_id=$8, pdf_url=$9, listed_at=dgca_utc_now() WHERE id=$10`);
      const keep = db.prepare('INSERT INTO car_history (car_id, amendment, amendment_date, pdf_url, pdf_text, pdf_pages) VALUES ($1, $2, $3, $4, $5, $6)');
      const resetText = db.prepare('UPDATE car_documents SET pdf_text = NULL, pdf_pages = NULL, read_at = NULL WHERE id = $1');
      const log = db.prepare('INSERT INTO car_changes (car_id, change, detail) VALUES ($1, $2, $3) RETURNING id');
      const note = async (id, change, detail) => { if (!firstLoad) { summary.changed++; return (await log.get(id, change, detail)).id; } };

      for (const row of rows) {
        const old = byId.get(row.id);
        if (!old) {
          await insert.run(row.id, row.section, row.series, row.series_title, row.part, row.issue, row.issue_date, row.subject, row.amendment, row.amendment_date, row.status, row.attach_id, row.pdf_url); summary.added++;
          await note(row.id, 'added', `${label(row)} added: ${row.subject}${row.status === 'revoked' ? ' (listed as revoked)' : ''}`);
          continue;
        }
        const newPdf = old.attach_id !== row.attach_id;
        if (newPdf) {
          if (old.pdf_text) await keep.run(old.id, old.amendment, old.amendment_date, old.pdf_url, old.pdf_text, old.pdf_pages);
          await resetText.run(old.id);
        }
        if (row.status === 'revoked' && old.status !== 'revoked') {
          summary.revoked++;
          await note(row.id, 'revoked', `${label(row)} revoked: ${old.subject}`);
        } else if (row.status === 'in force' && old.status !== 'in force') {
          await note(row.id, 'reinstated', `${label(row)} is listed in force again: ${row.subject} (${inForceText(row)})`);
        } else if (row.status === 'in force' && newPdf) {
          summary.updated++;
          const id = await note(row.id, 'amended', `${label(row)} amended: ${row.subject} - ${inForceText(old)} → ${inForceText(row)}`);
          if (id && old.pdf_text) amendedChange.set(row.id, { id, oldText: old.pdf_text });
        } else if (row.status === 'in force'
          && ['subject', 'issue', 'amendment', 'amendment_date'].some(k => (old[k] || '') !== (row[k] || ''))) {
          await note(row.id, 'details', `${label(row)} details changed on DGCA: ${old.subject} (${inForceText(old)}) → ${row.subject} (${inForceText(row)})`);
        }
        await update.run(row.series_title, row.issue, row.issue_date, row.subject, row.amendment, row.amendment_date, row.status, row.attach_id, row.pdf_url, row.id);
      }

      // Parts DGCA no longer lists. A list much shorter than before is more likely a DGCA page
      // fault than a mass withdrawal, so nothing is marked removed then.
      const listed = new Set(rows.map(r => r.id));
      const gone = stored.filter(c => c.status !== 'removed' && !listed.has(c.id));
      const active = stored.filter(c => c.status !== 'removed').length;
      if (gone.length && rows.length >= active * 0.5) {
        const markRemoved = db.prepare("UPDATE car_documents SET status = 'removed', listed_at = dgca_utc_now() WHERE id = $1");
        for (const c of gone) {
          await markRemoved.run(c.id); summary.removed++;
          await note(c.id, 'removed', `${label(c)} no longer listed by DGCA: ${c.subject}`);
        }
      } else if (gone.length) {
        logger.warn(`CAR Section ${section}: DGCA listed only ${rows.length} of ${active} Parts - not marking any as removed this time`);
      }
    });

    // Read every CAR PDF that has no text yet, gently.
    const unread = await db.prepare("SELECT id, pdf_url FROM car_documents WHERE section = $1 AND status = 'in force' AND pdf_url IS NOT NULL AND pdf_text IS NULL").all(section);
    const save = db.prepare('UPDATE car_documents SET pdf_text = $1, pdf_pages = $2, read_at = dgca_utc_now() WHERE id = $3');
    const completeAmended = db.prepare('UPDATE car_changes SET detail = detail || $1 WHERE id = $2');
    for (const car of unread) {
      const pdf = await fetchPdfWithText(car.pdf_url, { maxPages: FULL_DOCUMENT_PAGES });
      if (pdf) {
        await save.run(pdf.text || '', pdf.pageCount ?? null, car.id); summary.read++;
        const amended = amendedChange.get(car.id);
        if (amended && pdf.text) {
          const { stats } = diffTexts(amended.oldText, pdf.text);
          await completeAmended.run(` (${stats.added} sentences added, ${stats.removed} removed, ${stats.similarity}% unchanged)`, amended.id);
        }
      } else summary.failed++;
      await new Promise(r => setTimeout(r, PAUSE_BETWEEN_PDFS_MS));
    }
    lastSync = { startedAt, finishedAt: new Date().toISOString(), ...summary, error: null };
    logger.info(`CAR Section ${section}: ${summary.listed} listed, ${summary.added} new, ${summary.updated} amended, ${summary.revoked} revoked, ${summary.removed} removed, ${summary.read} PDFs read, ${summary.failed} failed`);
  } catch (error) {
    lastSync = { startedAt, finishedAt: new Date().toISOString(), ...summary, error: error.message };
    logger.warn('CAR sync failed', { error: error.message });
  } finally {
    syncing = false;
  }
  return { started: true, ...lastSync };
}

export async function carSyncStatus() {
  const db = getDatabase();
  const counts = await db.prepare(`SELECT COUNT(*) total, SUM((status = 'in force')::int) AS "inForce", SUM((status = 'revoked')::int) revoked,
    SUM((status = 'removed')::int) removed, SUM((status = 'in force' AND pdf_text IS NOT NULL AND length(pdf_text) > 80)::int) AS "withText" FROM car_documents`).get();
  return { syncing, lastSync, checkEveryMinutes: CHECK_EVERY_MINUTES, ...counts };
}

// How often DGCA's Section 8 list is checked. Only changed PDFs are downloaded again.
export const CHECK_EVERY_MINUTES = 60;

export async function recentCarChanges(limit = 50) {
  return await getDatabase().prepare('SELECT * FROM car_changes ORDER BY detected_at DESC NULLS LAST, id DESC LIMIT NULLIF(GREATEST($1::bigint, -1), -1)').all(limit);
}

// Words that say nothing about which CAR a title is about.
const STOP = new Set(('requirements requirement operations operation approval procedure procedures specific operational '
  + 'aircraft aeroplanes aeroplane with having exceeding their thereof concerned scheduled non operators operator for and the of to on in by from use '
  + 'issue revision draft comments invited general all any its are rev').split(' '));

// Acronyms in brackets in a CAR subject, e.g. "(EFB)", "(EDTO)", "(NAT HLA)".
function acronyms(subject) {
  return [...String(subject).matchAll(/\(([A-Z][A-Z0-9 /-]{1,12})\)/g)].map(m => m[1].trim()).filter(a => a.length >= 3);
}

// Publications about a CAR: the same CAR number in the title, or the CAR's acronym / most
// of its subject words appearing in the title.
export function relatedPublications(car, publications) {
  const words = [...new Set(String(car.subject).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)))];
  const acr = acronyms(car.subject);
  const core = String(car.subject).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/^\s*requirements? for\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (car.status !== 'in force') return [];
  return publications.filter(p => {
    if (p.revision_key === car.id) return true;
    // A title that names a different CAR is about that CAR, not this one.
    if (p.revision_key && p.revision_key.startsWith('CAR ')) return false;
    // Only the title proper: not "Comments may be sent to ..." or DGCA's own name and address.
    const title = String(p.title).toLowerCase()
      .split(/comments? (?:may|are|to|invited by|should)|please address|send comments/)[0]
      .replace(/(?:office of the )?director(?:ate)? general of civil aviation/g, ' ');
    if (acr.some(a => new RegExp(`\\b${a.toLowerCase().replace(/[/-]/g, '.?')}\\b`).test(title))) return true;
    // Short subjects must appear as a phrase; longer ones need most of their words.
    if (words.length <= 2) return core.length >= 12 && title.replace(/[^a-z0-9]+/g, ' ').includes(core);
    const hits = words.filter(w => new RegExp(`\\b${w}`).test(title)).length;
    return hits / words.length >= 0.75;
  }).map(p => ({ ...p, match: p.revision_key === car.id ? 'CAR number' : 'subject' }));
}

export async function listCars() {
  return (await getDatabase().prepare(`SELECT id, section, series, series_title, part, issue, issue_date, subject, amendment, amendment_date, status,
    pdf_url, pdf_pages, length(pdf_text) > 80 AS has_text, read_at, listed_at FROM car_documents`).all())
    .map(c => ({ ...c, has_text: !!c.has_text }))
    .sort((a, b) => a.section - b.section || a.series.localeCompare(b.series) || partNumber(a.part) - partNumber(b.part));
}
