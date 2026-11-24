import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import axios from 'axios';
import pg from 'pg';

function fullSizePdf() {
  const sentence = 'Flight crew rest applies to every scheduled service. Please review and record compliance for all crews.';
  const stream = `BT /F1 12 Tf 20 70 Td (${sentence}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let content = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = content.length;
    content += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const crossRef = 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n';
  const bytes = 40 * 1024 * 1024;
  const end = `${String(bytes - crossRef.length - 17).padStart(10, '0')}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(content), Buffer.alloc(bytes - content.length - crossRef.length - end.length, 32), Buffer.from(crossRef + end)]);
}

test('Vercel handler and direct worker share durable, authenticated PostgreSQL operations', {
  skip: !process.env.TEST_DATABASE_URL
}, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const admin = new pg.Client(process.env.TEST_DATABASE_URL);
  await admin.connect();
  const schema = `worker_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const origin = 'https://monitor.example.test';
  const password = randomUUID();
  Object.assign(process.env, {
    VERCEL: '1', DATABASE_URL: url.toString(), FRONTEND_URL: origin, API_OPERATOR_USERNAME: 'operator',
    API_OPERATOR_PASSWORD: password, SUMMARY_PROVIDER: 'basic', EMAIL_NOTIFICATIONS_ENABLED: 'false',
    USE_WINDOWS_CERTS: 'false', MONITOR_START_HOUR: '0', MONITOR_END_HOUR: '23',
    MONITOR_INTERVAL_MINUTES: '15', DGCA_ACTIONS_WORKER: '1', DGCA_MONITOR_ENABLED: 'true'
  });
  const { initializeDatabase, closeDatabase, getDatabase } = await import('../src/config/database.js');
  t.after(async () => {
    await closeDatabase();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await initializeDatabase();
  const db = getDatabase();
  const sql = await readFile(new URL('../src/config/deployment.sql', import.meta.url), 'utf8');
  await db.query(sql);
  await db.query(sql);
  const { default: handler } = await import('../../../api/dgca.mjs');
  const { runActionsWorker } = await import('../src/services/actions-worker.js');
  const { enqueueJob, claimJob } = await import('../src/services/job-service.js');
  const runWorker = async date => {
    delete process.env.VERCEL;
    try { return await runActionsWorker(date); } finally { process.env.VERCEL = '1'; }
  };
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const auth = `Basic ${Buffer.from(`operator:${password}`).toString('base64')}`;
  const request = (path, { headers, ...options } = {}) => fetch(base + path, {
    ...options, headers: { 'X-Forwarded-Proto': 'https', Authorization: auth, Origin: origin, ...headers }
  });
  const json = (path, body) => request(path, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
  });
  assert.equal((await request('/dgca?__dgca_route=health')).status, 200);
  assert.equal((await request('/health', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 400);
  assert.equal((await request('/monitor/trigger', { method: 'POST', headers: { Authorization: '' } })).status, 401);
  assert.equal((await request('/monitor/trigger', { method: 'POST', headers: { Origin: 'https://unknown.example.test' } })).status, 403);
  assert.equal((await request('/monitor/scheduled', { method: 'POST' })).status, 404);

  const pdf = fullSizePdf();
  const opened = await json('/compare/upload-sessions', { name: 'fixture.pdf', bytes: pdf.length });
  assert.equal(opened.status, 201);
  const { id, chunkBytes } = await opened.json();
  assert.equal((await json('/compare/upload-sessions', { bytes: pdf.length + 1 })).status, 413);
  assert.equal((await request(`/compare/upload-sessions/${id}/finish`, { method: 'POST' })).status, 409);
  for (let start = 0, part = 0; start < pdf.length; start += chunkBytes, part++) {
    const data = pdf.subarray(start, start + chunkBytes);
    const put = bytes => request(`/compare/upload-sessions/${id}/${part}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes
    });
    assert.equal((await put(data)).status, 204);
    if (!part) {
      assert.equal((await put(data)).status, 204);
      assert.equal((await put(Buffer.alloc(data.length))).status, 409);
    }
  }
  const finish = async () => (await request(`/compare/upload-sessions/${id}/finish`, { method: 'POST' })).json();
  const upload = await finish();
  assert.deepEqual(await finish(), upload);
  assert.equal((await request(`/jobs/${upload.jobId}`, { headers: { Authorization: '' } })).status, 401);

  let scrapes = 0;
  let archiving = false;
  axios.request = async () => {
    scrapes++;
    return { data: '<html></html>' };
  };
  axios.post = async (_url, body) => ({
    data: body.includes('fetchRulebookContentDtlsList')
      ? '<table><tr><td colspan="5">SERIES A Test</td></tr><tr><td><a data-url="dynamicPdf/car-test">PART I</a></td><td>Issue 1</td><td>Crew Rest</td><td></td><td></td></tr></table>'
      : archiving
        ? '<div id="archiveData"><div class="sub-section"><p class="sub-heading">Archived Crew Fixture</p><p class="sub-content">10/10/2025</p></div></div>'
        : '<div class="sub-section"><p class="sub-heading">Crew Rest Fixture</p><p class="sub-content">23/11/2026</p></div>'
  });
  axios.get = async () => ({ data: pdf, headers: { 'content-type': 'application/pdf' } });
  const interrupted = await enqueueJob('test-email');
  await db.query("UPDATE dgca_jobs SET state = 'running' WHERE id = $1", [interrupted.id]);
  const date = new Date();
  const { monitoring } = await runWorker(date);
  assert.ok(monitoring.success);
  assert.equal(scrapes, 1);
  assert.ok((await runWorker(date)).monitoring.skipped);
  assert.equal(scrapes, 1);
  const uploaded = await (await request(`/jobs/${upload.jobId}`)).json();
  assert.equal(uploaded.status, 201, uploaded.chunk);
  const file = JSON.parse(uploaded.chunk);
  assert.equal(file.sizeBytes, 40 * 1024 * 1024);
  assert.equal(file.hasText, true);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM dgca_upload_chunks').get()).n, 0);
  assert.equal((await request(`/jobs/${interrupted.id}`).then(r => r.json())).status, 503);

  const { cars: [car] } = await (await request('/cars')).json();
  assert.ok(car.has_text);
  const comparison = `/compare?a=${file.id}&b=${encodeURIComponent(`car:${car.id}`)}`;
  const { jobId } = await request(comparison).then(r => r.json());
  assert.equal((await request(comparison).then(r => r.json())).jobId, jobId);
  archiving = true;
  assert.equal((await request('/archive/import', { method: 'POST' })).status, 202);
  assert.equal((await request('/archive/import', { method: 'POST' })).status, 409);
  const previous = await db.prepare('INSERT INTO car_history (car_id, pdf_text) VALUES ($1, $2) RETURNING id')
    .get(car.id, 'Prior CAR wording.');
  await db.query(`INSERT INTO car_changes (car_id, change, detail, previous_history_id, compare_pdf_url)
    SELECT id, 'amended', 'Amended fixture', $1, pdf_url FROM car_documents WHERE id = $2`, [previous.id, car.id]);
  assert.equal((await request('/cars/sync', { method: 'POST' })).status, 202);
  await runWorker(date);
  const result = await request(`/jobs/${jobId}`).then(r => r.json());
  assert.equal(JSON.parse(result.chunk).right.section, 'car');
  const archive = await request('/archive/status').then(r => r.json());
  assert.equal(archive.total, 4);
  assert.equal(archive.analysed, 4);
  assert.equal(archive.lastImport.added, 4);
  assert.ok(archive.lastImport.finishedAt);
  const { changes: [amended] } = await request('/cars').then(r => r.json());
  assert.match(amended.detail, /sentences added/);
  assert.ok(!Object.hasOwn(amended, 'previous_history_id'));

  const large = 'x'.repeat(3 * 1024 * 1024);
  await db.query('UPDATE updates SET summary = $1 WHERE id = (SELECT id FROM updates LIMIT 1)', [large]);
  const updates = await request('/updates');
  assert.equal(updates.headers.get('content-length'), null);
  assert.equal((await updates.json()).data.some(update => update.summary === large), true);
  assert.equal(await claimJob(), undefined);
});
