import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAccessPolicy } from '../src/config/access.js';

function samplePdf() {
  const stream = 'BT /F1 12 Tf 20 70 Td (Flight crew rest requirements apply to every scheduled service during this synthetic verification.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return String(offset).padStart(10, '0') + ' 00000 n ';
  });
  return Buffer.from(pdf + `xref\n0 6\n0000000000 65535 f \n${offsets.join('\n')}\n` +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`);
}

test('production access fails closed with missing operator credentials or a shared trigger secret', () => {
  const password = randomUUID();
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://monitor.example.test',
    API_OPERATOR_USERNAME: 'operator',
    API_OPERATOR_PASSWORD: password
  };
  assert.throws(() => createAccessPolicy({ ...env, API_OPERATOR_PASSWORD: '' }), /API_OPERATOR_PASSWORD/);
  assert.throws(() => createAccessPolicy({
    ...env, MONITOR_SCHEDULER: 'github', MONITOR_TRIGGER_TOKEN: password
  }), /separate MONITOR_TRIGGER_TOKEN/);
  assert.throws(() => createAccessPolicy({ ...env, FRONTEND_URL: 'https://monitor.example.test/path' }), /FRONTEND_URL/);
  assert.doesNotThrow(() => createAccessPolicy(env));
  const local = createAccessPolicy({});
  let proxiedStatus;
  const response = { status(code) { proxiedStatus = code; return this; }, json() {} };
  local.requireHttps({ hostname: '127.0.0.1', get: name => name === 'x-forwarded-proto' ? 'https' : undefined },
    response, () => assert.fail('Forwarded request reached development API'));
  assert.equal(proxiedStatus, 503);
  let localAccess = false;
  local.requireHttps({ hostname: '127.0.0.1', get: () => undefined }, response, () => { localAccess = true; });
  assert.ok(localAccess);
});

const testDatabase = process.env.TEST_DATABASE_URL;
test('production HTTP access, scheduled slots and notification claims on PostgreSQL', { skip: !testDatabase }, async () => {
  const target = new URL(testDatabase);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname),
    'Express deployment tests require a disposable loopback PostgreSQL database');
  const origin = 'https://monitor.example.test';
  const password = randomUUID();
  const triggerToken = randomUUID();
  Object.assign(process.env, {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    DATABASE_URL: testDatabase,
    FRONTEND_URL: origin,
    API_OPERATOR_USERNAME: 'operator',
    API_OPERATOR_PASSWORD: password,
    MONITOR_SCHEDULER: 'github',
    MONITOR_TRIGGER_TOKEN: triggerToken,
    MONITOR_INTERVAL_MINUTES: '1440',
    MONITOR_START_HOUR: '0',
    MONITOR_END_HOUR: '23',
    EMAIL_NOTIFICATIONS_ENABLED: 'true',
    EMAIL_RECIPIENTS: 'fixture@example.test',
    EMAIL_FROM: 'fixture@example.test',
    SMTP_HOST: 'smtp.example.test',
    EMAIL_SAME_DAY_ONLY: 'false',
    SUMMARY_PROVIDER: 'basic'
  });
  delete process.env.VERCEL;
  const { default: axios } = await import('axios');
  const { default: nodemailer } = await import('nodemailer');
  let scrapeStarted;
  let releaseScrape;
  const started = new Promise(resolve => { scrapeStarted = resolve; });
  const proceed = new Promise(resolve => { releaseScrape = resolve; });
  let scrapes = 0;
  let sends = 0;
  const pdf = samplePdf();
  axios.request = async () => {
    scrapes++;
    scrapeStarted();
    await proceed;
    return { data: '<html></html>' };
  };
  axios.get = async () => ({ data: pdf, headers: { 'content-type': 'application/pdf' } });
  axios.post = async (_url, body) => ({
    data: body.includes('fetchRulebookContentDtlsList')
      ? '<table><tr><td colspan="5">SERIES A Test</td></tr><tr><td><a data-url="dynamicPdf/car-test">PART I</a></td><td>Issue 1</td><td>Crew Rest</td><td></td><td></td></tr></table>'
      : '<div class="sub-section"><p class="sub-heading">Crew Rest Verification Notice</p><p class="sub-content">23/11/2026</p></div>'
  });
  nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: `fixture-${++sends}` }) });

  const { default: app } = await import('../src/index.js');
  const { acquireMonitoringLock, closeDatabase, getDatabase } = await import('../src/config/database.js');
  const { claimEmailDelivery, getPendingEmailUpdates, saveUpdate } = await import('../src/services/state-service.js');
  const { getGitHubMonitoringSlot } = await import('../src/services/scheduler-service.js');
  const { updateSettings } = await import('../src/services/settings-service.js');
  const { syncCars } = await import('../src/services/car-service.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const basic = `Basic ${Buffer.from(`operator:${password}`).toString('base64')}`;
  const bearer = `Bearer ${triggerToken}`;
  const request = (path, { method = 'GET', headers = {}, tls = true, body } = {}) => fetch(base + path, {
    method,
    headers: { ...(tls ? { 'X-Forwarded-Proto': 'https' } : {}), ...headers },
    body
  });
  const schedule = () => request('/monitor/scheduled', { method: 'POST', headers: { Authorization: bearer } });

  try {
    assert.equal((await request('/health', { tls: false })).status, 400);
    assert.equal((await request('/updates')).status, 401);
    for (const [path, method] of [['/settings', 'PUT'], ['/compare/upload', 'POST'], ['/monitor/scheduled','POST']]) {
      assert.equal((await request(path, { method })).status, 401);
    }
    assert.equal((await request('/settings', { headers: { Authorization: bearer } })).status, 401);
    assert.equal((await request('/monitor/scheduled', { method: 'POST', headers: { Authorization: basic } })).status, 401);
    assert.equal((await request('/monitor/trigger', {
      method: 'POST', headers: { Authorization: basic, Origin: 'https://other.example.test' }
    })).status, 403);
    const preflight = await request('/compare/upload', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal((await request('/monitor/scheduled', {
      method: 'POST', headers: { Authorization: bearer, Origin: origin }
    })).status, 401);

    const first = await schedule();
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: true });
    await started;
    assert.deepEqual(await (await schedule()).json(), { accepted: false, reason: 'Monitor is busy' });
    const manual = await request('/monitor/trigger', { method: 'POST', headers: { Authorization: basic, Origin: origin } });
    assert.equal((await manual.json()).success, false);
    releaseScrape();
    // Wait for the async cycle to release its connection lock before inspecting output.
    let completedLock;
    for (let attempt = 0; attempt < 100 && !completedLock; attempt++) {
      completedLock = await acquireMonitoringLock();
      if (!completedLock) await delay(25);
    }
    assert.ok(completedLock);
    await completedLock.release();
    assert.deepEqual(await (await schedule()).json(), { accepted: false, reason: 'Slot already claimed' });
    assert.equal(scrapes, 1);
    assert.equal(sends, 4);

    const history = await request('/notifications/history', { headers: { Authorization: basic, Origin: origin } });
    assert.equal(history.status, 200);
    assert.equal(history.headers.get('cache-control'), 'no-store');
    assert.equal((await history.json()).data.length, 4);
    const found = await request('/search?q=crew', { headers: { Authorization: basic, Origin: origin } });
    assert.equal((await found.json()).total, 4);
    const updates = await request('/updates', { headers: { Authorization: basic, Origin: origin } });
    const { data: [publication] } = await updates.json();
    assert.ok(publication);
    assert.ok(!Object.hasOwn(publication, 'email_delivery_started_at'));
    const preview = await request(`/updates/${publication.id}/email-preview`, { headers: { Authorization: basic } });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-security-policy'), /default-src 'none'/);
    await getDatabase().query('UPDATE updates SET email_status = NULL, email_delivery_started_at = NULL WHERE id = $1',
      [publication.id]);
    assert.equal(await claimEmailDelivery(publication.id), false);

    const proposed = await saveUpdate({
      section: 'regulation', title: 'Interrupted email fixture', publicationDate: '2026-11-24'
    });
    const claims = await Promise.all([claimEmailDelivery(proposed.id), claimEmailDelivery(proposed.id)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.ok(!(await getPendingEmailUpdates()).some(row => row.id === proposed.id));

    const operatorHeaders = { Authorization: basic, Origin: origin };
    const upload = await request('/compare/upload?name=verification.pdf', {
      method: 'POST', headers: { ...operatorHeaders, 'Content-Type': 'application/pdf' }, body: pdf
    });
    assert.equal(upload.status, 201);
    const version = await upload.json();
    assert.equal((await syncCars()).read, 1);
    const { cars: [car] } = await (await request('/cars', { headers: operatorHeaders })).json();
    assert.ok(car.has_text);
    const compare = await request(`/compare?a=${version.id}&b=${encodeURIComponent(`car:${car.id}`)}`,
      { headers: operatorHeaders });
    assert.equal(compare.status, 200);
    assert.equal((await compare.json()).right.section, 'car');
    assert.equal((await request(`/compare/uploads/${version.id}`, { method: 'DELETE', headers: operatorHeaders })).status, 200);
    assert.equal((await request('/archive/status', { headers: operatorHeaders })).status, 200);

    await updateSettings({ intervalMinutes: 30 });
    assert.equal(await getGitHubMonitoringSlot(new Date('2026-11-24T03:06:00Z')), '2026-11-24T03:00:00.000Z');
    process.env.MONITOR_START_HOUR = '9';
    assert.equal(await getGitHubMonitoringSlot(new Date('2026-11-24T03:06:00Z')), null);
  } finally {
    releaseScrape();
    await new Promise(resolve => server.close(resolve));
    await closeDatabase();
  }
});
