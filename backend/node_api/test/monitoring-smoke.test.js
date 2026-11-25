import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import axios from 'axios';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { runInMonitoringSmokeTest } from '../src/config/monitoring-smoke-context.js';
import { closeDatabase, getDatabase, initializeDatabase, verifyMonitoringSmokeConnection } from '../src/config/database.js';
import { runMonitoringSmokeTest, smokeDatabaseTarget } from '../src/services/monitoring-smoke-service.js';
import { initializeEmailService, isEmailEnabled, sendNotification, testEmailConnection } from '../src/services/notification-service.js';
import { getSettings } from '../src/services/settings-service.js';
import { analyzePublication } from '../src/services/summary-service.js';

const env = {
  DGCA_MONITOR_ENABLED: 'false',
  DEPLOYMENT_TEST_NEON_HOST: 'ep-test.us-east-1.aws.neon.tech',
  PRODUCTION_NEON_HOST: 'ep-production.us-east-1.aws.neon.tech',
  DEPLOYMENT_TEST_DATABASE_URL: 'postgresql://fixture:fixture@ep-test.us-east-1.aws.neon.tech/testdb?sslmode=require&channel_binding=require'
};

test('the smoke workflow is dispatch-only and receives only the dedicated database secret', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/dgca-monitor-smoke.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\s*\r?\n  workflow_dispatch:\s*\r?\npermissions:/m);
  assert.match(workflow, /vars\.DGCA_MONITOR_ENABLED == 'false'/);
  assert.deepEqual([...workflow.matchAll(/secrets\.(\w+)/g)].map(([, name]) => name), ['DEPLOYMENT_TEST_DATABASE_URL']);
  assert.doesNotMatch(workflow, /SMTP_|EMAIL_|worker:actions/);
});

test('the dedicated URL must match an independently supplied direct test endpoint', async () => {
  const target = smokeDatabaseTarget(env);
  assert.equal(target.hostname, env.DEPLOYMENT_TEST_NEON_HOST);
  assert.equal(target.databaseName, 'testdb');
  for (const url of [
    '', env.DEPLOYMENT_TEST_DATABASE_URL.replace('ep-test', 'ep-production'),
    env.DEPLOYMENT_TEST_DATABASE_URL.replace('ep-test', 'ep-test-pooler'),
    env.DEPLOYMENT_TEST_DATABASE_URL.replace('sslmode=require', 'sslmode=disable'),
    env.DEPLOYMENT_TEST_DATABASE_URL + '&host=ep-production.us-east-1.aws.neon.tech',
    env.DEPLOYMENT_TEST_DATABASE_URL + '&sslmode=verify-full'
  ]) {
    await assert.rejects(runMonitoringSmokeTest({ env: { ...env, DEPLOYMENT_TEST_DATABASE_URL: url } }, {
      verify: () => assert.fail('Invalid URL must be rejected before a connection')
    }));
  }
  assert.throws(() => smokeDatabaseTarget({ ...env, PRODUCTION_NEON_HOST: env.DEPLOYMENT_TEST_NEON_HOST }), /distinct/);
  await assert.rejects(runMonitoringSmokeTest({ env: { ...env, DGCA_MONITOR_ENABLED: 'true' } }), /remain disabled/);
});

function mockPool(t, { authorized = true, dns = env.DEPLOYMENT_TEST_NEON_HOST, readOnly = 'off', query }) {
  t.mock.method(pg, 'Pool', function fixturePool(options) {
    assert.equal(options.ssl.rejectUnauthorized, true);
    assert.equal(new URL(options.connectionString).hostname, env.DEPLOYMENT_TEST_NEON_HOST);
    return {
      on() {},
      async end() {},
      async connect() {
        return {
          connection: { stream: { encrypted: true, authorized, getPeerCertificate: () => ({ subjectaltname: `DNS:${dns}` }) } },
          async query(sql) {
            assert.match(sql, /SELECT current_database/);
            return { rows: [{ database_name: 'testdb', schema_name: 'public', in_recovery: false, read_only: readOnly }] };
          },
          release() {}
        };
      },
      async query(...args) { return query(...args); }
    };
  });
}

