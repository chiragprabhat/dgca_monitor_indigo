import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { approvedRun, claimOwnedJob, cleanupOwnedFixtures, fixturePdf, hostedOrigin, hostedRequest, readResult, requireBranchCanary,
  requireHostedTestBranch, runOwnedJob } from './hosted-job-smoke.mjs';

const id = '0c0aa49f-0571-4b23-ac34-c6bf92023c9f';
const other = 'c76f9969-baae-4f46-ba72-378802bd838e';
const origin = 'https://fixture-a12b34c56-owner.vercel.app';

test('hosted requests require a bare HTTPS Vercel deployment origin', () => {
  assert.equal(hostedOrigin(`${origin}/`, origin), origin);
  for (const url of [origin.replace('https:', 'http:'), `${origin}.evil.test`, `${origin}/other`,
    origin.replace('https://', 'https://user@'), `${origin}?q=secret`, 'not-a-url',
    'https://fixture.vercel.app', 'https://fixture-git-main-owner.vercel.app']) {
    assert.throws(() => hostedOrigin(url, origin), { code: 'INVALID_VERCEL_ORIGIN' });
  }
  assert.throws(() => hostedOrigin(origin, 'https://fixture-a12b34c57-owner.vercel.app'), { code: 'VERCEL_ORIGIN_NOT_APPROVED' });
});

test('the hosted endpoint must return the matching test-branch nonce', async () => {
  const done = { state: 'done', status: 200, next: null, chunk: JSON.stringify({ nonce: other }) };
  await requireBranchCanary(async path => {
    assert.equal(path, `/jobs/${id}`);
    return Response.json(done);
  }, id, other);
  for (const response of [Response.json(done, { status: 404 }), Response.json({ ...done, chunk: '{}' })]) {
    await assert.rejects(requireBranchCanary(async () => response, id, other), { code: 'VERCEL_TEST_BRANCH_UNCONFIRMED' });
  }
});

test('only an exact job ID, kind and fixture payload can reach worker processing', async () => {
  const input = { id: other };
  const row = { id, kind: 'upload', state: 'queued', input };
  const calls = [];
  const ops = {
    assertHeld: () => {},
    lookup: async lookupId => { calls.push(['lookup', lookupId]); return row; },
    claim: async (claimId, kind, payload) => { calls.push(['claim', claimId, kind, payload]); return row; },
    process: async job => { calls.push(['process', job.id]); }
  };
  await runOwnedJob(ops, id, 'upload', input);
  assert.deepEqual(calls, [['lookup', id], ['claim', id, 'upload', input], ['process', id]]);
  calls.length = 0;
  await assert.rejects(runOwnedJob(ops, id, 'test-email', input), { code: 'JOB_NOT_OWNED' });
  await assert.rejects(runOwnedJob(ops, id, 'upload', { id }), { code: 'JOB_NOT_OWNED' });
  assert.deepEqual(calls, [['lookup', id]]);
  calls.length = 0;
  await assert.rejects(runOwnedJob({ ...ops, claim: async () => ({ ...row, id: other }) }, id, 'upload', input),
    { code: 'JOB_CLAIM_MISMATCH' });
  assert.deepEqual(calls, [['lookup', id]]);
});

test('the prepared GitHub workflow is dispatch-only and checks out the Vercel revision separately', async () => {
  const yaml = await readFile(new URL('../.github/workflows/dgca-hosted-job-smoke.yml', import.meta.url), 'utf8');
  assert.match(yaml, /^on:\s*\r?\n  workflow_dispatch:/m);
  assert.doesNotMatch(yaml, /^  (push|schedule|pull_request):/m);
  assert.match(yaml, /ref: 88d059b531993cd34e05bbf90339faf235c4b356/);
  assert.match(yaml, /vars\.DGCA_MONITOR_ENABLED == 'false'/);
  assert.match(yaml, /vars\.EMAIL_NOTIFICATIONS_ENABLED == 'false'/);
  assert.match(yaml, /inputs\.confirmation == 'RUN HOSTED SYNTHETIC TEST'/);
  assert.match(yaml, /timeout-minutes: 5/);
  assert.doesNotMatch(yaml, /SMTP_|EMAIL_APP_PASSWORD|worker:actions/);
});

