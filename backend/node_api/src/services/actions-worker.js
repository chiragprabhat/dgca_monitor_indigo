import axios from 'axios';
import { acquireMonitoringLock, getDatabase } from '../config/database.js';
import { compareDocuments } from '../routes/compare.js';
import { sendTestNotification } from '../routes/notifications.js';
import { getRevision } from '../routes/updates.js';
import { getArchiveStatus, importArchive, startAnalysis } from './archive-service.js';
import { carSyncStatus, syncCars, CHECK_EVERY_MINUTES } from './car-service.js';
import { processUpload } from './chunk-upload-service.js';
import { claimJob, deferJob, enqueueJob, finishJob, jobStatus, recoverJobs, saveJobProgress } from './job-service.js';
import { checkForUpdates } from './monitor-service.js';
import { testEmailConnection } from './notification-service.js';
import { getGitHubMonitoringSlot } from './scheduler-service.js';
import { getUnanalyzedUpdates, logMonitoringRun } from './state-service.js';
import { getSummaryProvider } from './summary-service.js';
import { getHttpsAgent } from '../utils/system-ca.js';
import { checkWorkerDeadline, withinWorkerDeadline, workerSignal } from './worker-deadline.js';
import { activationTime } from './recipient-delivery-service.js';

const ok = (result, status = 200) => ({ status, result });
const timed = result => ({ ...result, timestamp: new Date().toISOString() });

const handlers = {
  compare: async input => ok(await compareDocuments(input)),
  revision: input => getRevision(input.id, input.refresh),
  upload: async input => ok(await processUpload(input.id), 201),
  'test-email': async input => {
    await getSummaryProvider();
    return sendTestNotification(input.id, input.retry === true);
  },
  'smtp-check': async () => ok(timed(await testEmailConnection())),
  monitor: async () => {
    await getSummaryProvider();
    return ok(timed(await checkForUpdates()));
  },
  car: async () => {
    await syncCars();
    const { lastSync } = await carSyncStatus();
    return ok(lastSync, lastSync?.error ? 502 : 200);
  },
  archive: async (input, job) => {
    await importArchive({ awaitImport: true, progress: input.progress,
      checkpoint: (progress, db) => saveJobProgress(job, progress, db) });
    const { lastImport } = await getArchiveStatus();
    return ok({ lastImport }, lastImport?.error ? 502 : 200);
  },
  'archive-analysis': async () => {
    await startAnalysis({ maxItems: 5 });
    const { analysisError } = await getArchiveStatus();
    return ok({ analysisError }, analysisError ? 502 : 200);
  }
};

export async function processActionsJob(job, assertHeld) {
  let outcome;
  try {
    const handler = Object.hasOwn(handlers, job.kind) && handlers[job.kind];
    if (!handler) throw new Error('Unknown worker job');
    const emailJob = ['test-email', 'smtp-check'].includes(job.kind) && process.env.DGCA_NEON_RUNTIME === '1';
    const cutoff = emailJob ? activationTime() : null;
    outcome = emailJob && (cutoff === null || !job.created_at || !(+new Date(job.created_at) >= cutoff))
      ? ok({ success: false, error: 'Email job predates activation or delivery is disabled' }, 409)
      : await handler(job.input, job);
  } catch (error) {
    checkWorkerDeadline();
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    outcome = ok({ success: false, error: status === 500 ? 'Background operation failed. Check the runner logs.' : error.message }, status);
    console.error('DGCA job failed:', job.kind, error.code || error.name);
  }
  assertHeld();
  await finishJob(job, outcome.status, outcome.result);
}

export async function runActionsWorker(now = new Date()) {
  if (process.env.DGCA_ACTIONS_WORKER !== '1' || process.env.DGCA_MONITOR_ENABLED !== 'true') {
    throw new Error('The GitHub Actions worker is disabled');
  }
  return runWorker(now);
}

export async function runNeonWorker(now, { maxJobMs = 180000, monitorMs = 180000 } = {}) {
  if (process.env.DGCA_NEON_RUNTIME !== '1' || process.env.DGCA_MONITOR_ENABLED !== 'false') {
    throw new Error('The direct Neon worker configuration is required');
  }
  return runWorker(now, { maxJobMs, monitorMs });
}

