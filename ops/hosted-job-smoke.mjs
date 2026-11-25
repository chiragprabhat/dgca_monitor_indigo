import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REVISION = '88d059b531993cd34e05bbf90339faf235c4b356';
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FULL_PDF_BYTES = 40 * 1024 ** 2;
const CHUNK_BYTES = 3 * 1024 ** 2;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function parseGeneratedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_VERCEL_ORIGIN'); }
  const generatedHost = /^[a-z0-9-]+-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/;
  if (url.protocol !== 'https:' || !generatedHost.test(url.hostname) || url.hostname.includes('-git-') || url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('INVALID_VERCEL_ORIGIN');
  return url.origin;
}

export function hostedOrigin(configured, confirmed) {
  const origin = parseGeneratedOrigin(configured);
  if (origin !== parseGeneratedOrigin(confirmed)) fail('VERCEL_ORIGIN_NOT_APPROVED');
  return origin;
}

export function approvedRun(env) {
  if (env.DGCA_MONITOR_ENABLED !== 'false' || env.EMAIL_NOTIFICATIONS_ENABLED !== 'false' ||
      env.HOSTED_SMOKE_CONFIRMATION !== 'RUN HOSTED SYNTHETIC TEST') fail('HOSTED_TEST_DISABLED');
  return hostedOrigin(env.HOSTED_SMOKE_URL, env.HOSTED_SMOKE_CONFIRMED_URL);
}

export function hostedRequest(origin, auth, protection, send = fetch) {
  const budget = AbortSignal.timeout(180000);
  return (path, { authenticated = true, headers, ...options } = {}) => {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path)) fail('HOSTED_REQUEST_PATH_INVALID');
    return send(`${origin}/api${path}`, {
      ...options, redirect: 'error', signal: AbortSignal.any([budget, AbortSignal.timeout(25000)]),
      headers: { ...(protection ? { 'x-vercel-protection-bypass': protection } : {}),
        ...(authenticated ? { Authorization: auth } : {}), ...headers }
    });
  };
}

export async function requireHostedTestBranch(get, knownRun) {
  const keys = ['id', 'run_at', 'status', 'items_found', 'items_new', 'duration_ms'];
  if (!knownRun || knownRun.status !== 'success' || keys.some(key => knownRun[key] == null)) fail('TEST_BRANCH_LOG_MISSING');
  const response = await get('/monitor/status');
  if (response.status !== 200) fail('VERCEL_READONLY_BRANCH_CHECK_FAILED');
  const data = await response.json();
  if (data.email?.enabled !== false) fail('HOSTED_EMAIL_ENABLED');
  if (!Array.isArray(data.recentRuns) ||
      !data.recentRuns.some(run => run && keys.every(key => run[key] === knownRun[key]))) fail('VERCEL_READONLY_BRANCH_CHECK_FAILED');
}

export async function requireBranchCanary(get, id, nonce) {
  const response = await get(`/jobs/${id}`);
  const expected = { state: 'done', status: 200, chunk: JSON.stringify({ nonce }), next: null };
  if (response.status !== 200 || !isDeepStrictEqual(await response.json(), expected)) fail('VERCEL_TEST_BRANCH_UNCONFIRMED');
}

export async function runOwnedJob(ops, id, kind, input) {
  if (!UUID.test(id) || !['upload', 'compare'].includes(kind)) fail('JOB_NOT_OWNED');
  ops.assertHeld();
  const row = await ops.lookup(id);
  if (row?.state !== 'queued' || row.kind !== kind || !isDeepStrictEqual(row.input, input)) fail('JOB_NOT_OWNED');
  ops.recordOwned?.(id, kind, input);
  const claimed = await ops.claim(id, kind, input);
  if (!claimed || claimed.id !== id || claimed.kind !== kind || !isDeepStrictEqual(claimed.input, input)) fail('JOB_CLAIM_MISMATCH');
  ops.assertHeld();
  await ops.process(claimed, ops.assertHeld);
}