test('approval requires the exact phrase and both false flags', () => {
  const env = {
    DGCA_MONITOR_ENABLED: 'false', EMAIL_NOTIFICATIONS_ENABLED: 'false',
    HOSTED_SMOKE_CONFIRMATION: 'RUN HOSTED SYNTHETIC TEST', HOSTED_SMOKE_URL: origin,
    HOSTED_SMOKE_CONFIRMED_URL: origin
  };
  assert.equal(approvedRun(env), origin);
  for (const patch of [{ DGCA_MONITOR_ENABLED: 'true' }, { EMAIL_NOTIFICATIONS_ENABLED: 'true' },
    { EMAIL_NOTIFICATIONS_ENABLED: undefined }, { HOSTED_SMOKE_CONFIRMATION: 'run hosted synthetic test' }]) {
    assert.throws(() => approvedRun({ ...env, ...patch }), { code: 'HOSTED_TEST_DISABLED' });
  }
});

test('HTTP stays on the approved origin, rejects redirects and suppresses operator auth for the challenge', async () => {
  const sent = [];
  const request = hostedRequest(origin, 'Basic fixture', 'fixture-bypass', async (url, options) => {
    sent.push({ url, options });
    return Response.json({});
  });
  await request('/monitor/status', { authenticated: false, redirect: 'follow' });
  await request('/jobs/fixture');
  assert.ok(sent.every(x => new URL(x.url).origin === origin && x.options.redirect === 'error' && x.options.signal));
  assert.equal(sent[0].options.headers.Authorization, undefined);
  assert.equal(sent[1].options.headers.Authorization, 'Basic fixture');
  assert.throws(() => request('//different.vercel.app/'), { code: 'HOSTED_REQUEST_PATH_INVALID' });
});

test('read-only branch proof rejects a different run or enabled hosted email', async () => {
  const run = { id: 27, run_at: '2026-11-25 10:00:00', status: 'success',
    items_found: 40, items_new: 1, duration_ms: 25324 };
  await requireHostedTestBranch(async path => {
    assert.equal(path, '/monitor/status');
    return Response.json({ recentRuns: [run], email: { enabled: false } });
  }, run);
  await assert.rejects(requireHostedTestBranch(async () => Response.json({
    recentRuns: [{ ...run, run_at: '2026-11-25 10:00:01' }], email: { enabled: false }
  }), run), { code: 'VERCEL_READONLY_BRANCH_CHECK_FAILED' });
  await assert.rejects(requireHostedTestBranch(async () => Response.json({
    recentRuns: [run], email: { enabled: true }
  }), run), { code: 'HOSTED_EMAIL_ENABLED' });
  await assert.rejects(requireHostedTestBranch(async () => assert.fail('No HTTP without verified log'), undefined),
    { code: 'TEST_BRANCH_LOG_MISSING' });
});

test('cleanup uses exact synthetic document names and hashes and deletes only identified job rows', async () => {
  const filename = 'hosted-smoke-fixture-a.pdf';
  const comparison = { a: `upload:${id}`, b: `upload:${other}` };
  const compareJob = '427078c7-0b99-4c2d-b3d7-f1019aebcf3f';
  const canary = '36aef249-d8d6-4fa7-95a1-0ba03cd58bf4';
  const calls = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /DELETE FROM dgca_upload_sessions WHERE filename = \$1 AND bytes = \$2/);
      return { async all(...params) {
        assert.deepEqual(params, [filename, 16]);
        return [{ id, job_id: other }];
      } };
    },
    async query(sql, params) { calls.push([sql, params]); }
  };
  await cleanupOwnedFixtures(db, [{ filename, bytes: Buffer.alloc(16), hash: 'fixture-hash' }],
    new Map([[compareJob, { kind: 'compare', input: comparison }]]), canary, 'fixture-nonce');
  assert.deepEqual(calls.map(([, params]) => params), [
    [filename, 'fixture-hash'],
    [compareJob, 'compare', JSON.stringify(comparison)],
    [other, 'upload', JSON.stringify({ id })],
    [canary, JSON.stringify({ nonce: 'fixture-nonce' })]
  ]);
  assert.match(calls[1][0], /WHERE id = \$1 AND kind = \$2 AND input = \$3::jsonb/);
  assert.match(calls.at(-1)[0], /WHERE id = \$1.*AND result = \$2/);
});

