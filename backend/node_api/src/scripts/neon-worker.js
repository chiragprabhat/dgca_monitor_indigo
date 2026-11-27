const production = {
  project: 'tiny-sea-21255890',
  branch: 'br-gentle-bread-beix3pqb',
  host: 'ep-little-mouse-beqk78b0.c-9.us-east-2.aws.neon.tech',
  role: 'neondb_owner',
};
const interval = 30 * 60_000;
const maxEnvelope = 64 * 1024;
const eventId = /^[A-Za-z0-9_-]{8,128}$/;
const canonicalSlot = /^\d{4}-\d{2}-\d{2}T\d{2}:(07|37):00(?:\.0{1,9})?Z$/;

async function readEvent(request) {
  const body = request.body?.getReader();
  if (!body) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await body.read();
      if (done) break;
      size += value.length;
      if (size > maxEnvelope) {
        await body.cancel();
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  } finally {
    body.releaseLock();
  }
}

export function createScheduledHandler({ enabled, triggerId, execute, clock = Date.now }) {
  let busy = false;
  const reply = (result, status = 200) => Response.json({ result }, { status });
  return async request => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/trigger') return reply('not-found', 404);
    const id = request.headers.get('x-neon-trigger-invocation-id');
    if (!eventId.test(id ?? '')) return reply('unauthorized', 401);
    if (!enabled()) return reply('disabled');
    const event = await readEvent(request);
    if (event?.version !== 1 || event.invocation_id !== id || event.trigger?.type !== 'schedule' ||
        !triggerId() || event.trigger.id !== triggerId()) return reply('unauthorized', 401);
    const source = event.data?.scheduled_at;
    const time = Date.parse(source);
    const now = clock();
    if (typeof source !== 'string' || !canonicalSlot.test(source) || !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 19) !== source.slice(0, 19) ||
        (time - 7 * 60000) % interval !== 0 || time > now + 15000 || now - time > 600000) {
      return reply('stale-or-invalid-slot');
    }
    if (busy) return reply('busy', 503);
    busy = true;
    const started = performance.now();
    const cpu = process.cpuUsage();
    try {
      const outcome = await execute(new Date(time));
      if (outcome.busy) return reply('busy', 503);
      if (outcome.skipped) return reply(outcome.skipped);
      const spent = process.cpuUsage(cpu);
      const usage = { wallMs: Math.round(performance.now() - started),
        processCpuMs: Math.round((spent.user + spent.system) / 1000),
        rssBytes: process.memoryUsage.rss() };
      if (!outcome.monitoring?.success) {
        console.error(JSON.stringify({ worker: 'neon', slot: new Date(time).toISOString(),
          outcome: 'monitoring-failed', ...usage }));
        return reply('monitoring-failed');
      }
      console.log(JSON.stringify({ worker: 'neon', slot: new Date(time).toISOString(),
        outcome: 'complete', jobs: outcome.processed, sections: outcome.monitoring.sectionResults, ...usage }));
      return reply('complete');
    } catch {
      console.error('Neon worker execution did not complete');
      return reply('worker-unavailable', 503);
    } finally {
      busy = false;
    }
  };
}

function enabled() {
  const cutoff = process.env.NEON_WORKER_CUTOFF_UTC;
  if (cutoff && !(Date.now() < Date.parse(cutoff))) return false;
  return process.env.NEON_BRANCH_ID === production.branch &&
    process.env.NEON_WORKER_ENABLED === 'true' &&
    process.env.DGCA_MONITOR_ENABLED === 'false';
}

async function execute(time) {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED);
  if (url.protocol !== 'postgresql:' || url.hostname !== production.host || url.pathname !== '/neondb' ||
      decodeURIComponent(url.username) !== production.role || !url.password || url.hash ||
      (url.port && url.port !== '5432') || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Unapproved worker connection');
  }
  const safe = new URL(url);
  safe.search = '';
  Object.assign(process.env, { DATABASE_URL: safe.href, DGCA_NEON_RUNTIME: '1',
    SUMMARY_PROVIDER: 'basic', MONITOR_INTERVAL_MINUTES: '30' });
  const { closeDatabase, verifyNeonWorkerConnection } = await import('../config/database.js');
  try {
    await verifyNeonWorkerConnection(production);
    const { getSettings } = await import('../services/settings-service.js');
    const settings = await getSettings();
    if (settings.intervalMinutes !== 30 || settings.summaryProvider !== 'basic') {
      throw new Error('Worker monitoring configuration is not approved');
    }
    const { runNeonWorker } = await import('../services/actions-worker.js');
    return await runNeonWorker(time);
  } finally {
    await closeDatabase();
  }
}

export default { fetch: createScheduledHandler({
  enabled, triggerId: () => process.env.NEON_WORKER_TRIGGER_ID, execute,
}) };
