import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { REVISION, verifySocket } from './hosted-preflight.mjs';

const PROJECT = 'tiny-sea-21255890';
const BRANCH = 'br-gentle-bread-beix3pqb';
const ROLE = 'neondb_owner';
const LIVE = 'dgcamonitorindigo.vercel.app';
const ROLLBACK = 'dpl_2mbrh9ziDgj8TWoYoRKbcURe5TKS';
const VERCEL_PROJECT = 'prj_VgGmlwyx1g3XJbwPQ668D7c7q6Eq';
const TEAM_SCOPE = '?teamId=team_51PJEt40i5ajIYE1xqzR8FzQ';
const PHRASES = { worker: 'VERIFY DGCA PRODUCTION WORKER', staged: 'VERIFY DGCA PRODUCTION STAGE', live: 'VERIFY DGCA PRODUCTION LIVE' };
const EXPECTED = { car_changes: 0, car_documents: 33, car_history: 0, config: 2, dgca_jobs: 0, dgca_upload_chunks: 0,
  dgca_upload_sessions: 0, monitoring_logs: 26, notifications: 3, publications: 0, review_log: 0,
  settings_log: 3, updates: 40, uploaded_documents: 0 };
const UPDATE_FIELDS = ['id', 'title', 'section', 'publication_date', 'detected_at'];
const RUN_FIELDS = ['id', 'run_at', 'status', 'items_found', 'items_new', 'duration_ms'];

export function approvedMode(env) {
  const mode = env.CUTOVER_VERIFY_MODE;
  if (!Object.hasOwn(PHRASES, mode) || env.CUTOVER_VERIFY_CONFIRMATION !== PHRASES[mode] ||
      env.DGCA_MONITOR_ENABLED !== 'false' || env.EMAIL_NOTIFICATIONS_ENABLED !== 'false' ||
      env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return null;
  if (mode === 'worker') return mode;
  return /^dpl_[A-Za-z0-9]+$/.test(env.CUTOVER_DEPLOYMENT_ID || '') && env.CUTOVER_DEPLOYMENT_ID !== ROLLBACK &&
    env.VERCEL_PROMOTION_VERIFY_TOKEN && env.HOSTED_SMOKE_OPERATOR_USERNAME && !env.HOSTED_SMOKE_OPERATOR_USERNAME.includes(':') &&
    env.HOSTED_SMOKE_OPERATOR_PASSWORD?.length >= 20 && (mode === 'live' || env.HOSTED_SMOKE_VERCEL_BYPASS) ? mode : null;
}

const request = (send, url, headers) => send(url, {
  method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000), headers
});

async function json(response) {
  if (response.status === 200) return response.json();
  await response.body?.cancel();
  throw new Error('http');
}

export async function verifyDeployment(env, mode, report, send, wait = sleep) {
  const headers = { Authorization: `Bearer ${env.VERCEL_PROMOTION_VERIFY_TOKEN}` };
  const deploymentId = env.CUTOVER_DEPLOYMENT_ID;
  const expected = mode === 'staged' ? ROLLBACK : deploymentId;
  for (let i = 0; i < 3; i++) {
    const response = await request(send, `https://api.vercel.com/v4/aliases/${LIVE}${TEAM_SCOPE}`, headers);
    let alias = null;
    if (response.status === 404 && mode === 'live') await response.body?.cancel();
    else alias = await json(response);
    if (alias && (alias.alias !== LIVE || alias.projectId !== VERCEL_PROJECT || alias.deletedAt != null ||
        alias.redirect != null || alias.redirectStatusCode != null ||
        (alias.deployment?.id !== undefined && alias.deployment.id !== alias.deploymentId))) return null;
    if (alias?.deploymentId === expected) break;
    if (mode !== 'live' || i === 2 || (alias && alias.deploymentId !== ROLLBACK)) return null;
    await wait(2000);
  }
  report('vercel-dedicated-alias', true);
  const metadata = await json(await request(send, `https://api.vercel.com/v13/deployments/${deploymentId}${TEAM_SCOPE}`, headers));
  const sources = [metadata?.gitSource?.sha, metadata?.meta?.githubCommitSha, metadata?.meta?.gitCommitSha].filter(sha => sha != null);
  const immutable = /^dgcamonitorindigo-[a-z0-9]{9}-chirag-prabhats-projects\.vercel\.app$/;
  if (!report('vercel-approved-deployment', metadata?.id === deploymentId && metadata.projectId === VERCEL_PROJECT &&
      metadata.readyState === 'READY' && metadata.target === 'production' && immutable.test(metadata.url) &&
      metadata.url === env.CUTOVER_IMMUTABLE_HOST && sources.length > 0 && sources.every(sha => sha === REVISION))) return null;
  return `https://${mode === 'staged' ? metadata.url : LIVE}`;
}

