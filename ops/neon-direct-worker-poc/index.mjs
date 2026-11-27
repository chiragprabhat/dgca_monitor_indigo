import { timingSafeEqual } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
import nodemailer from 'nodemailer'

const branch = 'br-plain-pine-belvpen0'
const testHost = 'ep-morning-hall-be8rl9fd.c-9.us-east-2.aws.neon.tech'
let admitted = false
function json(body, status = 200) { return Response.json(body, { status }) }
function authorized(header) {
  const key = process.env.DIRECT_POC_KEY
  return /^[a-f0-9]{64}$/.test(key ?? '') && /^[a-f0-9]{64}$/.test(header ?? '') &&
    timingSafeEqual(Buffer.from(header), Buffer.from(key))
}

function fixturePdf(size) {
  const stream = 'BT /F1 12 Tf 20 70 Td (Synthetic aviation test document.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'
  const offset = size ? size - xref.length - 17 : pdf.length
  return Buffer.concat([Buffer.from(pdf), Buffer.alloc(offset - pdf.length, 32),
    Buffer.from(xref + String(offset).padStart(10, '0') + '\n%%EOF\n')])
}

async function smtpNetworkProbe() {
  return Promise.all([465, 587].map(async port => {
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port, secure: port === 465, requireTLS: true,
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000, dnsTimeout: 5000,
      tls: { rejectUnauthorized: true, servername: 'smtp.gmail.com', minVersion: 'TLSv1.2' },
    })
    try { await transport.verify(); return { port, tls: true } }
    catch (error) { return { port, tls: false, code: error.code, command: error.command } }
    finally { transport.close() }
  }))
}

async function platformProbe() {
  const dir = await mkdtemp(join(tmpdir(), 'dgca-test-'))
  try { await writeFile(join(dir, 'probe'), 'temporary') } finally { await rm(dir, { recursive: true }) }
  try {
    const response = await fetch('https://www.dgca.gov.in/digigov-portal/', {
      method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(8000),
    })
    await response.body?.cancel()
    return { temporaryFilesystem: true, dgcaHttpStatus: response.status }
  } catch { return { temporaryFilesystem: true, dgcaHttpsFailed: true } }
}

async function liveReadProbe() {
  const { scrapeAllSections } = await import('../../backend/node_api/src/scrapers/dgca-scraper.js')
  const { fetchPdfWithText } = await import('../../backend/node_api/src/services/pdf-service.js')
  const signal = AbortSignal.timeout(65000)
  const approved = value => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.host === 'www.dgca.gov.in' &&
      url.pathname.startsWith('/digigov-portal/') && !url.username && !url.password
  }
  const id = axios.interceptors.request.use(config => {
    if (!approved(config.url)) throw Error('unapproved test request')
    return { ...config, signal, timeout: Math.min(config.timeout || 12000, 12000),
      maxRedirects: 0, maxContentLength: 8 * 1024 * 1024 }
  })
  const start = performance.now()
  const cpu = process.cpuUsage()
  try {
    const scrape = await scrapeAllSections({ strict: true })
    const sample = scrape.items?.find(item => item.pdfUrl && approved(item.pdfUrl))
    const pdf = sample && !signal.aborted ? await fetchPdfWithText(sample.pdfUrl) : null
    const usage = process.cpuUsage(cpu)
    return { success: scrape.success, sections: scrape.sectionResults, publications: scrape.items?.length ?? 0,
      pdfBytes: pdf?.buffer.length ?? 0, pdfPages: pdf?.pageCount ?? null,
      textCharacters: pdf?.text.length ?? 0, aborted: signal.aborted,
      wallMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000 }
  } finally { axios.interceptors.request.eject(id) }
}

