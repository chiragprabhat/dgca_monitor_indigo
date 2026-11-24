import { fetchMoreList, SECTION_KEYS } from '../scrapers/dgca-scraper.js';
import { saveUpdate, getUnanalyzedUpdates, savePdfText, saveAnalysis } from './state-service.js';
import { fetchPdfWithText } from './pdf-service.js';
import { analyzePublication } from './summary-service.js';
import { todayIST } from './priority-service.js';
import { getDatabase } from '../config/database.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('archive');

export const ARCHIVE_EMAIL_STATUS = 'not sent - imported from the DGCA archive';
// DGCA starts answering with empty responses when PDFs are requested quickly, so go slowly.
const PAUSE_BETWEEN_PDFS_MS = 1500;
const DOWNLOAD_RETRY_WAITS_MS = [10000, 30000];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function analyseOne(row) {
  const url = (() => { try { return JSON.parse(row.pdf_urls || '[]')[0] || ''; } catch { return ''; } })();
  let pdf = url ? await fetchPdfWithText(url) : null;
  for (const wait of DOWNLOAD_RETRY_WAITS_MS) {
    if (pdf || !url) break;
    await sleep(wait);
    pdf = await fetchPdfWithText(url);
  }
  await savePdfText(row.id, pdf ? pdf.text : '', pdf ? pdf.pageCount : null);
  const analysis = await analyzePublication(
    { section: row.section, title: row.title, publicationDate: row.publication_date },
    pdf,
    { builtInOnly: true }
  );
  if (!pdf && url) analysis.summary = 'The PDF could not be downloaded from DGCA during the archive import. Open it from the DGCA link.';
  await saveAnalysis(row.id, analysis);
}

const state = {
  importing: false,
  analysing: false,
  lastImport: null, // { startedAt, finishedAt, perSection, added, alreadyKnown, error }
  analysisError: null
};

// Pulls every publication from each tab's "More" page (current list and the
// Archived block). Anything not already stored is saved with an email status set,
// so the monitor never emails it. Items dated today are left to the monitor.
export async function importArchive() {
  if (state.importing) return { started: false, reason: 'An import is already running' };
  state.importing = true;
  const run = { startedAt: new Date().toISOString(), finishedAt: null, perSection: {}, added: 0, alreadyKnown: 0, error: null };
  state.lastImport = run;

  (async () => {
    try {
      const today = todayIST();
      const failed = [];
      for (const section of SECTION_KEYS) {
        let items = null;
        // DGCA sometimes answers with an empty page under load; give each tab a few tries.
        for (let attempt = 1; attempt <= 3 && !items; attempt++) {
          try {
            items = await fetchMoreList(section);
          } catch (error) {
            logger.warn(`${section}: attempt ${attempt} to read the archive failed`, { error: error.message });
            if (attempt < 3) await sleep(attempt * 15000);
          }
        }
        if (!items) {
          failed.push(section);
          run.perSection[section] = { listed: 0, added: 0, error: 'DGCA did not return the list - try the import again later' };
          continue;
        }
        let added = 0;
        for (const item of items) {
          if (!item.inArchive && item.publicationDate >= today) continue;
          const result = await saveUpdate(item, { origin: 'archive', emailStatus: ARCHIVE_EMAIL_STATUS });
          if (result.isNew) added++;
          else run.alreadyKnown++;
        }
        run.perSection[section] = { listed: items.length, added };
        run.added += added;
        logger.info(`${section}: ${items.length} listed on DGCA, ${added} added`);
        await sleep(3000);
      }
      if (failed.length) run.error = `Could not read ${failed.join(', ')} from DGCA - run the import again to fill them in`;
      logger.info(`Archive import finished: ${run.added} publications added${failed.length ? `, failed: ${failed.join(', ')}` : ''}`);
    } catch (error) {
      run.error = error.message;
      logger.error('Archive import failed', { error: error.message });
    } finally {
      run.finishedAt = new Date().toISOString();
      state.importing = false;
      startAnalysis();
    }
  })();

  return { started: true };
}

// Reads the PDF and writes the built-in summary/priority for each imported item, one at a time.
export function startAnalysis() {
  if (state.analysing) return;
  state.analysing = true;
  state.analysisError = null;

  (async () => {
    try {
      for (;;) {
        const batch = await getUnanalyzedUpdates(20, 'archive');
        if (batch.length === 0) break;
        for (const row of batch) {
          try {
            await analyseOne(row);
          } catch (error) {
            // Mark it analysed with no text so one bad PDF can't stall the queue.
            await getDatabase().prepare("UPDATE updates SET analyzed_at = $1, pdf_text = COALESCE(pdf_text, '') WHERE id = $2")
              .run(new Date().toISOString(), row.id);
            logger.warn('Could not analyse archived publication', { id: row.id, error: error.message });
          }
          await sleep(PAUSE_BETWEEN_PDFS_MS);
        }
      }
      logger.info('Archive analysis complete');
    } catch (error) {
      state.analysisError = error.message;
      logger.error('Archive analysis stopped', { error: error.message });
    } finally {
      state.analysing = false;
    }
  })();
}

export async function getArchiveStatus() {
  const db = getDatabase();
  const counts = await db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN analyzed_at IS NOT NULL THEN 1 ELSE 0 END) AS analysed,
           SUM(CASE WHEN analyzed_at IS NOT NULL AND LENGTH(COALESCE(pdf_text, '')) > 80 THEN 1 ELSE 0 END) AS "withText"
    FROM updates WHERE origin = 'archive'
  `).get();
  const bySection = await db.prepare("SELECT section, COUNT(*) AS n FROM updates WHERE origin = 'archive' GROUP BY section").all();
  return {
    importing: state.importing,
    analysing: state.analysing,
    total: counts.total || 0,
    analysed: counts.analysed || 0,
    withText: counts.withText || 0,
    bySection: Object.fromEntries(bySection.map(r => [r.section, r.n])),
    lastImport: state.lastImport,
    analysisError: state.analysisError
  };
}
