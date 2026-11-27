import { scrapeAllSections } from '../scrapers/dgca-scraper.js';
import { saveUpdate, getPendingEmailUpdates, getUnanalyzedUpdates, saveAnalysis, savePdfText, setEmailStatus, logMonitoringRun } from './state-service.js';
import { sendNotification, initializeEmailService, isEmailEnabled } from './notification-service.js';
import { fetchPdfWithText } from './pdf-service.js';
import { analyzePublication, formatDate } from './summary-service.js';
import { todayIST } from './priority-service.js';
import { getSettings } from './settings-service.js';
import { acquireMonitoringLock, getDatabase } from '../config/database.js';
import { createLogger } from '../utils/logger.js';
import { compareWithPrevious } from './revision-service.js';
import { monitoringSmokeTest } from '../config/monitoring-smoke-context.js';
import { checkWorkerDeadline } from './worker-deadline.js';
import { activationTime, eligiblePublication } from './recipient-delivery-service.js';

const logger = createLogger('monitor-service');

const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };
const SECTION_LABELS = { tenders: 'Tenders', regulation: 'Regulation', guidance: 'Guidance', announcements: 'Announcements' };

const BACKFILL_PER_CYCLE = 12;

export async function claimScheduledMonitoringSlot(slot) {
  const claim = await getDatabase().query(`
    INSERT INTO config (key, value) VALUES ('scheduled_monitor_last_slot', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = dgca_utc_now()
    WHERE config.value < EXCLUDED.value
  `, [slot]);
  return claim.rowCount > 0;
}

export async function checkForUpdates({ scheduledSlot, onScheduledStart } = {}) {
  const startTime = Date.now();
  let lock;
  let sectionResults;

  try {
    lock = await acquireMonitoringLock();
    if (!lock) {
      logger.warn('Monitoring already in progress, skipping this cycle');
      return scheduledSlot
        ? { success: true, skipped: true, reason: 'Monitor is busy' }
        : { success: false, error: 'Monitoring already in progress' };
    }
    if (scheduledSlot) {
      if (!await claimScheduledMonitoringSlot(scheduledSlot)) {
        return { success: true, skipped: true, reason: 'Slot already claimed' };
      }
      onScheduledStart?.();
    }
    logger.info('Starting DGCA website monitoring...');
    await initializeEmailService();

    const strict = process.env.DGCA_ACTIONS_WORKER === '1' || process.env.DGCA_NEON_RUNTIME === '1';
    const scrapeResult = await scrapeAllSections({ strict });
    sectionResults = scrapeResult.sectionResults;
    lock.assertHeld();
    if (!scrapeResult.success) {
      logger.error('Scraping failed', { error: scrapeResult.error });
      await logMonitoringRun('failed', 0, 0, Date.now() - startTime, scrapeResult.error);
      return { success: false, error: scrapeResult.error, ...(sectionResults && { sectionResults }) };
    }

    const newIds = [];
    for (const item of scrapeResult.items) {
      lock.assertHeld();
      const result = await saveUpdate(item, { preserveExisting: strict });
      if (result.isNew) newIds.push(result.id);
    }
    logger.info(`Scraped ${scrapeResult.items.length} items, ${newIds.length} new`);

    // Rows without an email decision include this cycle's new ones and any left by an interrupted cycle.
    const pending = await getPendingEmailUpdates();
    if (pending.length > newIds.length) logger.info(`Resuming ${pending.length - newIds.length} publication(s) left unsent by an earlier cycle`);
    let notificationsSent = 0;
    const cutoff = activationTime();
    for (const update of pending) {
      if (process.env.DGCA_NEON_RUNTIME === '1' && cutoff !== null && !eligiblePublication(update, cutoff)) continue;
      lock.assertHeld();
      try {
        if (await processNewUpdate(update, lock.assertHeld, strict)) notificationsSent++;
      } catch (error) {
        checkWorkerDeadline();
        logger.warn('Processing failed, will retry next cycle', { id: update.id, error: error.message });
      }
    }

    lock.assertHeld();
    await backfillAnalysis(BACKFILL_PER_CYCLE);

    const duration = Date.now() - startTime;
    logger.info(`Monitoring cycle complete: ${scrapeResult.items.length} items, ${newIds.length} new, ${notificationsSent} notifications sent in ${duration}ms`);
    await logMonitoringRun('success', scrapeResult.items.length, newIds.length, duration);

    return {
      success: true,
      itemsFound: scrapeResult.items.length,
      newItems: newIds.length,
      notificationsSent,
      duration,
      ...(sectionResults && { sectionResults })
    };
  } catch (error) {
    checkWorkerDeadline();
    const duration = Date.now() - startTime;
    logger.error('Monitoring cycle failed:', { error: error.message });
    await logMonitoringRun('failed', 0, 0, duration, error.message);
    return { success: false, error: error.message, duration, ...(sectionResults && { sectionResults }) };
  } finally {
    await lock?.release();
  }
}