async function execute(slot) {
  Object.assign(process.env, { DGCA_NEON_RUNTIME: '1',
    DGCA_MONITOR_ENABLED: 'false', EMAIL_NOTIFICATIONS_ENABLED: 'false', SUMMARY_PROVIDER: 'basic',
    MONITOR_INTERVAL_MINUTES: '30', MONITOR_START_HOUR: '0', MONITOR_END_HOUR: '23',
    LOG_LEVEL: 'error', SCRAPER_RETRY_ATTEMPTS: '1', SCRAPER_TIMEOUT_MS: '3000' })
  for (const key of Object.keys(process.env)) {
    if (/^SMTP_|^EMAIL_(APP_PASSWORD|FROM|RECIPIENT)/.test(key)) delete process.env[key]
  }
  console.log('Phase 2A: importing worker')
  const { smokeDatabaseTarget } = await import('../../backend/node_api/src/config/smoke-database-target.js')
  const { runInMonitoringSmokeTest } = await import('../../backend/node_api/src/config/monitoring-smoke-context.js')
  const { closeDatabase, getDatabase, verifyMonitoringSmokeConnection, withBackgroundSmokeDatabase } =
    await import('../../backend/node_api/src/config/database.js')
  const { runNeonWorker } = await import('../../backend/node_api/src/services/actions-worker.js')
  const { enqueueJob, claimJob, saveJobProgress } = await import('../../backend/node_api/src/services/job-service.js')
  const { extractText } = await import('../../backend/node_api/src/services/pdf-service.js')
  const { storeUpload } = await import('../../backend/node_api/src/services/upload-service.js')
  const { importArchive } = await import('../../backend/node_api/src/services/archive-service.js')
  const { withinWorkerDeadline, workerDelay } = await import('../../backend/node_api/src/services/worker-deadline.js')
  const { createScheduledHandler } = await import('../../backend/node_api/src/scripts/neon-worker.js')
  console.log('Phase 2A: worker imported')
  const platform = await platformProbe()
  console.log('Phase 2A: platform probe finished')
  const dbTarget = smokeDatabaseTarget({ DEPLOYMENT_TEST_NEON_HOST: testHost,
    PRODUCTION_NEON_HOST: 'ep-little-mouse-beqk78b0.c-9.us-east-2.aws.neon.tech',
    DEPLOYMENT_TEST_DATABASE_URL: process.env.DATABASE_URL_UNPOOLED })
  dbTarget.neonIdentity = { project: 'tiny-sea-21255890', branch, role: 'neondb_owner' }
  const original = { request: axios.request, post: axios.post, get: axios.get, transport: nodemailer.createTransport }
  let smtp = 0
  let partial = false
  let archiveInterrupted = false
  let archiveCalls = 0
  let attempts = 0
  const pdf = fixturePdf()
  nodemailer.createTransport = () => { smtp++; throw Error('SMTP blocked') }
  axios.request = async ({ method, url }) => {
    attempts++
    if (method === 'get') return { data: '<div class="tab-pane" id="tenders"></div><div class="tab-pane" id="announcement">No publications available</div>' }
    return { data: url.includes('Regulation') && partial ? { changed: true } : { contents: [] } }
  }
  axios.post = async (_url, body) => {
    attempts++
    if (body.includes('fetchRulebookContentDtlsList')) {
      return { data: '<table><tr><td colspan="5">SERIES A Test</td></tr>' +
        ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'].map(part =>
          '<tr><td><a data-url="dynamicPdf/fixture-' + part + '">PART ' + part +
          '</a></td><td>Issue 1</td><td>Synthetic CAR</td><td></td><td></td></tr>').join('') + '</table>' }
    }
    if (body.includes('actionVal=')) {
      if (archiveInterrupted && ++archiveCalls === 2) await workerDelay(15000)
      return { data: '<div id="archiveData">' + Array.from({ length: 25 }, (_, index) =>
        '<div class="sub-section"><p class="sub-heading">Synthetic archive ' + index +
        '</p><p class="sub-content">10/10/2025</p></div>').join('') + '</div>' }
    }
    return { data: '<html></html>' }
  }
  axios.get = async () => { attempts++; return { data: pdf, headers: { 'content-type': 'application/pdf' } } }
  try {
    return await runInMonitoringSmokeTest(dbTarget, async () => {
      try {
        await verifyMonitoringSmokeConnection()
        console.log('Phase 2A: database identity verified')
        const result = await withBackgroundSmokeDatabase(async namespace => {
          console.log('Phase 2A: scratch schema open')
          const db = getDatabase()
          const check = await db.prepare('SELECT current_schema() AS name').get()
          if (check.name !== namespace) throw Error('scratch schema insecure')
          await db.query("INSERT INTO config (key,value) VALUES ('emailEnabled','false')")
          const archive = await enqueueJob('archive', {})
          const abandoned = await claimJob(archive.id)
          if (!abandoned) throw Error('abandoned job fixture could not be claimed')
          archiveInterrupted = true
          let interrupted = false
          try {
            await withinWorkerDeadline(7000, () => importArchive({
              awaitImport: true, checkpoint: (progress, database) => saveJobProgress(abandoned, progress, database),
            }))
          } catch (error) { interrupted = ['AbortError', 'TimeoutError'].includes(error.name) }
          archiveInterrupted = false
          const saved = await db.prepare("SELECT input->'progress' AS progress FROM dgca_jobs WHERE id=$1").get(archive.id)
          const checkpointed = Object.keys(saved.progress.perSection).length
          const start = performance.now()
          const cpu = process.cpuUsage()
          let first
          let duplicate
          const eventId = 'deployment-test-invocation'
          const triggerId = 'deployment-test-fixture'
          const event = () => new Request('https://example.invalid/trigger', {
            method: 'POST', headers: { 'x-neon-trigger-invocation-id': eventId },
            body: JSON.stringify({ version: 1, invocation_id: eventId, trigger: { id: triggerId, type: 'schedule' },
              data: { scheduled_at: new Date(slot).toISOString() } }),
          })
          const handler = createScheduledHandler({ enabled: () => true, triggerId: () => triggerId, clock: () => slot,
            execute: async time => {
              const result = await runNeonWorker(time)
              if (first) duplicate = result
              else first = result
              return result
            } })
          await handler(event())
          console.log('Phase 2A: first cycle finished')
          const workerMs = performance.now() - start
          const workerCpu = process.cpuUsage(cpu)
          await handler(event())
          partial = true
          const partialRun = await runNeonWorker(new Date(slot + 30 * 60_000))
          console.log('Phase 2A: duplicate and partial cycles finished')
          const recovered = await db.prepare('SELECT state, status FROM dgca_jobs WHERE id=$1').get(archive.id)
          const cars = await db.prepare('SELECT count(*) AS n FROM car_documents').get()
          const extracted = await extractText(pdf)
          const large = fixturePdf(40 * 1024 * 1024)
          const largeStart = performance.now()
          const uploaded = await withinWorkerDeadline(30000, () => storeUpload(large, 'isolated-large.pdf'))
          const largePdfMs = performance.now() - largeStart
          // Force a real server-side timeout inside an application savepoint.
          const { transaction } = await import('../../backend/node_api/src/config/database.js')
          let timedOut = false
          try {
            await transaction(async scoped => {
              await scoped.query("SET LOCAL statement_timeout = '50ms'")
              await scoped.query('SELECT pg_sleep(0.2)')
            })
          } catch (error) { timedOut = error.code === '57014' }
          const row = await db.prepare('SELECT count(*) AS n FROM monitoring_logs').get()
          const items = await db.prepare("SELECT count(*) AS n FROM updates WHERE origin='archive'").get()
          if (!interrupted || checkpointed !== 1 || recovered.state !== 'done' || recovered.status !== 200 ||
              cars.n !== 8 || items.n !== 100 || !duplicate?.skipped || !first?.monitoring?.success ||
              partialRun.monitoring?.success !== false || !timedOut || smtp !== 0 ||
              uploaded.sizeBytes !== 40 * 1024 * 1024 || uploaded.pages !== 1) throw Error('Worker fixture assertion failed')
          return { first, duplicate, partialRun, recovered, cars: cars.n, pdfText: extracted,
            interrupted, checkpointed, archivePublications: items.n, largePdfMs, largePdfBytes: uploaded.sizeBytes,
            workerMs, workerCpuMs: (workerCpu.user + workerCpu.system) / 1000,
            timedOut, monitoringLogs: row.n, attempts, smtp }
        })
        return { ...result, ...platform, rolledBack: true }
      } finally { await closeDatabase() }
    })
  } finally { Object.assign(axios, { request: original.request, post: original.post, get: original.get }); nodemailer.createTransport = original.transport }
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (process.env.NEON_BRANCH_ID !== branch || request.method !== 'POST' ||
        !['/validate', '/trigger'].includes(path)) return json({ result: 'denied' }, 404)
    const event = await request.json().catch(() => null)
    const invocation = request.headers.get('x-neon-trigger-invocation-id')
    if (path === '/trigger') {
      if (!invocation || event?.invocation_id !== invocation || event?.version !== 1 ||
        !process.env.DIRECT_TRIGGER_ID || event?.trigger?.id !== process.env.DIRECT_TRIGGER_ID ||
        event.trigger.type !== 'schedule') return json({ result: 'denied' }, 401)
    } else if (!authorized(request.headers.get('x-dgca-test-key'))) return json({ result: 'denied' }, 401)
    const slot = Date.parse(path === '/trigger' ? event?.data?.scheduled_at : event?.slot)
    const now = Date.now()
    const maximumAge = path === '/validate' && process.env.DIRECT_COMPATIBILITY_RETRY === 'true'
      ? 30 * 60_000 : 10 * 60_000
    if (!Number.isFinite(slot) || (slot - 7 * 60_000) % (30 * 60_000) !== 0 ||
        now - slot > maximumAge || slot - now > 15_000) return json({ result: 'stale-or-invalid-slot' }, 409)
    if (slot !== Date.parse(process.env.DIRECT_POC_SLOT)) return json({ result: 'outside-test-slot' })
    if (admitted) return json({ result: 'used-instance' }, 409)
    admitted = true
    const start = performance.now()
    const cpu = process.cpuUsage()
    const startRss = process.memoryUsage.rss()
    let peak = startRss
    const sampling = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()) }, 20)
    try {
      const result = await execute(slot)
      const dgca = await liveReadProbe()
      const smtpNetwork = await smtpNetworkProbe()
      const usage = process.cpuUsage(cpu)
      const proof = { ...result, dgca, smtpNetwork, runtimeMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000,
        rssStartBytes: startRss, rssPeakBytes: Math.max(peak, process.memoryUsage.rss()), node: process.version }
      console.log(JSON.stringify({ phase2a: proof }))
      return json(proof)
    } catch (error) {
      console.error('Phase 2A test stopped', error?.name, error?.code)
      return json({ result: 'fixture-failed', code: typeof error?.code === 'string' ? error.code : undefined }, 500)
    } finally { clearInterval(sampling) }
  },
}
