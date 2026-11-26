import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { ORIGIN as STAGED, REVISION, RUN_ID, RUN_AT, verifySocket } from './hosted-preflight.mjs';

export const LIVE = 'https://dgcamonitorindigo.vercel.app';
export const VERCEL_ID = 'dpl_2mbrh9ziDgj8TWoYoRKbcURe5TKS';
export const PROJECT_ID = 'prj_VgGmlwyx1g3XJbwPQ668D7c7q6Eq';
const VERCEL_API = 'https://api.vercel.com';
const TEAM_SCOPE = 'teamId=team_51PJEt40i5ajIYE1xqzR8FzQ';
const LIVE_DOMAIN = new URL(LIVE).hostname;
const ROLLBACK_ID = 'dpl_3XBf8V7i3ajWQfcXn82eMWeQPsbR';
export const VERCEL_ALIAS_LOOKUP = `${VERCEL_API}/v4/aliases/${LIVE_DOMAIN}?${TEAM_SCOPE}`;
export const VERCEL_DEPLOYMENT_LOOKUP = `${VERCEL_API}/v13/deployments/${VERCEL_ID}?${TEAM_SCOPE}`;
const PHRASES = new Map([
  ['pre-promotion', 'VERIFY BEFORE DGCA PROMOTION'],
  ['post-promotion', 'VERIFY AFTER DGCA PROMOTION']
]);
const RECORD_FIELDS = ['id', 'run_at', 'status', 'items_found', 'items_new', 'duration_ms'];

export function approvedMode(env) {
  const mode = env.DGCA_VERIFY_MODE;
  if (!PHRASES.has(mode) || env.DGCA_VERIFY_CONFIRMATION !== PHRASES.get(mode) ||
      env.DGCA_MONITOR_ENABLED !== 'false' || env.EMAIL_NOTIFICATIONS_ENABLED !== 'false' ||
      env.HOSTED_SMOKE_URL !== STAGED || env.HOSTED_SMOKE_TEST_RUN_ID !== String(RUN_ID) ||
      env.HOSTED_SMOKE_TEST_RUN_AT !== RUN_AT || !env.HOSTED_SMOKE_OPERATOR_USERNAME ||
      env.HOSTED_SMOKE_OPERATOR_USERNAME.includes(':') || !(env.HOSTED_SMOKE_OPERATOR_PASSWORD?.length >= 20) ||
      (mode === 'pre-promotion' && !env.HOSTED_SMOKE_VERCEL_BYPASS) || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    return null;
  }
  return mode;
}

function get(send, url, headers = {}, timeout = 20000) {
  return send(url, { method: 'GET', redirect: 'error', cache: 'no-store', headers, signal: AbortSignal.timeout(timeout) });
}

async function readVercel(token, endpoint, send) {
  const response = await get(send, endpoint, { Authorization: `Bearer ${token}` }, 6000);
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status };
  }
  return { status: response.status, body: await response.json() };
}

export async function verifyPromotedAlias(token, send = fetch, wait = sleep) {
  if (!token) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, body } = await readVercel(token, VERCEL_ALIAS_LOOKUP, send);
    if (status === 200) {
      if (body?.alias !== LIVE_DOMAIN || body.projectId !== PROJECT_ID || body.deletedAt != null ||
          body.redirect != null || body.redirectStatusCode != null ||
          (body.deployment?.id !== undefined && body.deployment.id !== body.deploymentId)) return false;
      if (body.deploymentId === VERCEL_ID) return true;
      if (body.deploymentId !== ROLLBACK_ID) return false;
    } else if (status !== 404) {
      return false;
    }
    // Only a missing alias or the known previous assignment can still be propagating.
    if (attempt < 2) await wait(2000);
  }
  return false;
}

async function verifyPromotedDeployment(token, send) {
  const { body: deployment } = await readVercel(token, VERCEL_DEPLOYMENT_LOOKUP, send);
  const sources = [deployment?.gitSource?.sha, deployment?.meta?.githubCommitSha, deployment?.meta?.gitCommitSha]
    .filter(sha => sha != null);
  return deployment?.id === VERCEL_ID && deployment.projectId === PROJECT_ID && deployment.readyState === 'READY' &&
    deployment.target === 'production' && deployment.url === new URL(STAGED).hostname &&
    sources.length > 0 && sources.every(sha => sha === REVISION);
}

