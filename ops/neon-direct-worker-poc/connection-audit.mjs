import pg from 'pg'
import { checkServerIdentity } from 'node:tls'
import { timingSafeEqual } from 'node:crypto'

const target = {
  project: 'tiny-sea-21255890',
  branch: 'br-plain-pine-belvpen0',
  host: 'ep-morning-hall-be8rl9fd.c-9.us-east-2.aws.neon.tech',
  role: 'neondb_owner',
}
let called = false

async function audit() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED)
  if (url.protocol !== 'postgresql:' || url.hostname !== target.host || url.pathname !== '/neondb' ||
      decodeURIComponent(url.username) !== target.role || !url.password ||
      (url.port && url.port !== '5432') || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw Error('Unapproved test database')
  }
  url.search = ''
  url.searchParams.set('application_name', 'dgca-function-cleanup-audit')
  Object.assign(process.env, { DGCA_NEON_RUNTIME: '1', DATABASE_URL: url.href })
  const { acquireMonitoringLock, closeDatabase, getDatabase, transaction, verifyNeonWorkerConnection } =
    await import('../../backend/node_api/src/config/database.js')
  const { withinWorkerDeadline, workerDelay } = await import('../../backend/node_api/src/services/worker-deadline.js')
  const paths = []
  for (const mode of ['success', 'failure', 'sql-timeout', 'worker-timeout']) {
    let observed = 'success'
    try {
      await verifyNeonWorkerConnection(target)
      const lock = await acquireMonitoringLock(5)
      if (!lock) throw Error('Worker lock busy')
      try {
        await transaction(async db => {
          await db.query('SET TRANSACTION READ ONLY')
          await db.query('SELECT 1')
          if (mode === 'failure') throw Object.assign(Error('Fixture failure'), { code: 'TEST_FAILURE' })
          if (mode === 'sql-timeout') {
            await db.query("SET LOCAL statement_timeout = '50ms'")
            await db.query('SELECT pg_sleep(0.2)')
          }
          if (mode === 'worker-timeout') await withinWorkerDeadline(25, () => workerDelay(300))
          lock.assertHeld()
        })
      } finally { await lock.release() }
      await getDatabase().query('SELECT 1')
    } catch (error) {
      observed = error.code === 'TEST_FAILURE' ? 'failure'
        : error.code === '57014' ? 'sql-timeout'
          : error.name === 'AbortError' ? 'worker-timeout' : 'unexpected'
    } finally { await closeDatabase() }
    if (observed !== mode) throw Error('Incorrect cleanup scenario result')

    url.searchParams.set('application_name', 'dgca-cleanup-inspector')
    const observer = new pg.Client({ connectionString: url.href,
      ssl: { rejectUnauthorized: true, servername: target.host }, connectionTimeoutMillis: 10000 })
    try {
      await observer.connect()
      const socket = observer.connection.stream
      if (!socket.authorized || checkServerIdentity(target.host, socket.getPeerCertificate())) throw Error('Audit TLS mismatch')
      await observer.query('BEGIN READ ONLY')
      const { rows: [result] } = await observer.query(`SELECT
        current_setting('neon.branch_id', true) AS branch,
        count(*) FILTER (WHERE application_name = 'dgca-function-cleanup-audit')::int AS own,
        count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_transactions,
        count(*) FILTER (WHERE application_name ~* 'pooler|pgbouncer' AND state = 'idle')::int AS idle_pooler,
        (SELECT count(*) FROM pg_stat_replication)::int AS replication_connections,
        (SELECT count(*) FROM pg_replication_slots WHERE active)::int AS active_replication_slots
        FROM pg_stat_activity WHERE backend_type='client backend' AND pid <> pg_backend_pid()`)
      if (result.branch !== target.branch || result.own !== 0) throw Error('Worker sessions still connected')
      paths.push({ mode, ...result })
    } finally { await observer.query('ROLLBACK').catch(() => {}); await observer.end() }
  }
  return paths
}

export default {
  async fetch(request) {
    if (process.env.NEON_BRANCH_ID !== target.branch || request.method !== 'POST' ||
        new URL(request.url).pathname !== '/audit') return new Response(null, { status: 404 })
    const header = request.headers.get('x-dgca-test-key')
    const key = process.env.CONNECTION_AUDIT_KEY
    if (!/^[a-f0-9]{64}$/.test(header ?? '') || !/^[a-f0-9]{64}$/.test(key ?? '') ||
        !timingSafeEqual(Buffer.from(header), Buffer.from(key))) return new Response(null, { status: 401 })
    if (called) return new Response(null, { status: 409 })
    called = true
    try { return Response.json({ paths: await audit(), endedAt: new Date().toISOString() }) }
    catch { return Response.json({ error: 'Connection audit failed' }, { status: 500 }) }
  },
}
