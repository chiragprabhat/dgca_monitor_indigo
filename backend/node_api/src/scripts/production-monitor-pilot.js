import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import axios from 'axios';
import { acquireMonitoringLock, closeDatabase, transaction, verifyMonitoringSmokeConnection } from '../config/database.js';
import { runInMonitoringSmokeTest } from '../config/monitoring-smoke-context.js';
import { smokeDatabaseTarget } from '../config/smoke-database-target.js';
import { SECTION_KEYS, scrapeAllSections } from '../scrapers/dgca-scraper.js';
import { analyzeAndPrepare, claimScheduledMonitoringSlot } from '../services/monitor-service.js';
import { initializeEmailService, isEmailEnabled } from '../services/notification-service.js';
import { getGitHubMonitoringSlot } from '../services/scheduler-service.js';
import { getSettings } from '../services/settings-service.js';
import { logMonitoringRun, saveUpdate } from '../services/state-service.js';
import { getHttpsAgent } from '../utils/system-ca.js';

const CONFIRM = 'RUN ONE DGCA PRODUCTION MONITOR PILOT';
const ORIGIN = 'https://dgcamonitorindigo.vercel.app';
const APPROVED_RECIPIENTS = ['chirag131004@gmail.com', 'chiragprabhat50@gmail.com'];
const TABLES = [
  'car_changes', 'car_documents', 'car_history', 'config', 'dgca_jobs', 'dgca_upload_chunks',
  'dgca_upload_sessions', 'monitoring_logs', 'notifications', 'publications', 'review_log',
  'settings_log', 'updates', 'uploaded_documents'
].sort();
const hash = text => createHash('sha256').update(text).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expect = (condition, code) => { if (!condition) throw new Error(code); };
const countTables = state => Object.fromEntries(Object.entries(state.tables).map(([name, row]) => [name, row.count]));

export function productionTarget(env) {
  expect(env.PILOT_CONFIRMATION === CONFIRM && env.DGCA_MONITOR_ENABLED === 'false' &&
    env.EMAIL_NOTIFICATIONS_ENABLED === 'false' && env.GITHUB_RUN_ATTEMPT === '1' &&
    /^[a-f0-9]{64}$/.test(env.PILOT_CHECKPOINT || ''), 'PILOT_AUTHORIZATION');
  const target = smokeDatabaseTarget({
    DEPLOYMENT_TEST_DATABASE_URL: env.DATABASE_URL,
    DEPLOYMENT_TEST_NEON_HOST: env.PRODUCTION_NEON_HOST,
    PRODUCTION_NEON_HOST: env.DEPLOYMENT_TEST_NEON_HOST
  });
  const role = 'neondb_owner';
  expect(target.databaseName === 'neondb' && decodeURIComponent(new URL(target.connectionString).username) === role, 'PILOT_TARGET');
  return { ...target, neonIdentity: { project: 'tiny-sea-21255890', branch: 'br-gentle-bread-beix3pqb', role } };
}

const pending = "email_status IS NULL AND coalesce(is_notified,0)=0 AND NOT EXISTS (SELECT 1 FROM notifications WHERE update_id=updates.id AND status='sent')";

async function snapshot() {
  return transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = {};
    const catalogue = await db.prepare("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname").all();
    expect(same(catalogue.map(row => row.relname), TABLES), 'PILOT_TABLES');
    for (const table of TABLES) {
      const row = await db.prepare("SELECT count(*)::int AS n, coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS rows FROM public." + table + ' t').get();
      tables[table] = { count: row.n, sha256: hash(row.rows) };
    }
    const config = await db.prepare('SELECT key,value,updated_at FROM public.config ORDER BY key').all();
    const latestLog = await db.prepare('SELECT * FROM public.monitoring_logs ORDER BY id DESC LIMIT 1').get();
    const logRows = await db.prepare('SELECT id,md5(to_jsonb(t)::text) AS fingerprint FROM public.monitoring_logs t ORDER BY id').all();
    const updates = await db.prepare("SELECT id,title,section,publication_date,detected_at,hash,attach_id,origin,in_dgca_archive,email_status,email_delivery_started_at,is_notified,summary_source,md5(to_jsonb(t)::text) AS fingerprint FROM public.updates t ORDER BY id").all();
    const active = await db.prepare("SELECT count(*)::int AS n FROM public.dgca_jobs WHERE state IN ('queued','running')").get();
    const claims = await db.prepare("SELECT count(*) FILTER (WHERE email_delivery_started_at IS NULL)::int AS pending, count(*) FILTER (WHERE email_delivery_started_at IS NOT NULL)::int AS unresolved FROM public.updates WHERE " + pending).get();
    return { tables, config, latestLog, logRows, updates, active: active.n, ...claims };
  });
}