test('the generated full upload is exactly 40 MiB with a valid cross-reference offset', () => {
  const label = 'Synthetic fixture for hosted verification.';
  for (const size of [undefined, 40 * 1024 ** 2]) {
    const pdf = fixturePdf(label, size);
    if (size) assert.equal(pdf.length, size);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.includes(label));
    const [, offset] = /startxref\n(\d+)\n%%EOF\n$/.exec(pdf.subarray(-70).toString());
    assert.equal(pdf.subarray(Number(offset), Number(offset) + 4).toString(), 'xref');
  }
});

test('hosted result polling reconstructs only a successfully completed job', async () => {
  const calls = [];
  const result = await readResult(async path => {
    calls.push(path);
    return Response.json(calls.length === 1
      ? { state: 'done', status: 200, chunk: '{"fixture":', next: 11 }
      : { state: 'done', status: 200, chunk: 'true}', next: null });
  }, id, 200);
  assert.deepEqual(result, { fixture: true });
  assert.deepEqual(calls, [`/jobs/${id}?offset=0`, `/jobs/${id}?offset=11`]);
  await assert.rejects(readResult(async () => Response.json({ state: 'queued' }), id, 200), { code: 'HOSTED_JOB_NOT_DONE' });
});

test('disposable PostgreSQL isolates exact claims and fixture cleanup from existing jobs', {
  skip: !process.env.TEST_DATABASE_URL
}, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const { Client } = createRequire(import.meta.url)('../backend/node_api/node_modules/pg');
  const client = new Client(url.href);
  await client.connect();
  try {
    const schema = `hosted_verify_${randomUUID().replaceAll('-', '')}`;
    await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, pg_catalog`);
    const appSchema = await readFile(new URL('../backend/node_api/src/config/schema.sql', import.meta.url), 'utf8');
    const cutoff = appSchema.indexOf('CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;');
    assert.ok(cutoff > 0);
    await client.query(appSchema.slice(0, cutoff));
    await client.query(await readFile(new URL('../backend/node_api/src/config/deployment.sql', import.meta.url), 'utf8'));
    const canary = randomUUID();
    const nonce = randomUUID();
    const compare = { a: `upload:${id}`, b: `upload:${other}` };
    await client.query(`INSERT INTO dgca_jobs(id,kind,scope,input)
      VALUES ($1,'compare','synthetic',$2),($3,'test-email','unrelated','{}')`, [id, JSON.stringify(compare), other]);
    await client.query(`INSERT INTO dgca_jobs(id,kind,scope,input,state,status,result)
      VALUES ($1::uuid,'hosted-smoke-canary',($1::uuid)::text,'{}','done',200,$2)`, [canary, JSON.stringify({ nonce })]);
    const db = {
      query: (...args) => client.query(...args),
      prepare: sql => ({
        get: async (...args) => (await client.query(sql, args)).rows[0],
        all: async (...args) => (await client.query(sql, args)).rows
      })
    };
    assert.equal(await claimOwnedJob(db, other, 'compare', compare), undefined);
    assert.equal(await claimOwnedJob(db, id, 'compare', { ...compare, url: 'wrong' }), undefined);
    assert.equal((await claimOwnedJob(db, id, 'compare', compare)).id, id);
    assert.equal(await claimOwnedJob(db, id, 'compare', compare), undefined);
    const filename = `hosted-smoke-${nonce}-a.pdf`;
    const session = randomUUID();
    await client.query('INSERT INTO dgca_upload_sessions(id,filename,bytes,expires_at) VALUES ($1,$2,3,now())', [session, filename]);
    await client.query('INSERT INTO dgca_upload_chunks(upload_id,part,data) VALUES ($1,0,$2)', [session, Buffer.from('pdf')]);
    await client.query('INSERT INTO uploaded_documents(id,filename,content_hash) VALUES ($1,$2,$3)', [randomUUID(), filename, 'owned-hash']);
    await cleanupOwnedFixtures(db, [{ filename, bytes: Buffer.alloc(3), hash: 'owned-hash' }],
      new Map([[id, { kind: 'compare', input: compare }]]), canary, nonce);
    assert.deepEqual((await client.query('SELECT id, state FROM dgca_jobs')).rows, [{ id: other, state: 'queued' }]);
    for (const table of ['dgca_upload_sessions', 'dgca_upload_chunks', 'uploaded_documents']) {
      assert.equal((await client.query(`SELECT 1 FROM ${table}`)).rowCount, 0);
    }
  } finally {
    try { await client.query('ROLLBACK'); } finally { await client.end(); }
  }
});
