import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { runInMonitoringSmokeTest } from '../src/config/monitoring-smoke-context.js';
import { smokeDatabaseTarget } from '../src/config/smoke-database-target.js';
import { runEmailDeliverySmokeTest } from '../src/services/email-delivery-smoke-service.js';
import { sendEmailDeliverySmokeTest } from '../src/services/notification-service.js';
import { extractText } from '../src/services/pdf-service.js';

const sender = 'dgcamonitor@gmail.com';
const recipient = 'chirag131004@gmail.com';
const env = {
  DGCA_MONITOR_ENABLED: 'false',
  EMAIL_DELIVERY_SMOKE_CONFIRMATION: 'SEND ONE TEST EMAIL',
  EMAIL_APP_PASSWORD: 'fixture-app-password',
  DEPLOYMENT_TEST_NEON_HOST: 'ep-test.us-east-1.aws.neon.tech',
  PRODUCTION_NEON_HOST: 'ep-production.us-east-1.aws.neon.tech',
  DEPLOYMENT_TEST_DATABASE_URL: 'postgresql://fixture:fixture@ep-test.us-east-1.aws.neon.tech/testdb?sslmode=require',
  EMAIL_FROM: 'ignored-sender@example.test',
  EMAIL_RECIPIENTS: 'ignored-a@example.test,ignored-b@example.test'
};

function mockDatabase(t, { authorized = true } = {}) {
  const state = { claimed: false, insertCount: 0 };
  t.mock.method(pg, 'Pool', function fixturePool(options) {
    assert.equal(new URL(options.connectionString).hostname, env.DEPLOYMENT_TEST_NEON_HOST);
    assert.equal(options.ssl.rejectUnauthorized, true);
    return {
      on() {},
      async end() {},
      async connect() {
        return {
          connection: { stream: { encrypted: true, authorized,
            getPeerCertificate: () => ({ subjectaltname: `DNS:${env.DEPLOYMENT_TEST_NEON_HOST}` }) } },
          async query(sql) {
            assert.match(sql, /SELECT current_database/);
            return { rows: [{ database_name: 'testdb', schema_name: 'public', in_recovery: false, read_only: 'off' }] };
          },
          release() {}
        };
      },
      async query(sql, params) {
        assert.deepEqual(params, ['email_delivery_smoke_v1_claimed']);
        if (sql.startsWith('SELECT 1 FROM config')) return { rows: state.claimed ? [{}] : [] };
        assert.match(sql, /INSERT INTO config[\s\S]+ON CONFLICT \(key\) DO NOTHING/);
        if (state.claimed) return { rowCount: 0 };
        state.claimed = true;
        state.insertCount++;
        return { rowCount: 1 };
      }
    };
  });
  return state;
}

test('the email workflow is manual, requires confirmation and scopes its secrets', async () => {
  const yaml = await readFile(new URL('../../../.github/workflows/dgca-email-delivery-smoke.yml', import.meta.url), 'utf8');
  assert.match(yaml, /^on:\s*\r?\n  workflow_dispatch:\s*\r?\n    inputs:/m);
  assert.doesNotMatch(yaml, /^  (push|schedule|pull_request):/m);
  assert.match(yaml, /vars\.DGCA_MONITOR_ENABLED == 'false'/);
  assert.deepEqual([...yaml.matchAll(/secrets\.(\w+)/g)].map(([, name]) => name),
    ['EMAIL_APP_PASSWORD', 'DEPLOYMENT_TEST_DATABASE_URL']);
});

test('the email smoke test fails closed before database or SMTP access', async t => {
  t.mock.method(pg, 'Pool', () => assert.fail('No database connection allowed'));
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('No SMTP connection allowed'));
  for (const [overrides, code] of [
    [{ DGCA_MONITOR_ENABLED: 'true' }, 'SMOKE_RECURRING_ENABLED'],
    [{ EMAIL_DELIVERY_SMOKE_CONFIRMATION: '' }, 'SMOKE_CONFIRMATION'],
    [{ EMAIL_APP_PASSWORD: '' }, 'SMOKE_SMTP_SECRET'],
    [{ DEPLOYMENT_TEST_DATABASE_URL: '' }, 'SMOKE_URL'],
    [{ DEPLOYMENT_TEST_DATABASE_URL: env.DEPLOYMENT_TEST_DATABASE_URL.replace('ep-test', 'ep-production') }, 'SMOKE_ENDPOINT'],
    [{ DEPLOYMENT_TEST_DATABASE_URL: env.DEPLOYMENT_TEST_DATABASE_URL.replace('ep-test', 'ep-test-pooler') }, 'SMOKE_ENDPOINT']
  ]) {
    await assert.rejects(runEmailDeliverySmokeTest({ ...env, ...overrides }), { code });
  }
  await assert.rejects(runInMonitoringSmokeTest(smokeDatabaseTarget(env),
    () => sendEmailDeliverySmokeTest({})), /verified email delivery smoke-test context/);
});

