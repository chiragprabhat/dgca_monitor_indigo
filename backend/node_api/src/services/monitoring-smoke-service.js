import { closeDatabase, getDatabase, verifyMonitoringSmokeConnection } from '../config/database.js';
import { runInMonitoringSmokeTest } from '../config/monitoring-smoke-context.js';
import { checkForUpdates } from './monitor-service.js';
import { getGitHubMonitoringSlot } from './scheduler-service.js';
import { getSettings } from './settings-service.js';

const directNeonHost = /^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/;
const isDirect = host => directNeonHost.test(host) && !host.includes('-pooler.');
const preflightError = (code, message) => Object.assign(new Error(message), { code });

export function smokeDatabaseTarget(env) {
  const test = (env.DEPLOYMENT_TEST_NEON_HOST || '').trim().toLowerCase();
  const production = (env.PRODUCTION_NEON_HOST || '').trim().toLowerCase();
  if (!isDirect(test) || !isDirect(production) || test === production) {
    throw preflightError('SMOKE_HOSTS', 'Configure distinct direct Neon hostnames for the test and production branches');
  }
  let url;
  try { url = new URL(env.DEPLOYMENT_TEST_DATABASE_URL); } catch {
    throw preflightError('SMOKE_URL', 'The dedicated test database secret must contain a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== test ||
      url.hostname === production || !isDirect(url.hostname) || (url.port && url.port !== '5432') ||
      !url.username || !url.password || url.hash || !/^\/[^/]+$/.test(url.pathname)) {
    throw preflightError('SMOKE_ENDPOINT', 'The dedicated secret does not match the confirmed direct test endpoint');
  }
  const allowed = { sslmode: ['require', 'verify-ca', 'verify-full'], channel_binding: ['require', 'prefer'] };
  for (const [key, value] of url.searchParams) {
    if (!Object.hasOwn(allowed, key) || !allowed[key].includes(value) || url.searchParams.getAll(key).length !== 1) {
      throw preflightError('SMOKE_URL_OPTIONS', 'The dedicated secret contains unsupported connection options');
    }
  }
  let databaseName;
  try { databaseName = decodeURIComponent(url.pathname.slice(1)); } catch {
    throw preflightError('SMOKE_URL', 'The dedicated secret contains an invalid database name');
  }
  if (!databaseName || /[\x00-\x1f\x7f/]/.test(databaseName)) {
    throw preflightError('SMOKE_URL', 'Invalid test database name');
  }
  return { hostname: test, connectionString: url.href, databaseName };
}

async function snapshot() {
  return getDatabase().prepare(`
    SELECT (SELECT count(*)::text FROM updates) AS publications,
           (SELECT count(*)::text FROM notifications) AS notifications,
           (SELECT count(*)::text FROM monitoring_logs) AS "monitoringLogs",
           (SELECT json_build_object('id', id::text, 'runAt', run_at, 'status', status,
              'itemsFound', items_found, 'itemsNew', items_new, 'durationMs', duration_ms)
            FROM monitoring_logs ORDER BY id DESC LIMIT 1) AS "latestLog"
  `).get();
}

const operations = { verify: verifyMonitoringSmokeConnection, settings: getSettings,
  getSlot: getGitHubMonitoringSlot, monitor: checkForUpdates, snapshot, close: closeDatabase };

export async function runMonitoringSmokeTest({ env = process.env, now = new Date(), onBaseline } = {}, overrides = {}) {
  if (env.DGCA_MONITOR_ENABLED !== 'false') {
    throw preflightError('SMOKE_RECURRING_ENABLED', 'Recurring monitoring must remain disabled');
  }
  const ops = { ...operations, ...overrides };
  const target = smokeDatabaseTarget(env);
  return runInMonitoringSmokeTest(target, async () => {
    try {
      await ops.verify();
      if ((await ops.settings()).summaryProvider !== 'basic') {
        return { outcome: 'invalid-summary-provider' };
      }
      const before = await ops.snapshot();
      onBaseline?.(before);
      const slot = await ops.getSlot(now);
      let outcome = 'outside-monitoring-window';
      let result;
      if (slot) {
        outcome = 'monitor-error';
        try {
          result = await ops.monitor({ scheduledSlot: slot });
          if (result.skipped) outcome = result.reason === 'Slot already claimed' ? 'slot-already-claimed' : 'monitor-busy';
          else if (result.success && result.itemsFound > 0) outcome = 'scraped';
        } catch {
          // Still try to take the post-run snapshot if recording the monitoring error threw.
        }
      }
      const after = await ops.snapshot();
      const notificationsUnchanged = before.notifications === after.notifications && !result?.notificationsSent;
      if (!notificationsUnchanged) outcome = 'notification-invariant-failed';
      else if (outcome === 'scraped' && (BigInt(after.monitoringLogs) !== BigInt(before.monitoringLogs) + 1n ||
          !after.latestLog || after.latestLog.id === before.latestLog?.id || after.latestLog.status !== 'success')) {
        outcome = 'monitoring-log-invariant-failed';
      }
      return { outcome, slot, summaryProvider: 'basic', notificationsUnchanged, before, after };
    } finally {
      await ops.close();
    }
  });
}
