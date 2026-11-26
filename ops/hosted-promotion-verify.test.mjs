import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ORIGIN as STAGED, REVISION, RUN_ID, RUN_AT } from './hosted-preflight.mjs';
import { approvedMode, LIVE, PROJECT_ID, VERCEL_ID, VERCEL_ALIAS_LOOKUP, VERCEL_DEPLOYMENT_LOOKUP,
  readTestRecord, verify, verifyPromotedAlias } from './hosted-promotion-verify.mjs';

const pre = {
  DGCA_VERIFY_MODE: 'pre-promotion', DGCA_VERIFY_CONFIRMATION: 'VERIFY BEFORE DGCA PROMOTION',
  DGCA_MONITOR_ENABLED: 'false', EMAIL_NOTIFICATIONS_ENABLED: 'false', HOSTED_SMOKE_URL: STAGED,
  HOSTED_SMOKE_TEST_RUN_ID: String(RUN_ID), HOSTED_SMOKE_TEST_RUN_AT: RUN_AT,
  HOSTED_SMOKE_OPERATOR_USERNAME: 'synthetic-user', HOSTED_SMOKE_OPERATOR_PASSWORD: 'synthetic-only-password',
  HOSTED_SMOKE_VERCEL_BYPASS: 'synthetic-only-bypass'
};
const post = { ...pre, DGCA_VERIFY_MODE: 'post-promotion', DGCA_VERIFY_CONFIRMATION: 'VERIFY AFTER DGCA PROMOTION',
  VERCEL_PROMOTION_VERIFY_TOKEN: 'synthetic-vercel-token' };
const run = { id: RUN_ID, run_at: RUN_AT, status: 'success', items_found: 40, items_new: 1, duration_ms: 25324 };
const assignment = { alias: new URL(LIVE).hostname, projectId: PROJECT_ID, deploymentId: VERCEL_ID,
  deployment: { id: VERCEL_ID } };
const deployment = { id: VERCEL_ID, projectId: PROJECT_ID, readyState: 'READY', target: 'production',
  url: new URL(STAGED).hostname, meta: { githubCommitSha: REVISION } };
const known = async () => run;

function outputs() {
  const items = new Map();
  return { items, report: (key, pass) => { items.set(key, pass); return pass; } };
}

function mockHttp({ alias = assignment, metadata = deployment, status = { recentRuns: [run], email: { enabled: false } },
  oldChallenge = true, oldAuth = true } = {}) {
  const calls = [];
  const send = async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    calls.push(url);
    const headers = options.headers;
    if (url === VERCEL_ALIAS_LOOKUP || url === VERCEL_DEPLOYMENT_LOOKUP) {
      assert.deepEqual(headers, { Authorization: `Bearer ${post.VERCEL_PROMOTION_VERIFY_TOKEN}` });
      const result = url === VERCEL_ALIAS_LOOKUP ? alias : metadata;
      if (typeof result === 'number') return new Response(null, { status: result,
        headers: result === 302 ? { location: 'https://unapproved.invalid' } : {} });
      return Response.json(result);
    }
    const { origin, pathname } = new URL(url);
    assert.ok([LIVE, STAGED].includes(origin));
    assert.equal(headers['x-vercel-protection-bypass'], origin === STAGED ? pre.HOSTED_SMOKE_VERCEL_BYPASS : undefined);
    if (pathname === '/') {
      assert.equal(headers.Authorization, undefined);
      return new Response('<div id="root"></div>');
    }
    if (pathname === '/api/health' && !headers.Authorization) {
      return new Response(null, { status: 401, headers: oldChallenge || origin === STAGED ?
        { 'www-authenticate': 'Basic realm="DGCA Monitor", charset="UTF-8"' } : {} });
    }
    assert.equal(headers.Authorization, `Basic ${Buffer.from(`${pre.HOSTED_SMOKE_OPERATOR_USERNAME}:${pre.HOSTED_SMOKE_OPERATOR_PASSWORD}`).toString('base64')}`);
    if (pathname === '/api/health') return oldAuth || origin === STAGED ? Response.json({ status: 'ok' }) : new Response(null, { status: 401 });
    assert.equal(pathname, '/api/monitor/status');
    return Response.json(status);
  };
  return { calls, send };
}