test('untrusted and wrong-host TLS fail closed before the snapshot or monitor', async t => {
  for (const options of [{ authorized: false }, { dns: env.PRODUCTION_NEON_HOST }]) {
    await t.test(JSON.stringify(options), async child => {
      mockPool(child, options);
      await assert.rejects(runMonitoringSmokeTest({ env }, {
        verify: verifyMonitoringSmokeConnection,
        monitor: () => assert.fail('No monitor writes allowed'),
        settings: () => assert.fail('TLS must be checked before reading settings'),
        snapshot: () => assert.fail('No snapshot before TLS verification'),
        close: closeDatabase
      }), { code: 'SMOKE_TLS' });
    });
  }
});

test('a trusted read-only endpoint cannot run the smoke test', async t => {
  mockPool(t, { readOnly: 'on' });
  await assert.rejects(runInMonitoringSmokeTest(smokeDatabaseTarget(env), async () => {
    try { await verifyMonitoringSmokeConnection(); } finally { await closeDatabase(); }
  }), { code: 'SMOKE_DATABASE' });
});

test('the application disables all mail entry points with saved email enabled', async t => {
  mockPool(t, { query: async sql => {
    assert.match(sql, /SELECT key, value FROM config/);
    return { rows: [{ key: 'emailEnabled', value: 'true' }, { key: 'recipients', value: '["fixture@example.test"]' }] };
  } });
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('SMTP transporter must not be created'));
  await runInMonitoringSmokeTest(smokeDatabaseTarget(env), async () => {
    try {
      await verifyMonitoringSmokeConnection();
      assert.equal((await getSettings()).emailEnabled, true);
      assert.equal(await isEmailEnabled(), false);
      assert.equal(await initializeEmailService(), null);
      assert.equal((await sendNotification({ id: 'fixture' })).skipped, true);
      assert.equal((await testEmailConnection()).success, false);
    } finally { await closeDatabase(); }
  });
  assert.equal(nodemailer.createTransport.mock.callCount(), 0);
});

test('analysis stays local even when a saved setting asks for an external provider', async t => {
  mockPool(t, { query: async () => ({ rows: [{ key: 'summaryProvider', value: '"claude"' }] }) });
  t.mock.method(axios, 'post', () => assert.fail('External inference must not be called'));
  const target = smokeDatabaseTarget(env);
  await runInMonitoringSmokeTest(target, async () => {
    try {
      assert.equal((await getSettings()).summaryProvider, 'claude');
      const analysis = await analyzePublication(
        { title: 'Crew rest', section: 'regulation', publicationDate: '2026-11-25' },
        { text: 'Operators shall review crew schedules and retain records of all required rest periods.' }
      );
      assert.equal(analysis.source, 'basic');
      assert.ok(analysis.summary);
    } finally { await closeDatabase(); }
  });
  const result = await runMonitoringSmokeTest({ env }, {
    verify: verifyMonitoringSmokeConnection, settings: getSettings,
    monitor: () => assert.fail('Non-basic saved provider must block a live run'),
    close: closeDatabase
  });
  assert.equal(result.outcome, 'invalid-summary-provider');
});

