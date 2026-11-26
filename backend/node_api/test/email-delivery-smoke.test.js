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
const recipients = ['chirag131004@gmail.com', 'chiragprabhat50@gmail.com'];
const oldKey = 'email_delivery_smoke_v1_claimed';
const newKey = 'email_delivery_smoke_v2_two_recipients_claimed';
const verified = { databaseVerified: true, previousClaimPreserved: true };
const env = {
  DGCA_MONITOR_ENABLED: 'false',
  EMAIL_NOTIFICATIONS_ENABLED: 'false',
  GITHUB_RUN_ATTEMPT: '1',
  EMAIL_DELIVERY_SMOKE_CONFIRMATION: 'SEND ONE TWO-RECIPIENT TEST EMAIL',
  EMAIL_APP_PASSWORD: 'fixture-app-password',
  DEPLOYMENT_TEST_NEON_HOST: 'ep-test.us-east-1.aws.neon.tech',
  PRODUCTION_NEON_HOST: 'ep-production.us-east-1.aws.neon.tech',
  DEPLOYMENT_TEST_DATABASE_URL: 'postgresql://neondb_owner:fixture@ep-test.us-east-1.aws.neon.tech/neondb?sslmode=require',
  EMAIL_FROM: 'ignored-sender@example.test',
  EMAIL_RECIPIENTS: 'ignored-a@example.test,ignored-b@example.test'
};

function mockDatabase(t, { authorized = true, identity = {}, previousClaim = true } = {}) {
  const state = { claimed: false, insertCount: 0, keys: new Map(previousClaim ? [[oldKey, 'true']] : []) };
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
            if (sql.includes('SELECT current_database')) {
              return { rows: [{ database_name: 'neondb', schema_name: 'public', in_recovery: false, read_only: 'off' }] };
            }
            assert.match(sql, /neon\.branch_id/);
            return { rows: [{ role: 'neondb_owner', project: 'tiny-sea-21255890', branch: 'br-plain-pine-belvpen0', endpoint: 'ep-test', ...identity }] };
          },
          release() {}
        };
      },
      async query(sql, params) {
        if (sql.startsWith('SELECT value FROM config')) {
          assert.deepEqual(params, [oldKey]);
          return { rows: state.keys.has(oldKey) ? [{ value: state.keys.get(oldKey) }] : [] };
        }
        assert.deepEqual(params, [newKey]);
        if (sql.startsWith('SELECT 1 FROM config')) return { rows: state.claimed ? [{}] : [] };
        assert.match(sql, /INSERT INTO config[\s\S]+ON CONFLICT \(key\) DO NOTHING/);
        if (state.claimed) return { rowCount: 0 };
        state.claimed = true;
        state.keys.set(newKey, 'true');
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
  assert.match(yaml, /vars\.DGCA_MONITOR_ENABLED == 'false' && vars\.EMAIL_NOTIFICATIONS_ENABLED == 'false'/);
  assert.match(yaml, /github\.run_attempt == '1'/);
  assert.match(yaml, /inputs\.confirmation == 'SEND ONE TWO-RECIPIENT TEST EMAIL'/);
  assert.deepEqual([...yaml.matchAll(/secrets\.(\w+)/g)].map(([, name]) => name),
    ['EMAIL_APP_PASSWORD', 'DEPLOYMENT_TEST_DATABASE_URL']);
});

