import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { closeDatabase, getDatabase, transaction, verifyMonitoringSmokeConnection, withBackgroundSmokeDatabase } from '../src/config/database.js';
import { runInMonitoringSmokeTest } from '../src/config/monitoring-smoke-context.js';
import { smokeDatabaseTarget } from '../src/config/smoke-database-target.js';
import { CHUNK_BYTES } from '../src/services/chunk-upload-service.js';
import { claimJob, enqueueJob, recoverJobs } from '../src/services/job-service.js';
import { isEmailEnabled } from '../src/services/notification-service.js';
import { getSummaryProvider } from '../src/services/summary-service.js';
import { MAX_UPLOAD_BYTES } from '../src/services/upload-service.js';

const neon = process.env.DGCA_BACKGROUND_SMOKE_NEON === '1';
const testDatabase = process.env.TEST_DATABASE_URL;

test('the background-job workflow is dispatch-only and passes only the test database secret', async () => {
  const yaml = await readFile(new URL('../../../.github/workflows/dgca-background-job-smoke.yml', import.meta.url), 'utf8');
  assert.match(yaml, /^on:\s*\r?\n  workflow_dispatch:\s*\r?\npermissions:/m);
  assert.match(yaml, /vars\.DGCA_MONITOR_ENABLED == 'false'/);
  assert.deepEqual(Array.from(yaml.matchAll(/secrets\.(\w+)/g), ([, name]) => name), ['DEPLOYMENT_TEST_DATABASE_URL']);
});

function databaseTarget() {
  if (neon) {
    assert.equal(process.env.DGCA_MONITOR_ENABLED === 'false', true, 'Recurring monitoring must remain disabled');
    return smokeDatabaseTarget(process.env);
  }
  const url = new URL(testDatabase);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Test PostgreSQL must be on loopback');
  return { hostname: url.hostname, connectionString: url.href };
}