function validateSettings(state, effective, emailEnabled) {
  const saved = Object.fromEntries(state.config.map(r => [r.key, r.value]));
  expect(saved.emailEnabled === 'false' && emailEnabled === false && effective.emailEnabled === false &&
    saved.summaryProvider === '"basic"' && effective.summaryProvider === 'basic' &&
    same(JSON.parse(saved.recipients || 'null'), APPROVED_RECIPIENTS) &&
    same(effective.recipients, APPROVED_RECIPIENTS), 'PILOT_SETTINGS');
  expect(state.active === 0 && state.unresolved === 0 && state.pending === 0, 'PILOT_PENDING_WORK');
}

async function verifyHosted(state, env) {
  const user = env.HOSTED_SMOKE_OPERATOR_USERNAME;
  const password = env.HOSTED_SMOKE_OPERATOR_PASSWORD;
  expect(user && !user.includes(':') && password, 'PILOT_HOSTED_AUTH');
  const headers = { Authorization: 'Basic ' + Buffer.from(user + ':' + password).toString('base64'),
    Accept: 'application/json', 'Cache-Control': 'no-cache' };
  async function get(path) {
    const response = await fetch(ORIGIN + path, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('PILOT_HOSTED_HTTP'); }
    return response.json();
  }
  const [health, updates, monitor, settings] = await Promise.all([
    get('/api/health'), get('/api/updates?limit=' + state.updates.length), get('/api/monitor/status'), get('/api/settings')
  ]);
  const project = rows => rows.map(row => JSON.stringify([String(row.id), row.title, row.section, row.publication_date, row.detected_at])).sort();
  expect(health.status === 'ok' && updates.total === state.updates.length && same(project(updates.data), project(state.updates)) &&
    monitor.recentRuns.some(row => Number(row.id) === Number(state.latestLog?.id) &&
      row.run_at === state.latestLog.run_at && row.status === state.latestLog.status &&
      Number(row.items_new) === Number(state.latestLog.items_new)) && settings.settings.summaryProvider === 'basic' &&
    same(settings.settings.recipients, APPROVED_RECIPIENTS) && settings.status.summaries.active === 'basic' &&
    settings.status.email.enabled === false && monitor.email.enabled === false, 'PILOT_HOSTED_MISMATCH');
}

function reconcile(before, after, slot, ids, successful, itemsFound) {
  const unchanged = TABLES.filter(name => !['config', 'monitoring_logs', 'updates'].includes(name));
  expect(unchanged.every(name => same(before.tables[name], after.tables[name])), 'PILOT_UNRELATED_TABLE_CHANGED');
  const historical = new Map(before.updates.map(row => [row.id, row]));
  const newRows = after.updates.filter(row => !historical.has(row.id));
  const knownHashes = new Set(before.updates.map(row => row.hash));
  const knownAttachments = new Set(before.updates.map(row => row.attach_id).filter(Boolean));
  expect(after.updates.filter(row => historical.has(row.id)).length === before.updates.length &&
    after.updates.filter(row => historical.has(row.id)).every(row => row.fingerprint === historical.get(row.id).fingerprint),
  'PILOT_HISTORICAL_UPDATE_CHANGED');
  expect(same(newRows.map(row => row.id).sort(), [...ids].sort()) &&
    newRows.every(row => {
      const valid = row.origin === 'monitor' && !row.in_dgca_archive && !row.email_status &&
        !row.email_delivery_started_at && !row.is_notified && !knownHashes.has(row.hash) &&
        (!row.attach_id || !knownAttachments.has(row.attach_id)) && (!successful || row.summary_source === 'basic');
      knownHashes.add(row.hash);
      if (row.attach_id) knownAttachments.add(row.attach_id);
      return valid;
    }), 'PILOT_NEW_PUBLICATION_INVARIANT');
  const isSlot = row => row.key === 'scheduled_monitor_last_slot';
  expect(same(before.config.filter(row => !isSlot(row)), after.config.filter(row => !isSlot(row))) &&
    after.config.find(isSlot)?.value === slot, 'PILOT_CONFIG_CHANGED');
  expect(same(before.logRows, after.logRows.slice(0, -1)) && after.logRows.length === before.logRows.length + 1 &&
    after.latestLog.status === (successful ? 'success' : 'failed') && after.latestLog.items_found === itemsFound &&
    after.latestLog.items_new === ids.size && after.unresolved === 0 && after.pending === ids.size,
  'PILOT_MONITORING_INVARIANT');
}

const operations = {
  verify: verifyMonitoringSmokeConnection, snapshot, verifyHosted, lock: acquireMonitoringLock, claim: claimScheduledMonitoringSlot,
  settings: getSettings, emailEnabled: isEmailEnabled, smtp: initializeEmailService, slot: getGitHubMonitoringSlot,
  scrape: scrapeAllSections, save: saveUpdate, analyze: analyzeAndPrepare, log: logMonitoringRun, close: closeDatabase
};