const resumableJobs = new Set(['car', 'archive', 'archive-analysis', 'compare', 'revision', 'upload']);

async function runWorker(now, neon) {
  axios.defaults.httpsAgent = getHttpsAgent();
  const workerLock = await acquireMonitoringLock(5);
  if (!workerLock) return { busy: true };
  try {
    const db = getDatabase();
    if (!neon) await recoverJobs();
    const scheduledSlot = await getGitHubMonitoringSlot(now);
    if (neon) {
      if (!scheduledSlot) return { skipped: 'outside-monitoring-window' };
      const claim = await db.query(`INSERT INTO config (key, value) VALUES ('neon_worker_last_slot', $1)
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=dgca_utc_now()
        WHERE config.value < EXCLUDED.value`, [scheduledSlot]);
      if (!claim.rowCount) return { skipped: 'slot-already-claimed' };
    }
    if (neon) await recoverJobs();
    let providerReady = true;
    let monitoring = null;
    try {
      await getSummaryProvider();
    } catch (error) {
      if (error.status !== 409) throw error;
      providerReady = false;
      if (scheduledSlot) monitoring = { success: false, error: error.message };
    }
    if (providerReady) {
      if (!neon) await db.query(`INSERT INTO config (key, value) VALUES ('actions_worker_heartbeat', 'true')
        ON CONFLICT (key) DO UPDATE SET updated_at = dgca_utc_now()`);
      if (scheduledSlot) {
        if (neon) {
          const started = Date.now();
          try {
            monitoring = await withinWorkerDeadline(neon.monitorMs, () => checkForUpdates({ scheduledSlot }));
          } catch (error) {
            if (!['AbortError', 'TimeoutError'].includes(error.name)) throw error;
            monitoring = { success: false, error: 'Monitoring deadline exceeded' };
            await logMonitoringRun('failed', 0, 0, Date.now() - started, monitoring.error);
          }
        } else monitoring = await checkForUpdates({ scheduledSlot });
      }
    } else {
      await db.query("DELETE FROM config WHERE key = 'actions_worker_heartbeat'");
    }

    const car = await jobStatus('car');
    if (!car.active && (!car.latest?.finishedAt ||
        now.getTime() - Date.parse(car.latest.finishedAt) >= CHECK_EVERY_MINUTES * 60000)) {
      await enqueueJob('car');
    }
    const budget = Date.now() + 5 * 60000;
    let processed = 0;
    let analyzedArchive = false;
    while (Date.now() < budget && processed < 20) {
      workerLock.assertHeld();
      let job = await claimJob();
      if (!job && !analyzedArchive && (await getUnanalyzedUpdates(1, 'archive')).length) {
        await enqueueJob('archive-analysis');
        job = await claimJob();
      }
      if (!job) break;
      if (job.kind === 'archive-analysis') {
        if (analyzedArchive) {
          await deferJob(job);
          break;
        }
        analyzedArchive = true;
      }
      if (neon) {
        try {
          await withinWorkerDeadline(Math.max(1, Math.min(neon.maxJobMs, budget - Date.now())), async () => {
            try {
              await processActionsJob(job, workerLock.assertHeld);
            } catch (error) {
              if (!workerSignal().aborted) throw error;
              throw workerSignal().reason;
            }
          });
        } catch (error) {
          if (error.name !== 'TimeoutError') throw error;
          workerLock.assertHeld();
          if (resumableJobs.has(job.kind)) await deferJob(job);
          else await finishJob(job, 503, { success: false, error: 'The job reached its execution deadline. Check history before retrying.' });
          break;
        }
      } else await processActionsJob(job, workerLock.assertHeld);
      processed++;
    }
    if (neon && monitoring?.success && !monitoring.skipped) {
      await db.query(`INSERT INTO config (key, value) VALUES ('actions_worker_heartbeat', 'neon')
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=dgca_utc_now()`);
    }
    return { processed, monitoring };
  } finally {
    await workerLock.release();
  }
}