test('certificate failure prevents SMTP authentication and a database claim', async t => {
  const state = mockDatabase(t, { authorized: false });
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('No SMTP connection allowed'));
  await assert.rejects(runEmailDeliverySmokeTest(env), { code: 'SMOKE_TLS' });
  assert.equal(state.insertCount, 0);
});

test('mocked Gmail verification and real MIME rendering use one fixed recipient and a valid synthetic PDF', async t => {
  const state = mockDatabase(t);
  const mimeTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  let verifies = 0;
  let attempts = 0;
  t.mock.method(nodemailer, 'createTransport', options => {
    assert.equal(options.host, 'smtp.gmail.com');
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.disableFileAccess, true);
    assert.equal(options.disableUrlAccess, true);
    assert.equal(options.auth?.user, sender);
    assert.ok(options.auth?.pass === env.EMAIL_APP_PASSWORD, 'Expected the fixture app password');
    return {
      async verify() {
        verifies++;
        assert.equal(state.claimed, false);
        return true;
      },
      async sendMail(message) {
        attempts++;
        assert.equal(state.claimed, true);
        assert.equal(message.from.address, sender);
        assert.equal(message.to, recipient);
        assert.deepEqual(message.envelope, { from: sender, to: [recipient] });
        assert.equal(message.cc, undefined);
        assert.equal(message.bcc, undefined);
        assert.match(message.subject, /^\[TEST ONLY\]/);
        assert.match(message.text, /synthetic fixture/i);
        assert.match(message.html, /TEST ONLY - Synthetic/i);
        assert.equal(message.attachments.length, 1);
        const [pdf] = message.attachments;
        assert.equal(pdf.filename, 'dgca-email-smoke-test.pdf');
        assert.equal(pdf.contentType, 'application/pdf');
        const extracted = await extractText(pdf.content);
        assert.equal(extracted.pageCount, 1);
        assert.match(extracted.text, /TEST ONLY - Synthetic DGCA email attachment/);
        const mime = (await mimeTransport.sendMail(message)).message.toString('utf8');
        assert.match(mime, /Content-Type: multipart\/mixed/i);
        assert.match(mime, /Content-Type: multipart\/alternative/i);
        assert.match(mime, /Content-Type: application\/pdf/i);
        assert.match(mime, /dgca-email-smoke-test\.pdf/i);
        return { accepted: [recipient], rejected: [] };
      }
    };
  });
  assert.deepEqual(await runEmailDeliverySmokeTest(env),
    { outcome: 'accepted-by-smtp', smtpVerified: true, attempted: true });
  assert.deepEqual(await runEmailDeliverySmokeTest(env), { outcome: 'already-claimed' });
  assert.equal(verifies, 1);
  assert.equal(attempts, 1);
  assert.equal(state.insertCount, 1);
});

test('failed authentication never claims or sends and reports only a safe code', async t => {
  const state = mockDatabase(t);
  t.mock.method(nodemailer, 'createTransport', () => ({
    verify: async () => { throw Object.assign(new Error(env.EMAIL_APP_PASSWORD), { code: 'EAUTH' }); },
    sendMail: () => assert.fail('No delivery after failed authentication')
  }));
  assert.deepEqual(await runEmailDeliverySmokeTest(env), { outcome: 'smtp-verification-failed', code: 'EAUTH' });
  assert.equal(state.insertCount, 0);
});

test('concurrent runs share one claim and an ambiguous SMTP failure cannot be retried', async t => {
  const state = mockDatabase(t);
  let verifies = 0;
  let attempts = 0;
  let release;
  const bothVerifying = new Promise(resolve => { release = resolve; });
  t.mock.method(nodemailer, 'createTransport', () => ({
    async verify() {
      if (++verifies === 2) release();
      await bothVerifying;
      return true;
    },
    async sendMail() {
      attempts++;
      throw Object.assign(new Error(env.EMAIL_APP_PASSWORD), { code: 'ECONNRESET' });
    }
  }));
  const results = await Promise.all([runEmailDeliverySmokeTest(env), runEmailDeliverySmokeTest(env)]);
  assert.deepEqual(results.map(value => value.outcome).sort(), ['already-claimed', 'smtp-delivery-unconfirmed']);
  assert.deepEqual(results.find(result => result.attempted), {
    outcome: 'smtp-delivery-unconfirmed', smtpVerified: true, attempted: true, code: 'ECONNRESET'
  });
  assert.equal((await runEmailDeliverySmokeTest(env)).outcome, 'already-claimed');
  assert.equal(attempts, 1);
  assert.equal(state.insertCount, 1);
});