test('requires exact mode-specific phrases, disabled flags and immutable deployment config', () => {
  assert.equal(approvedMode(pre), 'pre-promotion');
  assert.equal(approvedMode(post), 'post-promotion');
  for (const [key, value] of Object.entries({ DGCA_VERIFY_CONFIRMATION: post.DGCA_VERIFY_CONFIRMATION,
    DGCA_MONITOR_ENABLED: 'true', EMAIL_NOTIFICATIONS_ENABLED: 'False', HOSTED_SMOKE_URL: LIVE,
    HOSTED_SMOKE_TEST_RUN_ID: '26', NODE_TLS_REJECT_UNAUTHORIZED: '0' })) {
    assert.equal(approvedMode({ ...pre, [key]: value }), null, key);
  }
});

test('pre-promotion verifies old live HTTP separately and compares only the staged database and email', async () => {
  const { items, report } = outputs();
  const { calls, send } = mockHttp();
  await verify(pre, report, send, known);
  assert.deepEqual(calls, [`${LIVE}/`, `${LIVE}/api/health`, `${LIVE}/api/health`,
    `${STAGED}/`, `${STAGED}/api/health`, `${STAGED}/api/health`, `${STAGED}/api/monitor/status`]);
  assert.equal(items.size, 10);
  assert.ok([...items.values()].every(Boolean));
});

test('stops before further requests if the old operator challenge or authentication fails', async () => {
  for (const config of [{ oldChallenge: false }, { oldAuth: false }]) {
    const { items, report } = outputs();
    const { calls, send } = mockHttp(config);
    await verify(pre, report, send, async () => assert.fail('must not reach Neon'));
    assert.ok(calls.every(url => url.startsWith(`${LIVE}/`)));
    assert.equal([...items.values()].at(-1), false);
  }
});

test('reports a wrong staged record or enabled email as failures', async () => {
  const { items, report } = outputs();
  const { send } = mockHttp({ status: { recentRuns: [{ ...run, run_at: '2026-11-25 18:10:20' }], email: { enabled: true } } });
  await verify(pre, report, send, known);
  assert.equal(items.get('staged-deployment-test-record'), false);
  assert.equal(items.get('staged-effective-email-disabled'), false);
});

test('post-promotion checks assignment and metadata by ID before accessing the live site, without an alias array', async () => {
  const { items, report } = outputs();
  const { calls, send } = mockHttp();
  await verify(post, report, send, known);
  assert.deepEqual(calls, [VERCEL_ALIAS_LOOKUP, VERCEL_DEPLOYMENT_LOOKUP,
    `${LIVE}/`, `${LIVE}/api/health`, `${LIVE}/api/health`, `${LIVE}/api/monitor/status`]);
  assert.ok([...items.values()].every(Boolean));
});

test('missing, mismatched, unauthorized, or redirected alias evidence blocks all later requests', async () => {
  for (const [env, alias, expected] of [[{ ...post, VERCEL_PROMOTION_VERIFY_TOKEN: '' }, assignment, []],
    [post, { ...assignment, deploymentId: 'dpl_wrong', deployment: { id: 'dpl_wrong' } }, [VERCEL_ALIAS_LOOKUP]],
    [post, { ...assignment, deployment: { id: 'dpl_wrong' } }, [VERCEL_ALIAS_LOOKUP]],
    [post, { ...assignment, projectId: 'prj_wrong' }, [VERCEL_ALIAS_LOOKUP]],
    [post, {}, [VERCEL_ALIAS_LOOKUP]], [post, 401, [VERCEL_ALIAS_LOOKUP]], [post, 302, [VERCEL_ALIAS_LOOKUP]]]) {
    const { items, report } = outputs();
    const { calls, send } = mockHttp({ alias });
    await verify(env, report, send, async () => assert.fail('must not reach Neon'));
    assert.deepEqual(calls, expected);
    assert.equal(items.get('vercel-live-alias'), false);
  }
});

