import { closeDatabase, getDatabase, verifyMonitoringSmokeConnection } from '../config/database.js';
import { runInMonitoringSmokeTest } from '../config/monitoring-smoke-context.js';
import { smokeDatabaseTarget, smokeError } from '../config/smoke-database-target.js';
import { checkForUpdates } from './monitor-service.js';
import { getGitHubMonitoringSlot } from './scheduler-service.js';
import { getSettings } from './settings-service.js';

export { smokeDatabaseTarget };

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
    throw smokeError('SMOKE_RECURRING_ENABLED', 'Recurring monitoring must remain disabled');
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