test('the email smoke test fails closed before database or SMTP access', async t => {
  t.mock.method(pg, 'Pool', () => assert.fail('No database connection allowed'));
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('No SMTP connection allowed'));
  for (const [overrides, code] of [
    [{ DGCA_MONITOR_ENABLED: 'true' }, 'SMOKE_RECURRING_ENABLED'],
    [{ EMAIL_NOTIFICATIONS_ENABLED: 'true' }, 'SMOKE_EMAIL_ENABLED'],
    [{ EMAIL_NOTIFICATIONS_ENABLED: undefined }, 'SMOKE_EMAIL_ENABLED'],
    [{ GITHUB_RUN_ATTEMPT: '2' }, 'SMOKE_RUN_ATTEMPT'],
    [{ EMAIL_DELIVERY_SMOKE_CONFIRMATION: '' }, 'SMOKE_CONFIRMATION'],
    [{ EMAIL_APP_PASSWORD: '' }, 'SMOKE_SMTP_SECRET'],
    [{ DEPLOYMENT_TEST_DATABASE_URL: '' }, 'SMOKE_URL'],
    [{ DEPLOYMENT_TEST_DATABASE_URL: env.DEPLOYMENT_TEST_DATABASE_URL.replace('ep-test', 'ep-production') }, 'SMOKE_ENDPOINT'],
    [{ DEPLOYMENT_TEST_DATABASE_URL: env.DEPLOYMENT_TEST_DATABASE_URL.replace('ep-test', 'ep-test-pooler') }, 'SMOKE_ENDPOINT'],
    [{ DEPLOYMENT_TEST_DATABASE_URL: env.DEPLOYMENT_TEST_DATABASE_URL.replace('/neondb?', '/postgres?') }, 'SMOKE_DATABASE'],
    [{ DEPLOYMENT_TEST_DATABASE_URL: env.DEPLOYMENT_TEST_DATABASE_URL.replace('neondb_owner:', 'other_role:') }, 'SMOKE_DATABASE']
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

test('a mismatched Neon project, branch, endpoint or role prevents claims and SMTP', async t => {
  for (const identity of [{ project: 'wrong' }, { branch: 'br-gentle-bread-beix3pqb' }, { endpoint: 'wrong' }, { role: 'wrong' }]) {
    await t.test(JSON.stringify(identity), async sub => {
      const state = mockDatabase(sub, { identity });
      sub.mock.method(nodemailer, 'createTransport', () => assert.fail('No SMTP connection allowed'));
      await assert.rejects(runEmailDeliverySmokeTest(env), { code: 'SMOKE_DATABASE' });
      assert.equal(state.insertCount, 0);
    });
  }
});

test('an unexpected missing old claim prevents any new claim or SMTP attempt', async t => {
  const state = mockDatabase(t, { previousClaim: false });
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('No SMTP connection allowed'));
  await assert.rejects(runEmailDeliverySmokeTest(env), { code: 'SMOKE_PREVIOUS_CLAIM' });
  assert.equal(state.insertCount, 0);
});

test('mocked Gmail verification and real MIME rendering use exactly two fixed recipients and a valid synthetic PDF', async t => {
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
        assert.deepEqual(message.to, recipients);
        assert.deepEqual(message.envelope, { from: sender, to: recipients });
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
        return { accepted: [...recipients].reverse(), rejected: [] };
      }
    };
  });
  assert.deepEqual(await runEmailDeliverySmokeTest(env),
    { outcome: 'accepted-by-smtp', smtpVerified: true, attempted: true, acceptedCount: 2, rejectedCount: 0, pendingCount: 0, ...verified });
  assert.deepEqual(await runEmailDeliverySmokeTest(env), { outcome: 'already-claimed', ...verified });
  assert.equal(verifies, 1);
  assert.equal(attempts, 1);
  assert.equal(state.insertCount, 1);
  assert.deepEqual([...state.keys.keys()], [oldKey, newKey]);
});

test('partial, pending or incorrect acceptance is redacted, fails the run and cannot send again', async t => {
  for (const [name, acceptance, expected] of [
    ['one rejected', { accepted: [recipients[0]], rejected: [recipients[1]] }, [1, 1, 0]],
    ['one pending', { accepted: [recipients[0]], rejected: [], pending: [recipients[1]] }, [1, 0, 1]],
    ['pending even with two accepted', { accepted: recipients, rejected: [], pending: [recipients[1]] }, [2, 0, 1]],
    ['unexpected address', { accepted: [recipients[0], 'wrong@example.test'], rejected: [] }, [2, 0, 0]],
    ['duplicate acceptance', { accepted: [recipients[0], recipients[0]], rejected: [] }, [2, 0, 0]]
  ]) {
    await t.test(name, async sub => {
      const state = mockDatabase(sub);
      const sendMail = sub.mock.fn(async () => acceptance);
      sub.mock.method(nodemailer, 'createTransport', () => ({ verify: async () => true, sendMail }));
      assert.deepEqual(await runEmailDeliverySmokeTest(env), { outcome: 'smtp-delivery-unconfirmed',
        smtpVerified: true, attempted: true, acceptedCount: expected[0], rejectedCount: expected[1],
        pendingCount: expected[2], ...verified });
      assert.deepEqual(await runEmailDeliverySmokeTest(env), { outcome: 'already-claimed', ...verified });
      assert.equal(sendMail.mock.callCount(), 1);
      assert.equal(state.insertCount, 1);
    });
  }
});

test('failed authentication never claims or sends and reports only a safe code', async t => {
  const state = mockDatabase(t);
  t.mock.method(nodemailer, 'createTransport', () => ({
    verify: async () => { throw Object.assign(new Error(env.EMAIL_APP_PASSWORD), { code: 'EAUTH' }); },
    sendMail: () => assert.fail('No delivery after failed authentication')
  }));
  assert.deepEqual(await runEmailDeliverySmokeTest(env), { outcome: 'smtp-verification-failed', code: 'EAUTH', ...verified });
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
    outcome: 'smtp-delivery-unconfirmed', smtpVerified: true, attempted: true, code: 'ECONNRESET',
    acceptedCount: null, rejectedCount: null, pendingCount: null, ...verified
  });
  assert.deepEqual(await runEmailDeliverySmokeTest(env), { outcome: 'already-claimed', ...verified });
  assert.equal(attempts, 1);
  assert.equal(state.insertCount, 1);
});