// Analyses one newly detected publication and emails it if it was published today. Returns true if emailed.
async function processNewUpdate(update, assertHeld, strict) {
  const { pdf, analysis } = await analyze(update, strict ? { assertHeld } : undefined);
  const title = update.title.slice(0, 80);
  const stored = await getDatabase().prepare('SELECT * FROM updates WHERE id = $1').get(update.id);
  const revision = await compareWithPrevious(stored);
  if (revision) logger.info(`"${title}" revises "${revision.previous.title.slice(0, 60)}" (${revision.stats ? `${revision.stats.added} added, ${revision.stats.removed} removed` : 'text not comparable'})`);

  if (monitoringSmokeTest()) return false;

  if (!await isEmailEnabled()) {
    await setEmailStatus(update.id, 'not sent - email notifications disabled');
    return false;
  }

  const settings = await getSettings();
  if (!settings.categories.includes(update.section)) {
    await setEmailStatus(update.id, `not sent - ${SECTION_LABELS[update.section] || update.section} alerts are off in Settings`);
    return false;
  }
  if (PRIORITY_RANK[analysis.priority] < PRIORITY_RANK[settings.minPriority]) {
    await setEmailStatus(update.id, `not sent - ${analysis.priority.toUpperCase()} priority is below the ${settings.minPriority.toUpperCase()} minimum in Settings`);
    return false;
  }

  // The Neon delivery path rechecks same-day and cutoff eligibility against the locked row.
  const detectedDay = todayIST(update.detected_at);
  if (process.env.DGCA_NEON_RUNTIME !== '1' && settings.sameDayOnly && update.publication_date !== detectedDay) {
    await setEmailStatus(update.id, `not sent - published ${formatDate(update.publication_date)}, not the day it was detected`);
    logger.info(`No email: "${title}" was published ${update.publication_date}, detected ${detectedDay}`);
    return false;
  }

  const result = await sendNotification({ ...update, revision }, { analysis, pdf, assertHeld, automatic: true });
  if (result.alreadyAttempted) return false;
  if (process.env.DGCA_NEON_RUNTIME !== '1') {
    await setEmailStatus(update.id, result.success ? `sent ${new Date().toISOString()}` : `failed - ${result.error}`);
  }
  return result.success;
}

async function analyze(update, options = {}) {
  const pdfUrl = parseFirstUrl(update.pdf_urls);
  const pdf = await fetchPdfWithText(pdfUrl);
  options.assertHeld?.();
  await savePdfText(update.id, pdf ? pdf.text : '', pdf ? pdf.pageCount : null);
  const analysis = await analyzePublication(
    { section: update.section, title: update.title, publicationDate: update.publication_date },
    pdf,
    options
  );
  options.assertHeld?.();
  await saveAnalysis(update.id, analysis);
  if (!options.quiet) logger.info(`Analysed [${analysis.priority.toUpperCase()}] ${update.title.slice(0, 80)} (${analysis.source})`);
  return { pdf, analysis };
}

// Fills in summaries and priorities for publications stored before analysis existed. Never emails;
// rows still without an email_status are left for the next cycle's pending pass.
export async function backfillAnalysis(limit) {
  // Publications analysed before PDF text was stored: fetch just the text.
  const missingText = await getDatabase().prepare('SELECT id, pdf_urls FROM updates WHERE pdf_text IS NULL AND analyzed_at IS NOT NULL LIMIT NULLIF(GREATEST($1::bigint, -1), -1)').all(limit);
  for (const row of missingText) {
    const pdf = await fetchPdfWithText(parseFirstUrl(row.pdf_urls));
    await savePdfText(row.id, pdf ? pdf.text : '', pdf ? pdf.pageCount : null);
  }

  // Monitor publications found before revision matching existed.
  const unmatched = await getDatabase().prepare(`SELECT * FROM updates WHERE revision IS NULL AND revision_key <> '' AND COALESCE(origin, 'monitor') <> 'archive' LIMIT NULLIF(GREATEST($1::bigint, -1), -1)`).all(limit);
  for (const row of unmatched) await compareWithPrevious(row);

  for (const update of await getUnanalyzedUpdates(limit)) {
    try {
      await analyze(update);
    } catch (error) {
      logger.warn('Backfill analysis failed', { id: update.id, error: error.message });
    }
  }
}

export async function manualTrigger() {
  logger.info('Manual trigger requested');
  return await checkForUpdates();
}

export async function analyzeAndPrepare(update, options = {}) {
  return await analyze(update, options);
}

function parseFirstUrl(value) {
  try { return JSON.parse(value || '[]')[0] || ''; } catch { return ''; }
}