function projection(rows, fields) {
  return rows.map(row => JSON.stringify(fields.map(key => key === 'id' && typeof row[key] === 'number' ? String(row[key]) : row[key]))).sort();
}
const numericRun = row => ({ ...row, ...Object.fromEntries(['id', 'items_found', 'items_new', 'duration_ms'].map(key => [key, row[key] == null ? null : Number(row[key])])) });

export async function readProduction(client, hostname, report) {
  try {
    await client.connect();
    if (!report('production-verified-tls', verifySocket(client.connection?.stream, hostname))) return null;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const { rows: [id] } = await client.query(`SELECT current_database() AS db, current_user AS role,
        current_setting('neon.project_id', true) AS project, current_setting('neon.branch_id', true) AS branch,
        current_setting('neon.endpoint_id', true) AS endpoint, current_setting('transaction_read_only') AS ro, pg_is_in_recovery() AS replica`);
      if (!report('production-worker-identity', id?.db === 'neondb' && id.role === ROLE && id.project === PROJECT &&
          id.branch === BRANCH && id.endpoint === hostname.split('.')[0] && id.ro === 'on' && id.replica === false)) return null;
      const { rows: tables } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
      if (!report('production-table-inventory', same(tables.map(row => row.tablename), Object.keys(EXPECTED)))) return null;
      const { rows: [indexes] } = await client.query(`SELECT count(*)::int AS n, bool_and(i.indisvalid AND i.indisready) AS valid
        FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid WHERE t.relnamespace='public'::regnamespace`);
      if (!report('production-indexes', indexes.n === 28 && indexes.valid === true)) return null;
      const { rows: [counts] } = await client.query(`SELECT ${Object.keys(EXPECTED).map(name =>
        `(SELECT count(*)::int FROM public.${name}) AS ${name}`).join(', ')}`);
      if (!report('production-107-rows-and-empty-queue', same(counts, EXPECTED))) return null;
      const { rows: [safety] } = await client.query(`SELECT
        EXISTS(SELECT 1 FROM public.config WHERE key='emailEnabled' AND btrim(value)='false') AS email_off,
        NOT EXISTS(SELECT 1 FROM public.config WHERE key ILIKE '%smoke%') AS no_smoke,
        NOT EXISTS(SELECT 1 FROM public.monitoring_logs WHERE id=27) AS no_run_27`);
      if (!report('production-saved-email-disabled-and-no-test-data', safety.email_off && safety.no_smoke && safety.no_run_27)) return null;
      const { rows: updates } = await client.query(`SELECT ${UPDATE_FIELDS.join(', ')} FROM public.updates`);
      const { rows: logs } = await client.query(`SELECT ${RUN_FIELDS.join(', ')} FROM public.monitoring_logs ORDER BY run_at DESC NULLS LAST LIMIT 5`);
      if (!report('production-positive-read-baseline', updates.length === 40 && logs.length === 5 && logs.some(row => Number(row.id) === 26))) return null;
      const { rows: [searchable] } = await client.query('SELECT count(*)::int AS n FROM public.updates WHERE length(pdf_text) > 80');
      for (const term of ['aircraft', 'flight', 'safety']) {
        const { rows } = await client.query(`SELECT id FROM public.updates WHERE dgca_search_vector(title, pdf_text)
          @@ to_tsquery('public.dgca_search', $1)`, [`'${term}':*`]);
        if (rows.length) return { counts, updates, logs: logs.map(numericRun), search: { term, rows, searchable: searchable.n } };
      }
      report('production-search-baseline', false);
      return null;
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
}

export async function readHosted(env, mode, origin, direct, report, send = fetch) {
  const bypass = mode === 'staged' ? { 'x-vercel-protection-bypass': env.HOSTED_SMOKE_VERCEL_BYPASS } : {};
  const home = await request(send, `${origin}/`, bypass);
  if (!report('hosted-frontend', home.status === 200 && /<div id="root"/.test(await home.text()))) {
    if (home.status !== 200) await home.body?.cancel();
    return;
  }
  const challenge = await request(send, `${origin}/api/health`, bypass);
  const expectedChallenge = challenge.status === 401 && /^Basic realm="DGCA Monitor"(?:,|$)/i.test(challenge.headers.get('www-authenticate') || '');
  await challenge.body?.cancel();
  if (!report('hosted-operator-gate', expectedChallenge)) return;
  const encoded = Buffer.from(`${env.HOSTED_SMOKE_OPERATOR_USERNAME}:${env.HOSTED_SMOKE_OPERATOR_PASSWORD}`, 'utf8').toString('base64');
  const get = async path => json(await request(send, `${origin}${path}`, { ...bypass, Authorization: `Basic ${encoded}` }));
  if (!report('hosted-authenticated-health', (await get('/api/health')).status === 'ok')) return;
  const updates = await get('/api/updates?limit=50');
  if (!report('hosted-dashboard-matches-production', updates.total === direct.counts.updates && Array.isArray(updates.data) &&
      same(projection(updates.data, UPDATE_FIELDS), projection(direct.updates, UPDATE_FIELDS)))) return;
  const search = await get(`/api/search?q=${direct.search.term}&limit=50`);
  if (!report('hosted-search-matches-production', search.total === direct.search.rows.length && search.searchable === direct.search.searchable &&
      Array.isArray(search.data) && same(projection(search.data, ['id']), projection(direct.search.rows, ['id'])))) return;
  const status = await get('/api/monitor/status');
  if (!report('hosted-monitoring-matches-production', Array.isArray(status.recentRuns) &&
      !status.recentRuns.some(run => run?.id === 27) &&
      same(projection(status.recentRuns, RUN_FIELDS), projection(direct.logs, RUN_FIELDS)))) return;
  report('hosted-effective-email-disabled', status.email?.enabled === false);
}

async function main() {
  let failed = false;
  const report = (check, pass) => {
    failed ||= !pass;
    console.log(JSON.stringify({ check, outcome: pass ? 'PASS' : 'FAIL' }));
    return pass;
  };
  let stage = 'configuration';
  try {
    const env = process.env;
    const mode = approvedMode(env);
    if (!report(stage, Boolean(mode))) return;
    stage = 'pinned-source';
    const app = resolve('pinned-app');
    const git = (...args) => execFileSync('git', ['-C', app, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!report(stage, git('rev-parse', 'HEAD') === REVISION && !git('status', '--porcelain', '--untracked-files=no'))) return;
    stage = 'worker-secret-direct-production-target';
    const backend = resolve(app, 'backend/node_api');
    const { smokeDatabaseTarget } = await import(pathToFileURL(resolve(backend, 'src/config/smoke-database-target.js')).href);
    const target = smokeDatabaseTarget({ DEPLOYMENT_TEST_DATABASE_URL: env.DATABASE_URL,
      DEPLOYMENT_TEST_NEON_HOST: env.PRODUCTION_NEON_HOST, PRODUCTION_NEON_HOST: env.DEPLOYMENT_TEST_NEON_HOST });
    const url = new URL(target.connectionString);
    if (!report(stage, target.databaseName === 'neondb' && decodeURIComponent(url.username) === ROLE)) return;
    stage = 'read-only-production-check';
    const { Client } = createRequire(resolve(backend, 'package.json'))('pg');
    const client = new Client({ host: target.hostname, port: 5432, database: target.databaseName, user: ROLE,
      password: decodeURIComponent(url.password), ssl: { rejectUnauthorized: true, servername: target.hostname }, enableChannelBinding: true,
      connectionTimeoutMillis: 10000, query_timeout: 12000, statement_timeout: 10000,
      options: '-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=30000' });
    client.on('error', () => report('production-connection', false));
    const direct = await readProduction(client, target.hostname, report);
    if (!direct || mode === 'worker') return;
    stage = 'vercel-identity';
    const origin = await verifyDeployment(env, mode, report, fetch);
    if (!origin) { if (!failed) report(stage, false); return; }
    stage = 'hosted-read-only-check';
    await readHosted(env, mode, origin, direct, report);
  } catch {
    report(stage, false);
  } finally {
    process.exitCode = failed ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