test('retry is limited to missing alias reads and the known rollback assignment', async () => {
  const previous = 'dpl_3XBf8V7i3ajWQfcXn82eMWeQPsbR';
  const old = { ...assignment, deploymentId: previous, deployment: { id: previous } };
  for (const [sequence, pass, expectedWaits] of [[[404, old, { ...assignment, deployment: undefined }], true, [2000, 2000]],
    [[old, old, old], false, [2000, 2000]], [[403], false, []], [[302], false, []],
    [[{ ...old, deployment: { id: VERCEL_ID } }], false, []]]) {
    const waits = [];
    let reads = 0;
    const send = async (url, options) => {
      assert.equal(url, VERCEL_ALIAS_LOOKUP);
      assert.equal(options.redirect, 'error');
      const value = sequence[reads++];
      return typeof value === 'number' ? new Response(null, { status: value }) : Response.json(value);
    };
    assert.equal(await verifyPromotedAlias(post.VERCEL_PROMOTION_VERIFY_TOKEN, send, async ms => waits.push(ms)), pass);
    assert.deepEqual(waits, expectedWaits);
    assert.equal(reads, sequence.length);
  }
});

test('deployment metadata is checked once and fails closed on missing, conflicting, redirected, or denied responses', async () => {
  const invalid = [404, 403, 302, { ...deployment, id: 'dpl_wrong' }, { ...deployment, projectId: 'prj_wrong' },
    { ...deployment, readyState: 'BUILDING' }, { ...deployment, target: 'preview' }, { ...deployment, url: 'wrong.vercel.app' },
    { ...deployment, meta: {} }, { ...deployment, gitSource: { sha: 'wrong-sha' } }];
  for (const metadata of invalid) {
    const { items, report } = outputs();
    const { calls, send } = mockHttp({ metadata });
    await verify(post, report, send, async () => assert.fail('must not reach Neon'));
    assert.deepEqual(calls, [VERCEL_ALIAS_LOOKUP, VERCEL_DEPLOYMENT_LOOKUP]);
    assert.equal(items.get('vercel-live-alias'), true);
    assert.equal(items.get('vercel-deployment-metadata'), false);
  }
});

test('verifies Neon TLS and checks the record and saved setting only inside a read-only transaction', async () => {
  const target = { databaseName: 'neondb', hostname: 'ep-test.example.neon.tech' };
  const calls = [];
  const client = { connect: async () => {}, connection: { stream: { authorized: true, encrypted: true,
    getPeerCertificate: () => ({ subjectaltname: `DNS:${target.hostname}` }) } }, async query(sql, params) {
    calls.push(sql);
    if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK') return {};
    assert.match(sql, /^SELECT\s/);
    if (sql.includes('pg_is_in_recovery')) return { rows: [{ db: 'neondb', read_only: 'on', replica: false }] };
    if (sql.includes('public.monitoring_logs')) {
      assert.deepEqual(params, [RUN_ID, RUN_AT]);
      return { rows: [{ ...run, id: '27', items_found: '40', items_new: '1', duration_ms: '25324' }] };
    }
    assert.match(sql, /FROM public.config/);
    return { rows: [{ value: 'false' }] };
  } };
  const { items, report } = outputs();
  assert.deepEqual(await readTestRecord(client, target, report), run);
  assert.equal(calls[0], 'BEGIN READ ONLY');
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok([...items.values()].every(Boolean));
  const length = calls.length;
  await assert.rejects(readTestRecord(client, { ...target, hostname: 'ep-other.example.neon.tech' }, report), /TLS/);
  assert.equal(calls.length, length);
});

test('workflow is manual with read-only permissions and does not pass Vercel management auth to pre-promotion', async () => {
  const yml = await readFile(new URL('../.github/workflows/dgca-hosted-promotion-verify.yml', import.meta.url), 'utf8');
  assert.match(yml, /on:\r?\n  workflow_dispatch:/);
  assert.doesNotMatch(yml, /^  (push|schedule|workflow_run|pull_request):/m);
  assert.match(yml, /permissions:\r?\n  contents: read/);
  assert.match(yml, /inputs.mode == 'post-promotion' && secrets.VERCEL_PROMOTION_VERIFY_TOKEN/);
  assert.doesNotMatch(yml, /EMAIL_APP_PASSWORD|run:.*\b(vercel|git push|gh)\b/);
});
