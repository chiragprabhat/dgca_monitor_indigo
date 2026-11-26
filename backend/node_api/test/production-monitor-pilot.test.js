import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { productionTarget, runProductionPilot } from '../src/scripts/production-monitor-pilot.js';
import { scrapeAllSections } from '../src/scrapers/dgca-scraper.js';
import { initializeEmailService, isEmailEnabled, sendNotification, testEmailConnection } from '../src/services/notification-service.js';

const slot = '2026-11-26T10:15:00.000Z';
const counts = {
  car_changes: 0, car_documents: 1, car_history: 0, config: 3, dgca_jobs: 0, dgca_upload_chunks: 0,
  dgca_upload_sessions: 0, monitoring_logs: 1, notifications: 0, publications: 0, review_log: 0,
  settings_log: 0, updates: 0, uploaded_documents: 0
};
const summarySettings = { emailEnabled: false, summaryProvider: 'basic', recipients: ['chirag131004@gmail.com', 'chiragprabhat50@gmail.com'] };
const sample = { section: 'tenders', title: 'Synthetic pilot test', publicationDate: '2026-11-26', pdfUrl: 'https://example.invalid/test.pdf' };
const sections = { tenders: 1, announcements: 0, regulation: 0, guidance: 0 };

test('production workflow is manual only and supplies no SMTP or AI secrets', async () => {
  const yaml = await readFile(new URL('../../../.github/workflows/dgca-production-monitor-pilot.yml', import.meta.url), 'utf8');
  assert.match(yaml, /^on:\r?\n  workflow_dispatch:/m);
  assert.match(yaml, /group: dgca-production-monitor/);
  assert.match(yaml, /inputs\.confirmation == 'RUN ONE DGCA PRODUCTION MONITOR PILOT'/);
  assert.match(yaml, /vars\.DGCA_MONITOR_ENABLED == 'false' && vars\.EMAIL_NOTIFICATIONS_ENABLED == 'false'/);
  assert.match(yaml, /github\.run_attempt == '1'/);
  assert.doesNotMatch(yaml, /^\s+(schedule|push|pull_request):|SMTP_|EMAIL_APP_PASSWORD|OPENAI_|ANTHROPIC_|worker:actions/m);
});

function fixture() {
  const initial = {
    tables: Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, { count, sha256: name }])),
    config: Object.entries(summarySettings).map(([key, value]) => ({ key, value: JSON.stringify(value) })),
    updates: [], logRows: [{ id: 1 }], latestLog: { id: 1 }, active: 0, pending: 0, unresolved: 0
  };
  const state = structuredClone(initial);
  const env = {
    PILOT_CONFIRMATION: 'RUN ONE DGCA PRODUCTION MONITOR PILOT', DGCA_MONITOR_ENABLED: 'false',
    EMAIL_NOTIFICATIONS_ENABLED: 'false', GITHUB_RUN_ATTEMPT: '1',
    PILOT_CHECKPOINT: createHash('sha256').update(JSON.stringify(initial.tables)).digest('hex'),
    DATABASE_URL: 'postgresql://neondb_owner:test@ep-primary.example.aws.neon.tech/neondb?sslmode=require',
    PRODUCTION_NEON_HOST: 'ep-primary.example.aws.neon.tech', DEPLOYMENT_TEST_NEON_HOST: 'ep-test.example.aws.neon.tech'
  };
  const calls = [];
  const operations = {
    verify: async () => { calls.push('verify'); },
    lock: async () => ({ assertHeld() {}, async release() { calls.push('release'); } }),
    slot: async () => slot, snapshot: async () => structuredClone(state),
    verifyHosted: async () => { calls.push('hosted'); },
    settings: async () => summarySettings, emailEnabled: async () => false, smtp: async () => null,
    claim: async () => { calls.push('claim'); state.config.push({ key: 'scheduled_monitor_last_slot', value: slot }); return true; },
    scrape: async options => { assert.equal(options.strict, true); calls.push('scrape'); return { success: true, items: [sample], sectionResults: sections }; },
    save: async (_item, options) => {
      assert.equal(options.preserveExisting, true);
      calls.push('save');
      state.updates.push({ id: 'new', hash: 'unique', origin: 'monitor' });
      state.tables.updates.count++;
      state.pending++;
      return { isNew: true, id: 'new' };
    },
    analyze: async () => {
      calls.push('analyze'); state.updates[0].summary_source = 'basic';
      return { pdf: { text: 'Synthetic PDF' }, analysis: { source: 'basic' } };
    },
    log: async (status, items_found, items_new) => {
      calls.push('log'); state.latestLog = { id: 2, status, items_found, items_new }; state.logRows.push({ id: 2 });
    },
    close: async () => { calls.push('close'); }
  };
  return { env, initial, state, calls, operations };
}

test('complete section coverage permits empty sections and reconciles a new analyzed publication', async () => {
  const { env, calls, operations } = fixture();
  const result = await runProductionPilot({ env }, operations);
  assert.equal(result.outcome, 'scraped');
  assert.deepEqual(result.sectionResults, sections);
  assert.equal(result.pdf.textExtracted, 1);
  assert.equal(result.pdf.basicSummaries, 1);
  assert.equal(result.pendingAutomaticEmailCandidates, 1);
  assert.equal(result.hostedVerified, true);
  assert.deepEqual(calls, ['verify', 'hosted', 'claim', 'scrape', 'save', 'analyze', 'log', 'hosted', 'release', 'close']);
});

