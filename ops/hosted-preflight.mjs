import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { pathToFileURL } from 'node:url';

export const ORIGIN = 'https://dgcamonitorindigo-c4rd5c0n5-chirag-prabhats-projects.vercel.app';
export const REVISION = '88d059b531993cd34e05bbf90339faf235c4b356';
export const RUN_ID = 27;
export const RUN_AT = '2026-11-25 18:10:21';
const PDF_BYTES = 40 * 1024 ** 2;
const NUMERIC_FIELDS = ['id', 'items_found', 'items_new', 'duration_ms'];
const RECORD_FIELDS = [...NUMERIC_FIELDS, 'run_at', 'status'];

export function approved(env) {
  return env.HOSTED_PREFLIGHT_CONFIRMATION === 'RUN HOSTED READ ONLY PREFLIGHT' &&
    env.HOSTED_SMOKE_URL === ORIGIN && env.HOSTED_SMOKE_TEST_RUN_ID === String(RUN_ID) &&
    env.HOSTED_SMOKE_TEST_RUN_AT === RUN_AT && env.DGCA_MONITOR_ENABLED === 'false' &&
    env.EMAIL_NOTIFICATIONS_ENABLED === 'false' && Boolean(env.HOSTED_SMOKE_VERCEL_BYPASS &&
      env.HOSTED_SMOKE_OPERATOR_USERNAME && !env.HOSTED_SMOKE_OPERATOR_USERNAME.includes(':') &&
      env.HOSTED_SMOKE_OPERATOR_PASSWORD?.length >= 20);
}

export function verifySocket(socket, hostname) {
  return socket?.encrypted === true && socket.authorized === true &&
    !checkServerIdentity(hostname, socket.getPeerCertificate());
}

export async function readDatabase(client, target, report) {
  await client.connect();
  if (!verifySocket(client.connection.stream, target.hostname)) throw new Error('TLS');
  await client.query('BEGIN READ ONLY');
  try {
    const { rows: [identity] } = await client.query(`SELECT current_database() AS db,
      current_setting('transaction_read_only') AS read_only, pg_is_in_recovery() AS replica`);
    if (identity.db !== target.databaseName || identity.read_only !== 'on' || identity.replica !== false) {
      throw new Error('database identity');
    }
    report('direct-test-database-tls-read-only', true);
    const { rows: [record] } = await client.query(`SELECT id::text, run_at, status, items_found, items_new, duration_ms
      FROM public.monitoring_logs WHERE id = $1 AND run_at = $2 AND status = 'success'`, [RUN_ID, RUN_AT]);
    const knownRun = record && { ...record };
    if (knownRun) {
      for (const field of NUMERIC_FIELDS) {
        if (knownRun[field] != null) knownRun[field] = Number(knownRun[field]);
      }
    }
    report('known-test-record', Boolean(knownRun?.id === RUN_ID && knownRun.run_at === RUN_AT &&
      RECORD_FIELDS.every(field => knownRun[field] != null)), { id: RUN_ID, runAtUtc: RUN_AT });
    const { rows: [saved] } = await client.query("SELECT value FROM public.config WHERE key = 'emailEnabled'");
    report('saved-email-override-safe', !saved || saved.value?.trim() === 'false', { overridePresent: Boolean(saved) });
    const { rows: [risk] } = await client.query(`SELECT
      count(*) FILTER (WHERE job_id IS NULL AND expires_at <= now() + interval '5 minutes')::text AS expiring,
      COALESCE(sum(bytes), 0)::text AS reserved FROM public.dgca_upload_sessions`);
    report('no-unrelated-expiring-uploads', Number(risk.expiring) === 0, { expiring: Number(risk.expiring) });
    report('upload-capacity', Number(risk.reserved) + PDF_BYTES <= 3 * PDF_BYTES);
    return knownRun;
  } finally {
    await client.query('ROLLBACK');
  }
}

export async function readHosted(env, knownRun, report, send = fetch) {
  const bypass = { 'x-vercel-protection-bypass': env.HOSTED_SMOKE_VERCEL_BYPASS };
  const request = headers => send(`${ORIGIN}/api/monitor/status`, {
    method: 'GET', redirect: 'error', cache: 'no-store', headers, signal: AbortSignal.timeout(20000)
  });
  const challenge = await request(bypass);
  const gate = challenge.status === 401 && /^Basic realm="DGCA Monitor"(?:,|$)/i.test(
    challenge.headers.get('www-authenticate') || '');
  await challenge.body?.cancel();
  report('vercel-bypass-and-operator-gate', gate);
  if (!gate) return;
  const encoded = Buffer.from(`${env.HOSTED_SMOKE_OPERATOR_USERNAME}:${env.HOSTED_SMOKE_OPERATOR_PASSWORD}`).toString('base64');
  const response = await request({ ...bypass, Authorization: `Basic ${encoded}` });
  report('authenticated-hosted-access', response.status === 200);
  if (response.status !== 200) {
    await response.body?.cancel();
    return;
  }
  const data = await response.json();
  report('effective-hosted-email-disabled', data?.email?.enabled === false);
  report('hosted-record-matches-direct-test-record', Boolean(knownRun && Array.isArray(data?.recentRuns) &&
    data.recentRuns.some(run => run && RECORD_FIELDS.every(field => run[field] === knownRun[field]))));
}

async function runPreflight(env) {
  let failed = false;
  const report = (check, pass, detail = {}) => {
    failed ||= !pass;
    console.log(JSON.stringify({ check, outcome: pass ? 'PASS' : 'FAIL', ...detail }));
  };
  let stage = 'configuration';
  let client;
  try {
    if (!approved(env)) throw new Error('configuration');
    report('approved-inputs-and-disabled-github-flags', true);
    stage = 'pinned-dependency-checkout';
    const app = resolve('pinned-app');
    const git = (...args) => execFileSync('git', ['-C', app, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (git('rev-parse', 'HEAD') !== REVISION || git('status', '--porcelain', '--untracked-files=no')) throw new Error('checkout');
    stage = 'direct-test-database';
    const backend = resolve(app, 'backend/node_api');
    const { smokeDatabaseTarget } = await import(pathToFileURL(resolve(backend, 'src/config/smoke-database-target.js')).href);
    const target = smokeDatabaseTarget(env);
    if (target.databaseName !== 'neondb' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('database configuration');
    const url = new URL(target.connectionString);
    const { Client } = createRequire(resolve(backend, 'package.json'))('pg');
    client = new Client({ host: target.hostname, port: 5432, database: target.databaseName,
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: true, servername: target.hostname }, enableChannelBinding: true,
      connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 12000,
      options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c idle_in_transaction_session_timeout=30000' });
    client.on('error', () => report('direct-test-database-connection', false));
    const knownRun = await readDatabase(client, target, report);
    await client.end();
    client = undefined;
    stage = 'hosted-status';
    await readHosted(env, knownRun, report);
  } catch {
    report(stage, false);
  } finally {
    try { await client?.end(); } catch { report('database-disconnect', false); }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runPreflight(process.env);
}