function fixturePdf(text, size) {
  const stream = `BT /F1 12 Tf 20 70 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let document = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = document.length;
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const index = 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n';
  const offset = size ? size - index.length - 17 : document.length;
  const end = String(offset).padStart(10, '0') + '\n%%EOF\n';
  return Buffer.concat([Buffer.from(document), Buffer.alloc(offset - document.length, 32), Buffer.from(index + end)]);
}

function installNetworkFixtures(t) {
  const pdf = fixturePdf('Synthetic fixture for background processing. Crew scheduling only tests the extracted text and differences.');
  let carRevision = 1;
  t.mock.method(nodemailer, 'createTransport', () => assert.fail('SMTP transport is forbidden'));
  t.mock.method(axios, 'request', () => assert.fail('Live DGCA monitoring is forbidden'));
  t.mock.method(axios, 'post', async (url, body) => {
    assert.equal(new URL(url).hostname, 'www.dgca.gov.in');
    if (body.includes('fetchRulebookContentDtlsList')) {
      return { data: `<table><tr><td colspan="5">SERIES A Test</td></tr><tr><td><a data-url="dynamicPdf/fixture-${carRevision}">PART I</a></td><td>Issue ${carRevision}</td><td>Synthetic CAR</td><td></td><td></td></tr></table>` };
    }
    assert.match(body, /actionVal=/);
    return { data: '<div id="archiveData"><div class="sub-section"><p class="sub-heading">Synthetic archive fixture</p><p class="sub-content">10/10/2025</p></div></div>' };
  });
  t.mock.method(axios, 'get', async url => {
    assert.equal(new URL(url).hostname, 'www.dgca.gov.in');
    assert.match(url, /fixture-[12]/);
    return { data: pdf, headers: { 'content-type': 'application/pdf' } };
  });
  return () => { carRevision++; };
}

test('background jobs run through serverless routes and worker handlers in a rollback-only schema', {
  skip: !neon && !testDatabase,
  timeout: 240000
}, async t => {
  const target = databaseTarget();
  const amendCar = installNetworkFixtures(t);
  const origin = 'https://smoke.example.test';
  const password = randomUUID();
  Object.assign(process.env, {
    VERCEL: '1', FRONTEND_URL: origin, API_OPERATOR_USERNAME: 'operator',
    API_OPERATOR_PASSWORD: password, DOTENV_CONFIG_PATH: '.dgca-smoke-env-intentionally-absent'
  });
  await runInMonitoringSmokeTest(target, async () => {
    try {
      if (neon) await verifyMonitoringSmokeConnection();
      await withBackgroundSmokeDatabase(async namespace => {
        const db = getDatabase();
        assert.deepEqual((await db.prepare('SELECT current_schemas(false)::text[] AS names').get()).names,
          [namespace, 'pg_catalog']);
        await db.query(`INSERT INTO config(key,value) VALUES ('emailEnabled','true'),('summaryProvider','"claude"')`);
        assert.equal(await isEmailEnabled(), false);
        assert.equal(await getSummaryProvider(), 'basic');
        const { default: handler } = await import('../../../api/dgca.mjs');
        const { processActionsJob } = await import('../src/services/actions-worker.js');
        const inScratch = AsyncLocalStorage.snapshot();
        const server = createServer((req, res) => inScratch(handler, req, res)).listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
          const base = `http://127.0.0.1:${server.address().port}/api`;
          const basic = `Basic ${Buffer.from(`operator:${password}`).toString('base64')}`;
          const request = (path, { headers, ...options } = {}) => fetch(base + path, {
            ...options, signal: AbortSignal.timeout(45000),
            headers: { Authorization: basic, Origin: origin, 'X-Forwarded-Proto': 'https', ...headers }
          });
          const result = id => request(`/jobs/${id}`).then(r => r.json());
          const enqueue = async (path, method = 'POST') => {
            const response = await request(path, { method });
            assert.equal(response.status, 202);
            return response.json();
          };
          const runJob = async (id, kind) => {
            const job = await claimJob(id);
            assert.equal(job.kind, kind);
            assert.equal(job.id, id);
            assert.equal((await result(id)).state, 'running');
            assert.equal(await claimJob(id), undefined);
            delete process.env.VERCEL;
            try { await processActionsJob(job, () => {}); } finally { process.env.VERCEL = '1'; }
            const completed = await result(id);
            assert.equal(completed.state, 'done', completed.chunk);
            return { ...completed, body: JSON.parse(completed.chunk) };
          };

          const email = await enqueueJob('test-email');
          const unrelated = await enqueueJob('compare', { fixture: 'unrelated' });
          console.log('Checking chunk transport and upload cleanup');
          const fullPdf = fixturePdf('Synthetic upload. This publication fixture tests extraction without storing or fetching a real document.', MAX_UPLOAD_BYTES);
          const open = bytes => request('/compare/upload-sessions', {
            method: 'POST', body: JSON.stringify({ name: 'synthetic-background.pdf', bytes }),
            headers: { 'Content-Type': 'application/json' }
          });
          assert.equal((await open(fullPdf.length + 1)).status, 413);
          const opening = await open(fullPdf.length);
          assert.equal(opening.status, 201);
          const { id: upload, chunkBytes } = await opening.json();
          assert.equal(chunkBytes, CHUNK_BYTES);
          const finish = `/compare/upload-sessions/${upload}/finish`;
          assert.equal((await request(finish, { method: 'POST' })).status, 409);
          let chunks = 0;
          for (let start = 0; start < fullPdf.length; start += chunkBytes) {
            const put = body => request(`/compare/upload-sessions/${upload}/${chunks}`, {
              method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' }
            });
            const bytes = fullPdf.subarray(start, start + chunkBytes);
            assert.equal((await put(bytes)).status, 204);
            if (chunks === 0) assert.equal((await put(bytes)).status, 204);
            chunks++;
          }
          assert.equal(chunks, 14);
          const { jobId: uploadJob } = await enqueue(finish);
          assert.deepEqual(await enqueue(finish), { jobId: uploadJob });
          assert.equal((await result(uploadJob)).state, 'queued');
          assert.equal((await request(`/jobs/${uploadJob}`, { headers: { Authorization: '' } })).status, 401);
          const uploaded = await runJob(uploadJob, 'upload');
          assert.equal(uploaded.status, 201);
          assert.equal(uploaded.body.sizeBytes, MAX_UPLOAD_BYTES);
          assert.equal(uploaded.body.hasText, true);
          assert.equal((await db.prepare('SELECT count(*) AS n FROM dgca_upload_chunks').get()).n, 0);
          assert.equal((await db.prepare('SELECT count(*) AS n FROM dgca_upload_sessions').get()).n, 0);
          const stalledPdf = fixturePdf('Synthetic abandoned upload.');
          const stalled = await open(stalledPdf.length).then(response => response.json());
          assert.equal((await request(`/compare/upload-sessions/${stalled.id}/0`, {
            method: 'PUT', body: stalledPdf, headers: { 'Content-Type': 'application/octet-stream' }
          })).status, 204);
          await db.query("UPDATE dgca_upload_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1", [stalled.id]);

          console.log('Checking bounded CAR refresh and comparison recovery');
          const carJob = async () => {
            await enqueue('/cars/sync');
            assert.equal((await request('/cars/sync', { method: 'POST' })).status, 409);
            const { id } = await db.prepare("SELECT id FROM dgca_jobs WHERE kind = 'car' AND state = 'queued'").get();
            return runJob(id, 'car');
          };
          assert.equal((await carJob()).body.added, 1);
          amendCar();
          assert.equal((await carJob()).body.updated, 1);
          const { cars: [car], changes: [change] } = await request('/cars').then(r => r.json());
          assert.ok(car.has_text);
          assert.match(change.detail, /sentences added/);

          const comparison = `/compare?a=${encodeURIComponent(uploaded.body.id)}&b=${encodeURIComponent(`car:${car.id}`)}`;
          const { jobId: compare } = await enqueue(comparison, 'GET');
          assert.deepEqual(await enqueue(comparison, 'GET'), { jobId: compare });
          assert.ok(await claimJob(compare));
          const expired = await enqueueJob('compare', { fixture: 'expired' });
          await db.query("UPDATE dgca_jobs SET created_at = now() - interval '2 days' WHERE id = $1", [expired.id]);
          await recoverJobs(); // Only the scratch schema is visible.
          assert.equal((await db.prepare('SELECT count(*) AS n FROM dgca_upload_sessions').get()).n, 0);
          assert.equal((await db.prepare('SELECT count(*) AS n FROM dgca_upload_chunks').get()).n, 0);
          assert.equal((await result(compare)).state, 'queued');
          assert.equal((await result(expired.id)).status, 410);
          const comparisonResult = await runJob(compare, 'compare');
          assert.equal(comparisonResult.body.right.section, 'car');
          assert.ok(comparisonResult.body.chunks.length);

          console.log('Checking bounded archive import and basic analysis');
          await enqueue('/archive/import');
          assert.equal((await request('/archive/import', { method: 'POST' })).status, 409);
          const { id: archiveJob } = await db.prepare("SELECT id FROM dgca_jobs WHERE kind = 'archive'").get();
          const archived = await runJob(archiveJob, 'archive');
          assert.equal(archived.body.lastImport.added, 4);
          const checkpoint = await db.prepare('SELECT input FROM dgca_jobs WHERE id = $1').get(archiveJob);
          assert.equal(Object.keys(checkpoint.input.progress.perSection).length, 4);
          const archiveAnalysis = await enqueueJob('archive-analysis');
          await runJob(archiveAnalysis.id, 'archive-analysis');
          const status = await request('/archive/status').then(r => r.json());
          assert.equal(status.analysed, 4);
          assert.equal((await db.prepare("SELECT count(*) AS n FROM updates WHERE summary_source = 'basic'").get()).n, 4);

          await assert.rejects(transaction(async tx => {
            await tx.query("SET LOCAL statement_timeout = '50ms'");
            await tx.query('SELECT pg_sleep(1)');
          }), { code: '57014' });
          assert.equal((await db.prepare('SELECT count(*) AS n FROM notifications').get()).n, 0);
          assert.equal((await result(email.id)).state, 'queued');
          assert.equal((await result(unrelated.id)).state, 'queued');
        } finally {
          await new Promise(resolve => server.close(resolve));
        }
      });
      console.log(JSON.stringify({ outcome: 'background-jobs-verified', bytes: MAX_UPLOAD_BYTES, chunks: 14,
        archivePublications: 4, carRevisions: 2, rolledBack: true, emailAttempts: 0 }));
    } catch (error) {
      if (!neon) throw error;
      // Hostnames, SQL connection inputs and credentials stay out of hosted failure logs.
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{3,25}$/.test(error.code) ? error.code : 'ASSERTION_OR_SETUP';
      throw new Error(`Background smoke test failed (${code})`);
    } finally {
      await closeDatabase();
    }
  });
});