export async function runProductionPilot({ env = process.env, now = new Date(), report = () => {} } = {}, overrides = {}) {
  const target = productionTarget(env);
  const ops = { ...operations, ...overrides };
  return runInMonitoringSmokeTest(target, async () => {
    let lock;
    const start = Date.now();
    try {
      await ops.verify();
      const slot = await ops.slot(now);
      if (!slot) return { outcome: 'outside-monitoring-window' };
      lock = await ops.lock();
      if (!lock) return { outcome: 'monitor-busy' };
      const before = await ops.snapshot();
      const previousSlot = before.config.find(row => row.key === 'scheduled_monitor_last_slot')?.value ?? null;
      if (previousSlot !== null && previousSlot >= slot) return { outcome: 'slot-already-claimed', slot };
      expect(hash(JSON.stringify(before.tables)) === env.PILOT_CHECKPOINT, 'PILOT_CHECKPOINT_CHANGED');
      validateSettings(before, await ops.settings(), await ops.emailEnabled());
      expect(await ops.smtp() === null, 'PILOT_SMTP_NOT_SUPPRESSED');
      await ops.verifyHosted(before, env);
      report({ stage: 'before', counts: countTables(before), previousSlot, slot });
      lock.assertHeld();
      if (!await ops.claim(slot)) return { outcome: 'slot-already-claimed', slot };
      report({ stage: 'slot-claimed', slot });

      const ids = new Set();
      const pdf = { noAttachment: 0, downloaded: 0, textExtracted: 0, failed: 0, basicSummaries: 0 };
      let sectionResults = Object.fromEntries(SECTION_KEYS.map(key => [key, 'not-checked']));
      let found = 0;
      let duplicates = 0;
      let outcome = 'monitor-failed';
      let failure;
      try {
        const scrape = await ops.scrape({ strict: true });
        sectionResults = Object.fromEntries(SECTION_KEYS.map(key => {
          const result = scrape.sectionResults?.[key];
          return [key, Number.isSafeInteger(result) && result >= 0 ? result : result === 'missing' ? 'missing' : 'failed'];
        }));
        found = scrape.items.length;
        const correct = SECTION_KEYS.every(key => Number.isInteger(sectionResults[key]) &&
          scrape.items.filter(item => item.section === key).length === sectionResults[key]);
        if (!scrape.success || !correct || scrape.items.some(item => !SECTION_KEYS.includes(item.section) || item.inArchive)) {
          outcome = 'partial-scrape';
          throw new Error('PILOT_SECTION_COVERAGE');
        }
        expect(found <= 500, 'PILOT_SCRAPE_LIMIT');
        for (const item of scrape.items) {
          lock.assertHeld();
          const row = await ops.save(item, { preserveExisting: true });
          if (!row.isNew) { duplicates++; continue; }
          ids.add(row.id);
          const result = await ops.analyze({ id: row.id, section: item.section, title: item.title, publication_date: item.publicationDate,
            pdf_urls: JSON.stringify(item.pdfUrl ? [item.pdfUrl] : []) }, { quiet: true, assertHeld: lock.assertHeld });
          if (!item.pdfUrl) pdf.noAttachment++;
          else if (!result.pdf) pdf.failed++;
          else {
            pdf.downloaded++;
            if (result.pdf.text) pdf.textExtracted++;
          }
          expect(result.analysis.source === 'basic', 'PILOT_NON_BASIC_SUMMARY');
          pdf.basicSummaries++;
        }
        outcome = 'scraped';
      } catch (error) {
        failure = /^PILOT_[A-Z_]+$/.test(error.message) ? error.message : 'PILOT_PROCESSING';
      }
      const duration = Date.now() - start;
      report({ stage: 'processing', outcome, sectionResults, found, newPublications: ids.size, duplicates, pdf, duration, failure });
      lock.assertHeld();
      await ops.log(outcome === 'scraped' ? 'success' : 'failed', found, ids.size, duration, failure);
      const after = await ops.snapshot();
      report({ stage: 'after', counts: countTables(after), latestLogId: after.latestLog?.id, pending: after.pending, unresolved: after.unresolved });
      reconcile(before, after, slot, ids, outcome === 'scraped', found);
      if (outcome === 'scraped') await ops.verifyHosted(after, env);
      return { outcome, slot, sectionResults, found, newPublications: ids.size, duplicates, pdf, duration,
        notificationsUnchanged: true, pendingAutomaticEmailCandidates: after.pending, hostedVerified: outcome === 'scraped' };
    } finally {
      try { await lock?.release(); } finally { await ops.close(); }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  axios.defaults.httpsAgent = getHttpsAgent();
  const write = console.log.bind(console);
  console.log = console.info = console.error = console.warn = console.debug = () => {};
  const report = value => write(JSON.stringify(value));
  try {
    const result = await runProductionPilot({ report });
    report(result);
    if (result.outcome !== 'scraped') process.exitCode = 1;
  } catch (error) {
    report({ outcome: 'pilot-stopped', reason: /^PILOT_[A-Z_]+$/.test(error.message) ? error.message :
      /^SMOKE_[A-Z_]+$/.test(error.code) ? error.code : 'PILOT_VERIFICATION_OR_RUNTIME_ERROR' });
    process.exitCode = 1;
  }
}