export async function claimOwnedJob(db, id, kind, input) {
  return db.prepare(`
    UPDATE dgca_jobs SET state = 'running' WHERE id = (
      SELECT id FROM dgca_jobs
      WHERE id = $1 AND kind = $2 AND input = $3::jsonb AND state = 'queued'
      FOR UPDATE SKIP LOCKED
    ) RETURNING id, kind, input
  `).get(id, kind, JSON.stringify(input));
}

export async function cleanupOwnedFixtures(db, documents, jobs, canary, nonce) {
  for (const doc of documents) {
    const sessions = await db.prepare('DELETE FROM dgca_upload_sessions WHERE filename = $1 AND bytes = $2 RETURNING id, job_id')
      .all(doc.filename, doc.bytes.length);
    for (const { id, job_id } of sessions) if (job_id) jobs.set(job_id, { kind: 'upload', input: { id } });
    await db.query('DELETE FROM uploaded_documents WHERE filename = $1 AND content_hash = $2', [doc.filename, doc.hash]);
  }
  for (const [id, { kind, input }] of jobs) {
    await db.query('DELETE FROM dgca_jobs WHERE id = $1 AND kind = $2 AND input = $3::jsonb', [id, kind, JSON.stringify(input)]);
  }
  await db.query("DELETE FROM dgca_jobs WHERE id = $1 AND kind = 'hosted-smoke-canary' AND result = $2", [canary, JSON.stringify({ nonce })]);
}

