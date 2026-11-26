import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import axios from 'axios';
import nodemailer from 'nodemailer';
import pg from 'pg';

const fixtureUrl = process.env.TEST_DATABASE_URL;
const deploymentSql = new URL('../src/config/deployment.sql', import.meta.url);

async function fixture(t) {
  const url = new URL(fixtureUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only disposable loopback PostgreSQL is allowed');
  const admin = new pg.Client(url.href);
  await admin.connect();
  const schema = 'recurring_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  url.searchParams.set('options', '-c search_path=' + schema);
  delete process.env.VERCEL;
  Object.assign(process.env, {
    DATABASE_URL: url.href, DGCA_ACTIONS_WORKER: '1', DGCA_MONITOR_ENABLED: 'true',
    EMAIL_NOTIFICATIONS_ENABLED: 'false', SUMMARY_PROVIDER: 'basic', USE_WINDOWS_CERTS: 'false',
    EMAIL_FROM: 'sender@example.invalid', EMAIL_APP_PASSWORD: 'mock-smtp-password', SMTP_HOST: 'smtp.example.invalid',
    SMTP_PORT: '465', SCRAPER_RETRY_ATTEMPTS: '1'
  });
  const { initializeDatabase, closeDatabase, getDatabase } = await import('../src/config/database.js');
  t.after(async () => {
    await closeDatabase();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  await initializeDatabase();
  const db = getDatabase();
  await db.query(await readFile(deploymentSql, 'utf8'));
  return { db, admin };
}

function portal(t) {
  const empty = '<div class="tab-pane" id="tenders"></div><div class="tab-pane" id="announcement">No publications available</div>';
  const source = { html: empty, badRegulation: false, layoutChange: false, title: null, tenderTitle: null, calls: 0 };
  t.mock.method(axios, 'request', async ({ method, url }) => {
    if (method === 'get') {
      source.calls++;
      return { data: source.layoutChange ? '<div class="tab-pane" id="tenders"><ul><li>Unknown notice layout</li></ul></div>' : source.html };
    }
    return { data: url.includes('Regulation') && source.badRegulation ? { changed: true } : { contents: [] } };
  });
  t.mock.method(axios, 'post', async (_url, body) => {
    const title = body.includes('classification=announcement') ? source.title
      : body.includes('viewAllTenderService') ? source.tenderTitle : null;
    return { data: title ? '<div class="sub-section"><p class="sub-heading"><a onclick="pdfDownload(\'fixture-id\')">' +
      title + '</a></p><p class="sub-content">26/11/2026</p></div>' : '<html></html>' };
  });
  // The browser and PDFs get synthetic responses. No request can reach DGCA or another host.
  t.mock.method(axios, 'get', async () => ({
    data: Buffer.from('%PDF-1.4\nsynthetic fixture'),
    headers: { 'content-type': 'application/pdf' }
  }));
  return source;
}

test('recurring workflow uses a second email gate on both SMTP secrets and preserves its schedule', async () => {
  const yaml = await readFile(new URL('../../../.github/workflows/dgca-monitor.yml', import.meta.url), 'utf8');
  assert.match(yaml, /cron: '7,37 \* \* \* \*'/);
  assert.match(yaml, /timeout-minutes: 14/);
  for (const secret of ['EMAIL_APP_PASSWORD', 'SMTP_PASSWORD']) {
    assert.ok(yaml.includes(secret + ": ${{ vars.EMAIL_NOTIFICATIONS_ENABLED == 'true' && secrets." + secret + " || '' }}"));
  }
});

test('shifted 30-minute triggers match durable UTC slots across IST and UTC boundaries', {
  skip: !fixtureUrl
}, async t => {
  const { db } = await fixture(t);
  Object.assign(process.env, { MONITOR_INTERVAL_MINUTES: '30', MONITOR_START_HOUR: '0', MONITOR_END_HOUR: '23' });
  const { getGitHubMonitoringSlot, getSchedulerStatus } = await import('../src/services/scheduler-service.js');
  const { claimScheduledMonitoringSlot } = await import('../src/services/monitor-service.js');
  const slot = time => getGitHubMonitoringSlot(new Date(time));
  const boundary = 30 * 60 * 1000;
  const start = Date.parse('2026-11-25T00:00:00Z');
  assert.equal((await getSchedulerStatus()).intervalMinutes, 30);
  // The saved setting takes precedence over the GitHub environment default.
  await db.query("INSERT INTO config (key,value) VALUES ('intervalMinutes','30')");
  process.env.MONITOR_INTERVAL_MINUTES = '15';
  for (let index = 0; index < 96; index++) {
    const expected = start + index * boundary;
    assert.equal(await slot(expected + 7 * 60 * 1000), new Date(expected).toISOString());
  }
  assert.equal((await getSchedulerStatus()).intervalMinutes, 30);
  assert.equal(await slot('2026-11-26T18:29:59.999Z'), '2026-11-26T18:00:00.000Z');
  const istMidnight = await slot('2026-11-26T18:37:00.000Z');
  const utcMidnight = await slot('2026-11-27T00:07:00.000Z');
  assert.equal(istMidnight, '2026-11-26T18:30:00.000Z');
  assert.equal(utcMidnight, '2026-11-27T00:00:00.000Z');
  const claims = await Promise.all([claimScheduledMonitoringSlot(istMidnight), claimScheduledMonitoringSlot(istMidnight)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await claimScheduledMonitoringSlot(utcMidnight), true);
  assert.equal(await claimScheduledMonitoringSlot(istMidnight), false);
  process.env.MONITOR_END_HOUR = '0';
  assert.equal(await slot('2026-11-26T18:07:00.000Z'), null);
  assert.equal(await slot('2026-11-26T18:37:00.000Z'), istMidnight);
  assert.equal(await slot('2026-11-26T19:37:00.000Z'), null);
});

test('recurring monitor verifies each section, preserves existing duplicates, and keeps interrupted slots claimed', {
  skip: !fixtureUrl
}, async t => {
  const { db } = await fixture(t);
  const source = portal(t);
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('Worker must not initialize SMTP'));
  const { checkForUpdates } = await import('../src/services/monitor-service.js');
  const { acquireMonitoringLock } = await import('../src/config/database.js');
  const readLogs = () => db.prepare('SELECT status,items_found,items_new,error_message FROM monitoring_logs ORDER BY id').all();
  const total = async () => (await db.prepare('SELECT count(*) AS n FROM updates').get()).n;
  const slot = minute => '2026-11-26T10:' + minute + ':00.000Z';

  const empty = await checkForUpdates({ scheduledSlot: slot('00') });
  assert.equal(empty.success, true);
  assert.deepEqual(empty.sectionResults, { tenders: 0, announcements: 0, regulation: 0, guidance: 0 });

  source.title = 'Synthetic verified announcement';
  source.badRegulation = true;
  const partial = await checkForUpdates({ scheduledSlot: slot('15') });
  assert.equal(partial.success, false);
  assert.deepEqual(partial.sectionResults, { tenders: 0, announcements: 1, regulation: 'error', guidance: 0 });
  assert.equal(await total(), 0, 'partial results must never be persisted');
  assert.deepEqual(await checkForUpdates({ scheduledSlot: slot('15') }),
    { success: true, skipped: true, reason: 'Slot already claimed' });

  source.badRegulation = false;
  source.layoutChange = true;
  const changed = await checkForUpdates({ scheduledSlot: slot('30') });
  assert.equal(changed.success, false);
  assert.equal(changed.sectionResults.tenders, 'error');
  assert.equal(await total(), 0);
  source.layoutChange = false;

  const holder = await acquireMonitoringLock();
  try {
    assert.equal((await checkForUpdates({ scheduledSlot: slot('45') })).reason, 'Monitor is busy');
  } finally { await holder.release(); }
  const interrupted = await checkForUpdates({ scheduledSlot: slot('45'), onScheduledStart() { throw new Error('Interrupted fixture'); } });
  assert.equal(interrupted.success, false);
  assert.equal((await checkForUpdates({ scheduledSlot: slot('45') })).reason, 'Slot already claimed');

  assert.equal((await checkForUpdates({ scheduledSlot: '2026-11-26T11:00:00.000Z' })).newItems, 1);
  const original = await db.prepare('SELECT to_jsonb(updates)::text AS row FROM updates').get();
  source.title = null;
  source.tenderTitle = 'Other title with the same attachment';
  assert.equal((await checkForUpdates({ scheduledSlot: '2026-11-26T11:15:00.000Z' })).newItems, 0);
  assert.deepEqual(await db.prepare('SELECT to_jsonb(updates)::text AS row FROM updates').get(), original);
  const logs = await readLogs();
  assert.deepEqual(logs.map(row => row.status), ['success', 'failed', 'failed', 'failed', 'success', 'success']);
  assert.match(logs[1].error_message, /regulation/);
  assert.match(logs[2].error_message, /tenders/);
  assert.equal(await total(), 1);
});

test('the recurring email gate covers all saved and GitHub values, SMTP checks, manual jobs and automatic monitoring', {
  skip: !fixtureUrl
}, async t => {
  const { db } = await fixture(t);
  portal(t);
  const { checkForUpdates } = await import('../src/services/monitor-service.js');
  const { processActionsJob } = await import('../src/services/actions-worker.js');
  const { enqueueJob, claimJob, readJob } = await import('../src/services/job-service.js');
  const { initializeEmailService, isEmailEnabled, testEmailConnection } = await import('../src/services/notification-service.js');
  let verifies = 0;
  let sends = 0;
  const transport = t.mock.method(nodemailer, 'createTransport', () => ({
    async verify() { verifies++; return true; },
    async sendMail() { sends++; return { messageId: 'fixture-' + sends }; }
  }));
  await db.query("INSERT INTO config(key,value) VALUES ('sameDayOnly','false'), ('recipients','[\"recipient@example.invalid\"]')");
  const smtpState = () => [transport.mock.callCount(), verifies, sends];
  for (const [flag, saved, allowed] of [
    ['false', true, false], ['false', false, false], ['true', false, false], ['true', undefined, false],
    ['true', true, true], ['false', true, false]
  ]) {
    process.env.EMAIL_NOTIFICATIONS_ENABLED = flag;
    await db.query("DELETE FROM config WHERE key='emailEnabled'");
    if (saved !== undefined) await db.query("INSERT INTO config(key,value) VALUES ('emailEnabled',$1)", [String(saved)]);
    const callsBefore = smtpState();
    const historyBefore = (await db.prepare('SELECT count(*) AS n FROM notifications').get()).n;
    const claimsBefore = (await db.prepare('SELECT count(*) AS n FROM updates WHERE email_delivery_started_at IS NOT NULL').get()).n;
    assert.equal(await isEmailEnabled(), allowed);
    if (!allowed) assert.equal(await initializeEmailService(), null);
    const title = 'Synthetic automatic ' + randomUUID();
    const { saveUpdate } = await import('../src/services/state-service.js');
    const row = await saveUpdate({ title, section: 'announcements', publicationDate: '2026-11-26' });
    const monitored = await checkForUpdates();
    assert.equal(monitored.success, true);
    assert.equal(monitored.notificationsSent, allowed ? 1 : 0);

    for (const kind of ['test-email', 'smtp-check']) {
      const input = kind === 'test-email' ? { id: row.id } : {};
      const { id } = await enqueueJob(kind, input);
      await processActionsJob(await claimJob(id), () => {});
      const job = await readJob(id, 0);
      const detail = JSON.parse(job.chunk);
      assert.equal(detail.success, allowed);
    }
    assert.equal((await testEmailConnection()).success, allowed);
    if (allowed) {
      assert.equal(transport.mock.callCount(), 1);
      assert.equal(verifies - callsBefore[1], 2);
      assert.equal(sends - callsBefore[2], 2);
    } else {
      assert.deepEqual(smtpState(), callsBefore, 'disabled cases must not use even an existing transport');
      assert.equal((await db.prepare('SELECT count(*) AS n FROM notifications').get()).n, historyBefore);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM updates WHERE email_delivery_started_at IS NOT NULL').get()).n, claimsBefore);
    }
  }
});