test('partial scraper failure writes a failed log and no publications', async () => {
  const { env, calls, operations, state } = fixture();
  operations.scrape = async () => ({ success: true, items: [sample], sectionResults: { ...sections, regulation: 'error' } });
  const result = await runProductionPilot({ env }, operations);
  assert.equal(result.outcome, 'partial-scrape');
  assert.equal(result.sectionResults.regulation, 'failed');
  assert.equal(state.latestLog.status, 'failed');
  assert.equal(state.latestLog.items_new, 0);
  assert.equal(calls.includes('save'), false);
});

test('an existing slot blocks the pilot before claiming or scraping', async () => {
  const { env, operations, state, calls } = fixture();
  state.config.push({ key: 'scheduled_monitor_last_slot', value: slot });
  assert.equal((await runProductionPilot({ env }, operations)).outcome, 'slot-already-claimed');
  assert.deepEqual(calls, ['verify', 'release', 'close']);
});

test('a database identity failure closes the connection without claiming a slot', async () => {
  const { env, operations, calls } = fixture();
  operations.verify = async () => { throw new Error('wrong-branch'); };
  await assert.rejects(runProductionPilot({ env }, operations), /wrong-branch/);
  assert.deepEqual(calls, ['close']);
  assert.throws(() => productionTarget({ ...env, DATABASE_URL: env.DATABASE_URL.replace('ep-primary', 'ep-test') }), /confirmed direct/);
  assert.throws(() => productionTarget({ ...env, DATABASE_URL: env.DATABASE_URL.replace('ep-primary', 'ep-primary-pooler') }), /confirmed direct/);
});

test('changed checkpoint, enabled flags, and reruns fail closed', async () => {
  const { env, operations, calls } = fixture();
  await assert.rejects(runProductionPilot({ env: { ...env, PILOT_CHECKPOINT: '0'.repeat(64) } }, operations), /PILOT_CHECKPOINT_CHANGED/);
  assert.equal(calls.includes('claim'), false);
  for (const key of ['DGCA_MONITOR_ENABLED', 'EMAIL_NOTIFICATIONS_ENABLED', 'GITHUB_RUN_ATTEMPT']) {
    await assert.rejects(runProductionPilot({ env: { ...env, [key]: 'true' } }, operations), /PILOT_AUTHORIZATION/);
  }
});

test('attempted email delivery and SMTP initialization are suppressed inside the pilot', async t => {
  const { env, operations } = fixture();
  const smtp = t.mock.method(nodemailer, 'createTransport', () => { throw new Error('SMTP must not be contacted'); });
  operations.emailEnabled = isEmailEnabled;
  operations.smtp = initializeEmailService;
  operations.scrape = async () => {
    assert.equal((await sendNotification({ id: 'synthetic' }, { automatic: true })).skipped, true);
    assert.equal((await testEmailConnection()).success, false);
    return { success: true, sectionResults: sections, items: [sample] };
  };
  assert.equal((await runProductionPilot({ env }, operations)).outcome, 'scraped');
  assert.equal(smtp.mock.callCount(), 0);
});

test('duplicate publications are skipped without PDF or summary processing', async () => {
  const { env, operations, calls } = fixture();
  operations.save = async () => ({ isNew: false });
  const result = await runProductionPilot({ env }, operations);
  assert.equal(result.outcome, 'scraped');
  assert.equal(result.duplicates, 1);
  assert.equal(result.newPublications, 0);
  assert.equal(calls.includes('analyze'), false);
});

test('unrelated writes are detected by post-run reconciliation', async () => {
  const { env, operations, state } = fixture();
  const log = operations.log;
  operations.log = async (...args) => { await log(...args); state.tables.notifications.sha256 = 'changed'; };
  await assert.rejects(runProductionPilot({ env }, operations), /PILOT_UNRELATED_TABLE_CHANGED/);
});

test('strict portal parsing distinguishes legitimate empty sections from malformed content', async t => {
  const card = '<div class="sub-section"><p class="sub-heading">Synthetic test</p><p class="sub-content">26/11/2026</p></div>';
  const home = '<div class="tab-pane" id="tenders"></div><div class="tab-pane" id="announcement"></div>';
  t.mock.method(axios, 'post', async (_url, body) => ({ data: body.includes('viewAllTenderService') ? card : '<html></html>' }));
  const request = t.mock.method(axios, 'request', async ({ method }) => ({ data: method === 'get' ? home : { contents: [] } }));
  const complete = await scrapeAllSections({ strict: true });
  assert.equal(complete.success, true);
  assert.deepEqual(complete.sectionResults, sections);
  request.mock.mockImplementation(async ({ method, url }) => ({ data: method === 'get' ? home :
    url.includes('Regulation') ? { contents: ['Synthetic with invalid date'], startDate: ['?'] } : { contents: [] } }));
  const partial = await scrapeAllSections({ strict: true });
  assert.equal(partial.success, false);
  assert.equal(partial.sectionResults.regulation, 'error');
  assert.equal(partial.sectionResults.guidance, 0);
  assert.equal((await scrapeAllSections()).success, true);
});
