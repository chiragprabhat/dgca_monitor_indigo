import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_ID, RUN_AT, REVISION, verifySocket } from './hosted-preflight.mjs';
import { execFileSync } from 'node:child_process';

const PROJECT = 'tiny-sea-21255890';
const TEST_BRANCH = 'br-plain-pine-belvpen0';
const ROLE = 'neondb_owner';
const CONFIRMATION = 'VERIFY EXISTING DGCA WORKER DATABASE';

export async function verifyTestSession(client, hostname) {
  try {
    await client.connect();
    if (!verifySocket(client.connection?.stream, hostname)) return 'tls-unverified';
    await client.query('BEGIN READ ONLY');
    try {
      const { rows: [identity] } = await client.query(`SELECT current_database() AS db, current_user AS role,
        current_setting('neon.project_id', true) AS project, current_setting('neon.branch_id', true) AS branch,
        current_setting('neon.endpoint_id', true) AS endpoint,
        current_setting('transaction_read_only') AS read_only, pg_is_in_recovery() AS replica`);
      if (identity?.project !== PROJECT || identity.branch !== TEST_BRANCH || identity.endpoint !== hostname.split('.')[0] ||
          identity.db !== 'neondb' || identity.role !== ROLE || identity.read_only !== 'on' || identity.replica !== false) {
        return 'database-identity-mismatch';
      }
      const { rows: [proof] } = await client.query(`SELECT
        EXISTS(SELECT 1 FROM public.monitoring_logs WHERE id = $1 AND run_at = $2 AND status = 'success'
          AND items_found = 40 AND items_new = 1 AND duration_ms = 25324) AS known_record,
        EXISTS(SELECT 1 FROM public.config WHERE key = 'emailEnabled' AND btrim(value) = 'false') AS email_disabled`,
      [RUN_ID, RUN_AT]);
      if (proof?.known_record !== true) return 'record-mismatch';
      if (proof.email_disabled !== true) return 'saved-email-not-disabled';
      return null;
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
}

export async function verifyWorker(env, validate, verify, report) {
  if (env.DGCA_WORKER_VERIFY_CONFIRMATION !== CONFIRMATION || env.DGCA_MONITOR_ENABLED !== 'false' ||
      env.EMAIL_NOTIFICATIONS_ENABLED !== 'false' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    report('configuration', false, { reason: 'required-safety-gates' });
    return;
  }
  report('configuration', true);
  for (const [name, credential] of [['current-worker', env.DATABASE_URL], ['dedicated-test-reference', env.DEPLOYMENT_TEST_DATABASE_URL]]) {
    let target;
    try {
      target = validate({ ...env, DEPLOYMENT_TEST_DATABASE_URL: credential });
      const url = new URL(target.connectionString);
      if (target.databaseName !== 'neondb' || decodeURIComponent(url.username) !== ROLE) throw new Error('identity');
    } catch {
      report(name, false, { reason: 'approved-direct-test-endpoint-database-or-role-mismatch' });
      return;
    }
    let issue;
    try { issue = await verify(target); } catch { issue = 'connection-or-read-only-query-failed'; }
    if (issue) {
      report(name, false, { reason: issue });
      return;
    }
    report(name, true);
  }
  report('connection-comparison', true, { relationship: env.DATABASE_URL === env.DEPLOYMENT_TEST_DATABASE_URL ?
    'exact-match' : 'operationally-equivalent', branch: TEST_BRANCH, database: 'neondb', role: ROLE,
  monitoringRecord: RUN_ID, monitoringRecordUtc: RUN_AT, savedEmailDisabled: true });
}

async function main() {
  let failed = false;
  const report = (check, pass, details = {}) => {
    failed ||= !pass;
    console.log(JSON.stringify({ check, outcome: pass ? 'PASS' : 'FAIL', ...details }));
  };
  try {
    const app = resolve('pinned-app');
    const git = (...args) => execFileSync('git', ['-C', app, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (git('rev-parse', 'HEAD') !== REVISION || git('status', '--porcelain', '--untracked-files=no')) throw new Error('source');
    report('pinned-dependencies', true);
    const backend = resolve(app, 'backend/node_api');
    const { smokeDatabaseTarget } = await import(pathToFileURL(resolve(backend, 'src/config/smoke-database-target.js')).href);
    const { Client } = createRequire(resolve(backend, 'package.json'))('pg');
    await verifyWorker(process.env, smokeDatabaseTarget, target => {
      const url = new URL(target.connectionString);
      const client = new Client({ host: target.hostname, port: 5432, database: target.databaseName,
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        ssl: { rejectUnauthorized: true, servername: target.hostname }, enableChannelBinding: true,
        connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 12000,
        options: '-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=30000' });
      client.on('error', () => report('database-connection', false));
      return verifyTestSession(client, target.hostname);
    }, report);
  } catch {
    report('worker-verifier', false);
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