test('the scratch schema rolls back on callback failure and database session timeout', {
  skip: neon || !testDatabase
}, async () => {
  await runInMonitoringSmokeTest(databaseTarget(), async () => {
    try {
      for (const timedOut of [false, true]) {
        let scratch;
        let scopedDatabase;
        let backendPid;
        await assert.rejects(withBackgroundSmokeDatabase(async namespace => {
          scratch = namespace;
          scopedDatabase = getDatabase();
          await scopedDatabase.query("INSERT INTO config(key,value) VALUES ('synthetic-rollback-fixture','true')");
          if (!timedOut) throw new Error('Injected smoke failure');
          backendPid = (await scopedDatabase.prepare('SELECT pg_backend_pid() AS pid').get()).pid;
          await scopedDatabase.query("SET LOCAL idle_in_transaction_session_timeout = '100ms'");
          await delay(350);
          await scopedDatabase.query('SELECT 1');
        }), timedOut ? error => error.code === '25P03' || error.message === 'Connection terminated unexpectedly'
          : /Injected smoke failure/);
        assert.ok(scratch);
        await assert.rejects(async () => scopedDatabase.query('SELECT 1'), /database scope has closed/);
        const result = await getDatabase().prepare('SELECT to_regnamespace($1) AS namespace').get(scratch);
        assert.equal(result.namespace, null);
        if (timedOut) {
          assert.ok(backendPid);
          const session = await getDatabase().prepare('SELECT pid FROM pg_stat_activity WHERE pid = $1').get(backendPid);
          assert.equal(session, undefined);
        }
      }
    } finally {
      await closeDatabase();
    }
  });
});