export function fixturePdf(label, size) {
  const stream = `BT /F1 9 Tf 20 70 Td (${label}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let contents = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = contents.length;
    contents += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const index = 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n';
  const offset = size ? size - index.length - 17 : contents.length;
  const end = String(offset).padStart(10, '0') + '\n%%EOF\n';
  return Buffer.concat([Buffer.from(contents), Buffer.alloc(offset - contents.length, 32), Buffer.from(index + end)]);
}

export async function readResult(request, id, expectedStatus) {
  let offset = 0;
  let chunks = '';
  for (let i = 0; i < 8; i++) {
    const response = await request(`/jobs/${id}?offset=${offset}`);
    if (response.status !== 200) fail('HOSTED_RESULT_HTTP_ERROR');
    const data = await response.json();
    if (data.state !== 'done' || data.status !== expectedStatus || typeof data.chunk !== 'string') fail('HOSTED_JOB_NOT_DONE');
    chunks += data.chunk;
    if (data.next === null) return JSON.parse(chunks);
    if (!Number.isInteger(data.next) || data.next <= offset) fail('HOSTED_RESULT_CURSOR_INVALID');
    offset = data.next;
  }
  fail('HOSTED_RESULT_TOO_LARGE');
}

async function hostedCheck(env) {
  const origin = approvedRun(env);
  const runId = env.HOSTED_SMOKE_TEST_RUN_ID;
  const runAt = env.HOSTED_SMOKE_TEST_RUN_AT;
  if (!/^[1-9][0-9]{0,15}$/.test(runId || '') || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(runAt || '')) {
    fail('TEST_BRANCH_LOG_MISSING');
  }
  const username = env.HOSTED_SMOKE_OPERATOR_USERNAME;
  const password = env.HOSTED_SMOKE_OPERATOR_PASSWORD;
  if (!username || username.includes(':') || !password || password.length < 20) fail('OPERATOR_AUTH_MISSING');
  const appRoot = resolve(env.HOSTED_SMOKE_APP_ROOT || 'pinned-app');
  const git = (...args) => execFileSync('git', ['-C', appRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', 'HEAD') !== REVISION || git('status', '--porcelain', '--untracked-files=no')) fail('PINNED_CHECKOUT_MISMATCH');
  const source = name => import(pathToFileURL(resolve(appRoot, 'backend/node_api/src', name)).href);
  const { smokeDatabaseTarget } = await source('config/smoke-database-target.js');
  const target = smokeDatabaseTarget(env);
  const { runInMonitoringSmokeTest } = await source('config/monitoring-smoke-context.js');
  const { acquireMonitoringLock, closeDatabase, getDatabase, transaction, verifyMonitoringSmokeConnection } =
    await source('config/database.js');
  const { processActionsJob } = await source('services/actions-worker.js');
  const { isEmailEnabled } = await source('services/notification-service.js');
  const { getSummaryProvider } = await source('services/summary-service.js');
  const canary = randomUUID();
  const nonce = randomUUID();
  const documents = ['a', 'b'].map((suffix, index) => {
    const filename = `hosted-smoke-${nonce}-${suffix}.pdf`;
    const bytes = fixturePdf(`Synthetic hosted smoke fixture ${nonce}. Variant ${suffix} is generated for testing only.`, index ? undefined : FULL_PDF_BYTES);
    return { filename, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  });
  const protection = env.HOSTED_SMOKE_VERCEL_BYPASS;
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const request = hostedRequest(origin, auth, protection);
  const json = (path, body) => request(path, { method: 'POST',
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {})
  });

  return runInMonitoringSmokeTest(target, async () => {
    let lock;
    try {
      await verifyMonitoringSmokeConnection();
      if (await isEmailEnabled() || await getSummaryProvider() !== 'basic') fail('SMOKE_SETTINGS_NOT_ISOLATED');
      lock = await acquireMonitoringLock(5);
      if (!lock) fail('WORKER_ALREADY_RUNNING');
      const db = getDatabase();
      const emailSetting = await db.prepare("SELECT value FROM config WHERE key = 'emailEnabled'").get();
      if (emailSetting && JSON.parse(emailSetting.value) !== false) fail('SAVED_EMAIL_ENABLED');
      if ((await request('/monitor/status', { authenticated: false })).status !== 401) fail('OPERATOR_GATE_UNCONFIRMED');
      const knownRun = await db.prepare(`SELECT id, run_at, status, items_found, items_new, duration_ms FROM monitoring_logs
        WHERE id = $1 AND run_at = $2 AND status = 'success'`).get(runId, runAt);
      await requireHostedTestBranch(request, knownRun);
      const jobs = new Map();
      const filenames = documents.map(doc => doc.filename);
      console.log(JSON.stringify({ stage: 'synthetic-fixture-ids', fixture: nonce, canary,
        documents: documents.map(doc => ({ filename: doc.filename, bytes: doc.bytes.length, hash: doc.hash })) }));
      try {
        await db.query(`
          INSERT INTO dgca_jobs (id, kind, scope, input, state, finished_at, status, result)
          VALUES ($1::uuid, 'hosted-smoke-canary', ($1::uuid)::text, '{}'::jsonb, 'done', now(), 200, $2)
        `, [canary, JSON.stringify({ nonce })]);
        await requireBranchCanary(request, canary, nonce);
        const risk = await db.prepare(`
          SELECT EXISTS (SELECT 1 FROM dgca_upload_sessions
            WHERE job_id IS NULL AND expires_at <= now() + interval '5 minutes') AS expired_or_expiring,
            COALESCE((SELECT sum(bytes) FROM dgca_upload_sessions), 0) AS reserved
        `).get();
        if (risk.expired_or_expiring || Number(risk.reserved) + FULL_PDF_BYTES > 3 * FULL_PDF_BYTES) {
          fail('EXISTING_UPLOAD_SESSIONS_BLOCK_TEST');
        }
        const ops = {
          lookup: id => db.prepare('SELECT kind, state, input FROM dgca_jobs WHERE id = $1').get(id),
          claim: (id, kind, input) => claimOwnedJob(db, id, kind, input),
          process: processActionsJob, assertHeld: lock.assertHeld,
          recordOwned: (id, kind, input) => {
            jobs.set(id, { kind, input });
            console.log(JSON.stringify({ stage: 'synthetic-job-owned', fixture: nonce, id, kind, input }));
          }
        };
        for (const doc of documents) {
          await requireBranchCanary(request, canary, nonce);
          const opened = await json('/compare/upload-sessions', { name: doc.filename, bytes: doc.bytes.length });
          if (opened.status !== 201) fail('HOSTED_UPLOAD_OPEN_FAILED');
          const { id, chunkBytes } = await opened.json();
          if (!UUID.test(id) || chunkBytes !== CHUNK_BYTES) fail('HOSTED_CHUNK_PROTOCOL_MISMATCH');
          const session = await db.prepare('SELECT filename, bytes, job_id FROM dgca_upload_sessions WHERE id = $1').get(id);
          if (session?.filename !== doc.filename || session.bytes !== doc.bytes.length || session.job_id !== null) {
            fail('UPLOAD_SESSION_NOT_OWNED');
          }
          for (let offset = 0, part = 0; offset < doc.bytes.length; offset += chunkBytes, part++) {
            const response = await request(`/compare/upload-sessions/${id}/${part}`, {
              method: 'PUT', body: doc.bytes.subarray(offset, offset + chunkBytes),
              headers: { 'Content-Type': 'application/octet-stream' }
            });
            if (response.status !== 204) fail('HOSTED_CHUNK_WRITE_FAILED');
          }
          const queued = await json(`/compare/upload-sessions/${id}/finish`);
          if (queued.status !== 202) fail('HOSTED_UPLOAD_QUEUE_FAILED');
          const { jobId } = await queued.json();
          const joined = await db.prepare('SELECT job_id FROM dgca_upload_sessions WHERE id = $1 AND filename = $2').get(id, doc.filename);
          if (!UUID.test(jobId) || joined?.job_id !== jobId) fail('UPLOAD_JOB_NOT_OWNED');
          await runOwnedJob(ops, jobId, 'upload', { id });
          const result = await readResult(request, jobId, 201);
          if (result.filename !== doc.filename || result.sizeBytes !== doc.bytes.length || result.pages !== 1 ||
              result.hasText !== true || result.duplicate || !result.id?.startsWith('upload:') ||
              !UUID.test(result.id.slice(7))) fail('HOSTED_UPLOAD_RESULT_MISMATCH');
          doc.uploadId = result.id;
          const expected = await db.prepare(`SELECT 1 FROM uploaded_documents
            WHERE id = $1 AND filename = $2 AND content_hash = $3
              AND NOT EXISTS (SELECT 1 FROM dgca_upload_sessions WHERE id = $4)
              AND NOT EXISTS (SELECT 1 FROM dgca_upload_chunks WHERE upload_id = $4)`)
            .get(doc.uploadId.slice(7), doc.filename, doc.hash, id);
          if (!expected) fail('UPLOAD_OR_CLEANUP_UNCONFIRMED');
          console.log(JSON.stringify({ stage: 'synthetic-upload-verified', fixture: nonce, uploadId: doc.uploadId,
            hash: doc.hash }));
        }
        await requireBranchCanary(request, canary, nonce);
        const compareInput = { a: documents[0].uploadId, b: documents[1].uploadId };
        console.log(JSON.stringify({ stage: 'synthetic-comparison-input', fixture: nonce, input: compareInput }));
        const queued = await request(`/compare?${new URLSearchParams(compareInput)}`);
        if (queued.status !== 202) fail('HOSTED_COMPARE_QUEUE_FAILED');
        const { jobId } = await queued.json();
        await runOwnedJob(ops, jobId, 'compare', compareInput);
        const compared = await readResult(request, jobId, 200);
        if (!compared.left?.label?.includes(filenames[0]) || !compared.right?.label?.includes(filenames[1]) ||
            !compared.chunks?.length) fail('HOSTED_COMPARE_RESULT_MISMATCH');
      } finally {
        lock.assertHeld();
        await transaction(cleanup => cleanupOwnedFixtures(cleanup, documents, jobs, canary, nonce));
      }
      return { outcome: 'hosted-jobs-verified', revision: REVISION, fullUploadBytes: FULL_PDF_BYTES,
        fullUploadChunks: 14, syntheticJobsProcessed: 3, fixturesCleaned: true };
    } finally {
      try { await lock?.release(); } finally { await closeDatabase(); }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await hostedCheck(process.env)));
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{3,42}$/.test(error.code) ? error.code : 'HOSTED_SMOKE_FAILED';
    console.error(JSON.stringify({ outcome: 'failed', code }));
    process.exitCode = 1;
  }
}
