import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ORIGIN, REVISION, RUN_AT, RUN_ID, approved, readDatabase, readHosted } from './hosted-preflight.mjs';
import { smokeDatabaseTarget } from '../backend/node_api/src/config/smoke-database-target.js';

const env = {
  HOSTED_PREFLIGHT_CONFIRMATION: 'RUN HOSTED READ ONLY PREFLIGHT', HOSTED_SMOKE_URL: ORIGIN,
  HOSTED_SMOKE_TEST_RUN_ID: String(RUN_ID), HOSTED_SMOKE_TEST_RUN_AT: RUN_AT,
  DGCA_MONITOR_ENABLED: 'false', EMAIL_NOTIFICATIONS_ENABLED: 'false',
  HOSTED_SMOKE_VERCEL_BYPASS: 'synthetic-bypass', HOSTED_SMOKE_OPERATOR_USERNAME: 'synthetic-operator',
  HOSTED_SMOKE_OPERATOR_PASSWORD: 'synthetic-operator-password'
};
const run = { id: RUN_ID, run_at: RUN_AT, status: 'success', items_found: 40, items_new: 1, duration_ms: 25324 };
const target = { hostname: 'ep-example.region.aws.neon.tech', databaseName: 'neondb' };
const challenge = headers => new Response(null, { status: 401, headers });
const operatorChallenge = () => challenge({ 'www-authenticate': 'Basic realm="DGCA Monitor", charset="UTF-8"' });

function database({ certificateName = target.hostname, readOnly = 'on', email = 'false', expiring = '0', reserved = '0', missingRun = false } = {}) {
  const calls = [];
  const steps = [[], [{ db: target.databaseName, read_only: readOnly, replica: false }],
    missingRun ? [] : [{ ...run, id: String(run.id), items_found: '40', items_new: '1', duration_ms: '25324' }],
    [{ value: email }], [{ expiring, reserved }]];
  const client = {
    connect: async () => {},
    connection: { stream: { encrypted: true, authorized: true,
      getPeerCertificate: () => ({ subjectaltname: `DNS:${certificateName}` }) } },
    async query(sql, params) {
      calls.push(sql);
      assert.match(sql, /^(BEGIN READ ONLY$|SELECT\b|ROLLBACK$)/);
      if (sql.includes('public.monitoring_logs')) assert.deepEqual(params, [RUN_ID, RUN_AT]);
      return { rows: sql === 'ROLLBACK' ? [] : steps.shift() };
    }
  };
  return { client, calls };
}

test('requires exact authorization, URL, record and both disabled flags', () => {
  assert.equal(approved(env), true);
  for (const key of ['HOSTED_PREFLIGHT_CONFIRMATION', 'HOSTED_SMOKE_URL', 'HOSTED_SMOKE_TEST_RUN_ID',
    'HOSTED_SMOKE_TEST_RUN_AT', 'DGCA_MONITOR_ENABLED', 'EMAIL_NOTIFICATIONS_ENABLED', 'HOSTED_SMOKE_VERCEL_BYPASS']) {
    assert.equal(approved({ ...env, [key]: '' }), false, key);
  }
});

test('uses the manual-only workflow with a pinned checkout and no publish or deploy step', async () => {
  const workflow = await readFile(new URL('../.github/workflows/dgca-hosted-preflight.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\non:\r?\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  (push|schedule|pull_request|workflow_run):/m);
  assert.match(workflow, /permissions:\r?\n  contents: read/);
  assert.match(workflow, /timeout-minutes: 4/);
  assert.ok(workflow.includes(REVISION));
  assert.match(workflow, /run: node ops\/hosted-preflight\.mjs/);
  assert.doesNotMatch(workflow, /run:.*\b(vercel|gh|git push)\b|EMAIL_APP_PASSWORD/);
});

test('the pinned endpoint validator rejects production, poolers and TLS bypass options', () => {
  const prod = 'ep-production.region.aws.neon.tech';
  const targets = { DEPLOYMENT_TEST_NEON_HOST: target.hostname, PRODUCTION_NEON_HOST: prod };
  const check = (host, options = 'sslmode=require') => smokeDatabaseTarget({ ...targets,
    DEPLOYMENT_TEST_DATABASE_URL: `postgresql://synthetic:synthetic@${host}/neondb?${options}` });
  assert.equal(check(target.hostname).hostname, target.hostname);
  assert.throws(() => check(prod), { code: 'SMOKE_ENDPOINT' });
  assert.throws(() => check('ep-example-pooler.region.aws.neon.tech'), { code: 'SMOKE_ENDPOINT' });
  assert.throws(() => check(target.hostname, 'sslmode=disable'), { code: 'SMOKE_URL_OPTIONS' });
});

test('queries only inside a verified read-only transaction and normalizes PG bigints', async () => {
  const { client, calls } = database();
  const checks = [];
  assert.deepEqual(await readDatabase(client, target, (key, pass) => checks.push([key, pass])), run);
  assert.equal(calls[0], 'BEGIN READ ONLY');
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(checks.length, 5);
  assert.ok(checks.every(([, pass]) => pass));
});

test('rejects a mismatched certificate before SQL and rolls back on failed transaction verification', async () => {
  const unsafe = database({ certificateName: 'ep-other.region.aws.neon.tech' });
  await assert.rejects(readDatabase(unsafe.client, target, () => {}), /TLS/);
  assert.deepEqual(unsafe.calls, []);
  const writable = database({ readOnly: 'off' });
  await assert.rejects(readDatabase(writable.client, target, () => {}), /database identity/);
  assert.equal(writable.calls.length, 3);
  assert.equal(writable.calls.at(-1), 'ROLLBACK');
});

test('reports missing records, enabled overrides, expiring sessions and capacity pressure', async () => {
  const { client } = database({ missingRun: true, email: 'true', expiring: '1', reserved: '83886081' });
  const checks = {};
  await readDatabase(client, target, (key, pass) => { checks[key] = pass; });
  assert.deepEqual(checks, { 'direct-test-database-tls-read-only': true, 'known-test-record': false,
    'saved-email-override-safe': false, 'no-unrelated-expiring-uploads': false, 'upload-capacity': false });
});

test('only sends credentials after the DGCA challenge, on the pinned origin, with redirects blocked', async () => {
  const checks = [];
  let count = 0;
  await readHosted(env, run, (key, pass) => checks.push([key, pass]), async (url, options) => {
    assert.equal(url, `${ORIGIN}/api/monitor/status`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-vercel-protection-bypass'], env.HOSTED_SMOKE_VERCEL_BYPASS);
    if (++count === 1) {
      assert.equal(options.headers.Authorization, undefined);
      return operatorChallenge();
    }
    assert.match(options.headers.Authorization, /^Basic /);
    return Response.json({ email: { enabled: false }, recentRuns: [run] });
  });
  assert.equal(count, 2);
  assert.equal(checks.length, 4);
  assert.ok(checks.every(([, pass]) => pass));
});

test('stops at a generic Vercel 401 and reports hosted email or record mismatches', async () => {
  const checks = {};
  let count = 0;
  const report = (key, pass) => { checks[key] = pass; };
  await readHosted(env, run, report, async () => { count++; return challenge(); });
  assert.equal(count, 1);
  assert.deepEqual(checks, { 'vercel-bypass-and-operator-gate': false });
  await readHosted(env, run, report, async () => ++count === 2 ? operatorChallenge() :
    Response.json({ email: { enabled: true }, recentRuns: [{ ...run, duration_ms: 7 }] }));
  assert.equal(checks['effective-hosted-email-disabled'], false);
  assert.equal(checks['hosted-record-matches-direct-test-record'], false);
});