test('one monitor call reports scrape results and distinguishes safe skips and failures', async () => {
  const baseline = { publications: '40', notifications: '3', monitoringLogs: '26', latestLog: { id: '26' } };
  const scraped = { publications: '41', notifications: '3', monitoringLogs: '27', latestLog: { id: '27', status: 'success' } };
  const slot = '2026-11-25T03:00:00.000Z';
  const now = new Date(slot);
  for (const fixture of [
    { result: { success: true, itemsFound: 1, notificationsSent: 0 }, after: scraped, expected: 'scraped' },
    { result: { success: true, itemsFound: 1 }, after: baseline, expected: 'monitoring-log-invariant-failed' },
    { result: { success: true, itemsFound: 1 }, after: { ...scraped, notifications: '4' }, expected: 'notification-invariant-failed' },
    { result: { success: true, skipped: true, reason: 'Slot already claimed' }, expected: 'slot-already-claimed' },
    { result: { success: true, skipped: true, reason: 'Monitor is busy' }, expected: 'monitor-busy' },
    { result: { success: false }, expected: 'monitor-error' },
    { expected: 'outside-monitoring-window' }
  ]) {
    let monitorCalls = 0;
    let snapshots = 0;
    const output = await runMonitoringSmokeTest({ env, now }, {
      verify: async () => {},
      settings: async () => ({ summaryProvider: 'basic' }),
      getSlot: async time => { assert.equal(time, now); return fixture.result ? slot : null; },
      monitor: async options => {
        assert.deepEqual(options, { scheduledSlot: slot });
        monitorCalls++;
        return fixture.result;
      },
      snapshot: async () => snapshots++ ? fixture.after ?? baseline : baseline,
      close: async () => {}
    });
    assert.equal(output.outcome, fixture.expected);
    assert.equal(output.before, baseline);
    assert.equal(output.after, fixture.after ?? baseline);
    assert.equal(monitorCalls, fixture.result ? 1 : 0);
    assert.equal(snapshots, 2);
  }
});

test('the real monitor processes one mocked scrape and leaves email decisions and queued jobs intact', {
  skip: !process.env.TEST_DATABASE_URL
}, async t => {
  const fixtureUrl = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(fixtureUrl.hostname));
  const admin = new pg.Client(fixtureUrl.href);
  await admin.connect();
  const schema = `smoke_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  fixtureUrl.searchParams.set('options', `-c search_path=${schema}`);
  const PgPool = pg.Pool;
  t.mock.method(pg, 'Pool', function disposableFixturePool(options) {
    assert.equal(new URL(options.connectionString).hostname, env.DEPLOYMENT_TEST_NEON_HOST);
    return new PgPool({ ...options, connectionString: fixtureUrl.href, ssl: false });
  });
  const withFixture = callback => runInMonitoringSmokeTest(smokeDatabaseTarget(env), async () => {
    try { return await callback(getDatabase()); } finally { await closeDatabase(); }
  });
  await withFixture(async db => {
    await initializeDatabase();
    await db.query(await readFile(new URL('../src/config/deployment.sql', import.meta.url), 'utf8'));
    await db.query(`INSERT INTO config(key,value) VALUES ('emailEnabled','true'), ('summaryProvider','"basic"'), ('intervalMinutes','15')`);
    await db.query(`INSERT INTO dgca_jobs(id,kind,scope,input) VALUES ($1, 'test-email', 'fixture', '{}')`, [randomUUID()]);
  });

  const home = t.mock.method(axios, 'request', async () => ({ data: '<html></html>' }));
  const sections = t.mock.method(axios, 'post', async () => ({
    data: '<div class="sub-section"><p class="sub-heading">Crew Rest Fixture</p><p class="sub-content">23/11/2026</p></div>'
  }));
  t.mock.method(axios, 'get', () => assert.fail('This fixture has no PDF or remote AI requests'));
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('No email transport allowed'));
  const now = new Date('2026-11-25T03:00:00Z');
  // Certificate behavior is tested above. This case uses the isolated loopback transport.
  const run = () => runMonitoringSmokeTest({ env, now }, { verify: async () => {} });
  const result = await run();
  assert.equal(result.outcome, 'scraped');
  assert.equal(result.notificationsUnchanged, true);
  assert.equal(result.after.publications, '4');
  assert.equal(result.after.monitoringLogs, '1');
  assert.equal((await run()).outcome, 'slot-already-claimed');
  assert.equal(home.mock.callCount(), 1);
  assert.equal(sections.mock.callCount(), 4);
  await withFixture(async db => {
    assert.deepEqual(await db.prepare('SELECT state FROM dgca_jobs').all(), [{ state: 'queued' }]);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM updates WHERE summary_source = 'basic' AND email_status IS NULL").get()).n, 4);
  });
});