async function readSite(origin, names, env, knownRun, report, send) {
  const bypass = origin === STAGED ? { 'x-vercel-protection-bypass': env.HOSTED_SMOKE_VERCEL_BYPASS } : {};
  const homepage = await get(send, `${origin}/`, bypass);
  const frontend = homepage.status === 200 && /<div id="root"/.test(await homepage.text());
  if (homepage.status !== 200) await homepage.body?.cancel();
  if (!report(`${names}-frontend`, frontend)) return false;
  const challenge = await get(send, `${origin}/api/health`, bypass);
  const gate = challenge.status === 401 && /^Basic realm="DGCA Monitor"(?:,|$)/i.test(challenge.headers.get('www-authenticate') || '');
  await challenge.body?.cancel();
  if (!report(`${names}-operator-gate`, gate)) return false;
  const encoded = Buffer.from(`${env.HOSTED_SMOKE_OPERATOR_USERNAME}:${env.HOSTED_SMOKE_OPERATOR_PASSWORD}`, 'utf8').toString('base64');
  const headers = { ...bypass, Authorization: `Basic ${encoded}` };
  const health = await get(send, `${origin}/api/health`, headers);
  const healthy = health.status === 200 && (await health.json())?.status === 'ok';
  if (health.status !== 200) await health.body?.cancel();
  if (!report(`${names}-authenticated-health`, healthy)) return false;
  if (!knownRun) return true;
  const response = await get(send, `${origin}/api/monitor/status`, headers);
  if (response.status !== 200) {
    await response.body?.cancel();
    report(`${names}-monitor-status`, false);
    return false;
  }
  report(`${names}-monitor-status`, true);
  const status = await response.json();
  report(`${names}-deployment-test-record`, Array.isArray(status?.recentRuns) &&
    status.recentRuns.some(run => run && RECORD_FIELDS.every(field => run[field] === knownRun[field])));
  report(`${names}-effective-email-disabled`, status?.email?.enabled === false);
  return true;
}

export async function readTestRecord(client, target, report) {
  await client.connect();
  if (!verifySocket(client.connection?.stream, target.hostname)) throw new Error('TLS');
  await client.query('BEGIN READ ONLY');
  try {
    const { rows: [identity] } = await client.query(`SELECT current_database() AS db,
      current_setting('transaction_read_only') AS read_only, pg_is_in_recovery() AS replica`);
    if (!report('direct-deployment-test-tls-and-read-only', identity?.db === target.databaseName &&
      identity.read_only === 'on' && identity.replica === false)) return null;
    const { rows: [row] } = await client.query(`SELECT id, run_at, status, items_found, items_new, duration_ms
      FROM public.monitoring_logs WHERE id = $1 AND run_at = $2 AND status = 'success'`, [RUN_ID, RUN_AT]);
    if (!report('direct-monitoring-record', Boolean(row && Number(row.id) === RUN_ID && row.run_at === RUN_AT &&
      row.status === 'success' && RECORD_FIELDS.every(field => row[field] != null)), { id: RUN_ID, runAtUtc: RUN_AT })) return null;
    const { rows: [saved] } = await client.query("SELECT value FROM public.config WHERE key = 'emailEnabled'");
    if (!report('direct-saved-email-override-safe', !saved || saved.value?.trim() === 'false', { overridePresent: Boolean(saved) })) return null;
    return { ...row, id: Number(row.id), items_found: Number(row.items_found), items_new: Number(row.items_new), duration_ms: Number(row.duration_ms) };
  } finally {
    await client.query('ROLLBACK');
  }
}

async function readDeploymentTest(env, report) {
  const app = resolve('pinned-app');
  const git = (...args) => execFileSync('git', ['-C', app, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!report('pinned-dependency-checkout', git('rev-parse', 'HEAD') === REVISION && !git('status', '--porcelain', '--untracked-files=no'))) return null;
  const backend = resolve(app, 'backend/node_api');
  const { smokeDatabaseTarget } = await import(pathToFileURL(resolve(backend, 'src/config/smoke-database-target.js')).href);
  const target = smokeDatabaseTarget(env);
  if (target.databaseName !== 'neondb') throw new Error('database');
  const url = new URL(target.connectionString);
  const { Client } = createRequire(resolve(backend, 'package.json'))('pg');
  const client = new Client({ host: target.hostname, port: 5432, database: target.databaseName,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true, servername: target.hostname }, enableChannelBinding: true,
    connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 12000,
    options: '-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=30000' });
  client.on('error', () => report('direct-database-connection', false));
  try { return await readTestRecord(client, target, report); } finally { await client.end(); }
}

export async function verify(env, report, send = fetch, readDirect = readDeploymentTest) {
  const mode = approvedMode(env);
  if (!report('approved-mode-and-disabled-flags', Boolean(mode))) return;
  let stage = 'vercel-live-alias';
  try {
    if (mode === 'post-promotion') {
      if (!env.VERCEL_PROMOTION_VERIFY_TOKEN) {
        report(stage, false, { reason: 'read-only Vercel API credential missing' });
        return;
      }
      if (!report(stage, await verifyPromotedAlias(env.VERCEL_PROMOTION_VERIFY_TOKEN, send))) return;
      stage = 'vercel-deployment-metadata';
      if (!report(stage, await verifyPromotedDeployment(env.VERCEL_PROMOTION_VERIFY_TOKEN, send))) return;
    }
    if (mode === 'pre-promotion') {
      stage = 'previous-live-http';
      if (!await readSite(LIVE, 'previous-live', env, null, report, send)) return;
    }
    stage = 'direct-deployment-test';
    const knownRun = await readDirect(env, report);
    if (!knownRun) return;
    const checkingStaged = mode === 'pre-promotion';
    const label = checkingStaged ? 'staged' : 'promoted-live';
    stage = `${label}-http`;
    await readSite(checkingStaged ? STAGED : LIVE, label, env, knownRun, report, send);
  } catch {
    report(stage, false);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let failed = false;
  await verify(process.env, (check, pass, details = {}) => {
    failed ||= !pass;
    console.log(JSON.stringify({ check, outcome: pass ? 'PASS' : 'FAIL', ...details }));
    return pass;
  });
  process.exitCode = failed ? 1 : 0;
}
