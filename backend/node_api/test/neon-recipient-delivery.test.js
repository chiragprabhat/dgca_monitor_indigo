import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import test from 'node:test';
import nodemailer from 'nodemailer';
import pg from 'pg';

const fixtureUrl = process.env.DGCA_RECIPIENT_TEST_DATABASE_URL;
const [first, second] = ['one@example.invalid', 'two@example.invalid'];
const recipientList = [first, second];
const fixtureHost = 'ep-morning-hall-be8rl9fd.c-9.us-east-2.aws.neon.tech';

test('Neon email gate, recipient journal and job recovery on disposable PostgreSQL fixtures', { skip: !fixtureUrl }, async t => {
  const url = new URL(fixtureUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert.ok(local || (url.hostname === fixtureHost && url.pathname === '/neondb' &&
    url.username === 'neondb_owner' && !url.port), 'Use loopback or the confirmed deployment-test endpoint');
  for (const key of [...url.searchParams.keys()]) assert.ok(['sslmode', 'channel_binding'].includes(key));
  if (!local) url.search = '';
  const admin = new pg.Client({ connectionString: url.href, ...(local ? {} : { ssl: { rejectUnauthorized: true } }) });
  await admin.connect();
  let cleanFixture;
  t.after(async () => {
    try { await cleanFixture?.(); }
    finally { await admin.end(); }
  });
  if (!local) {
    const socket = admin.connection.stream;
    assert.ok(socket.encrypted && socket.authorized && !checkServerIdentity(fixtureHost, socket.getPeerCertificate()));
    const { rows: [identity] } = await admin.query(`SELECT current_setting('neon.project_id') AS project,
      current_setting('neon.branch_id') AS branch, current_setting('neon.endpoint_id') AS endpoint`);
    assert.deepEqual(identity, { project: 'tiny-sea-21255890', branch: 'br-plain-pine-belvpen0', endpoint: 'ep-morning-hall-be8rl9fd' });
  }

  const schema = 'recipient_test_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  cleanFixture = () => admin.query('DROP SCHEMA ' + schema + ' CASCADE');
  url.searchParams.set('options', '-c search_path=' + schema);
  delete process.env.VERCEL;
  Object.assign(process.env, {
    DATABASE_URL: url.href, DGCA_NEON_RUNTIME: '1', EMAIL_NOTIFICATIONS_ENABLED: 'true', USE_WINDOWS_CERTS: 'false',
    NEON_EMAIL_ACTIVATED_AT: new Date(Date.now() - 60_000).toISOString(),
    NEON_GMAIL_APP_PASSWORD: 'a'.repeat(16), SUMMARY_PROVIDER: 'basic'
  });
  const { closeDatabase, getDatabase, initializeDatabase } = await import('../src/config/database.js');
  cleanFixture = async () => {
    try { await closeDatabase(); }
    finally { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); }
  };
  await initializeDatabase();
  const db = getDatabase();
  await db.query(await readFile(new URL('../src/config/deployment.sql', import.meta.url), 'utf8'));
  const { todayIST } = await import('../src/services/priority-service.js');
  const { sendNotification, testEmailConnection } = await import('../src/services/notification-service.js');
  const { processActionsJob } = await import('../src/services/actions-worker.js');
  const { claimJob, enqueueJob, recoverJobs } = await import('../src/services/job-service.js');
  const { activationTime, claimRecipients } = await import('../src/services/recipient-delivery-service.js');
  await db.query("INSERT INTO config(key,value) VALUES ('recipients',$1),('emailEnabled','true')", [JSON.stringify(recipientList)]);

  const submissions = [];
  let simulate = to => ({ accepted: to, rejected: [] });
  let verified = 0;
  const transport = t.mock.method(nodemailer, 'createTransport', options => {
    assert.equal(options.host, 'smtp.gmail.com');
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.equal(options.tls.rejectUnauthorized, true);
    return {
      sendMail: async message => {
        submissions.push(message.envelope.to);
        return await simulate(message.envelope.to);
      },
      verify: async () => { verified++; return true; }
    };
  });
  const insert = async (observed = Date.now(), publicationDate = todayIST(observed), origin = 'monitor') => {
    const { rows: [row] } = await db.query(`INSERT INTO updates(id,title,section,publication_date,detected_at,origin)
      VALUES($1,'Synthetic fixture','regulation',$2,$3,$4) RETURNING *`,
    [randomUUID(), publicationDate, new Date(observed).toISOString(), origin]);
    return row;
  };
  const ledger = async row => {
    const result = await db.prepare('SELECT value FROM config WHERE key=$1').get('neon_email_delivery_v1:' + row.id);
    return result && JSON.parse(result.value);
  };
  const deliver = (row, options = {}) => sendNotification(row, { automatic: true, ...options });

  await t.test('both gates and historical cutoff prevent SMTP use', async () => {
    const row = await insert();
    await db.query("DELETE FROM config WHERE key='emailEnabled'");
    assert.equal((await deliver(row)).skipped, true);
    assert.equal((await testEmailConnection()).success, false);
    await db.query("INSERT INTO config VALUES ('emailEnabled','true')");
    process.env.EMAIL_NOTIFICATIONS_ENABLED = 'false';
    assert.equal((await deliver(row)).skipped, true);
    assert.equal((await testEmailConnection()).success, false);
    process.env.EMAIL_NOTIFICATIONS_ENABLED = 'true';
    assert.equal(activationTime({ EMAIL_NOTIFICATIONS_ENABLED: 'true', NEON_EMAIL_ACTIVATED_AT: '2026-11-99T00:00:00.000Z' }), null);
    for (const excluded of [
      await insert(Date.now() - 120_000),
      await insert(Date.now(), '2020-01-01'),
      await insert(Date.now(), todayIST(), 'archive')
    ]) {
      assert.equal((await deliver(excluded)).skipped, true);
      assert.equal(await ledger(excluded), undefined);
    }
    assert.equal(transport.mock.callCount(), 0);
    assert.equal(verified, 0);
  });

  await t.test('an eligible new publication delivers once under concurrent execution', async () => {
    const row = await insert();
    const results = await Promise.all([deliver(row), deliver(row)]);
    assert.equal(results.filter(result => result.success).length, 1);
    assert.deepEqual(submissions, [recipientList]);
    assert.equal((await ledger(row)).recipients[second].state, 'accepted');
    assert.equal((await db.prepare('SELECT is_notified FROM updates WHERE id=$1').get(row.id)).is_notified, 1);
  });

  await t.test('partial acceptance stays partial and an explicit retry excludes accepted recipients', async () => {
    const row = await insert();
    simulate = () => ({ accepted: [first], rejected: [second], rejectedErrors: [{ recipient: second, responseCode: 450 }] });
    assert.equal((await deliver(row)).success, false);
    assert.equal((await db.prepare('SELECT status FROM notifications WHERE update_id=$1').get(row.id)).status, 'partial');
    assert.equal((await db.prepare('SELECT is_notified FROM updates WHERE id=$1').get(row.id)).is_notified, 0);
    assert.equal((await deliver(row, { automatic: false, retry: true })).alreadyAttempted, true);
    const record = await ledger(row);
    record.recipients[second].at -= 5 * 60_000;
    await db.query('UPDATE config SET value=$1 WHERE key=$2', [JSON.stringify(record), 'neon_email_delivery_v1:' + row.id]);
    simulate = to => ({ accepted: to, rejected: [] });
    assert.equal((await deliver(row, { automatic: false, retry: true })).success, true);
    assert.deepEqual(submissions.at(-1), [second]);
    assert.equal((await ledger(row)).recipients[first].attempts, 1);
  });

  const smtpError = props => Object.assign(new Error('Synthetic SMTP fixture'), props);
  for (const [name, result, state, retryable] of [
    ['both rejected', () => { throw smtpError({ code: 'EENVELOPE', rejected: recipientList,
      rejectedErrors: recipientList.map(recipient => ({ recipient, responseCode: 550 })) }); }, 'rejected', false],
    ['authentication failure', () => { throw smtpError({ code: 'EAUTH' }); }, 'rejected', false],
    ['connection timeout before delivery', () => { throw smtpError({ code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'CONNECT_TIMEOUT' }); }, 'rejected', true],
    ['socket timeout with an ambiguous CONN label', () => { throw smtpError({ code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' }); }, 'ambiguous', undefined],
    ['ambiguous submission', () => { throw smtpError({ code: 'ETIMEDOUT', command: 'DATA', accepted: recipientList }); }, 'ambiguous', undefined],
    ['pending acceptance', () => ({ accepted: [], rejected: [], pending: recipientList }), 'pending', undefined]
  ]) {
    await t.test(name, async () => {
      const row = await insert();
      simulate = result;
      assert.equal((await deliver(row)).success, false);
      const entry = (await ledger(row)).recipients[first];
      assert.equal(entry.state, state);
      assert.equal(entry.retryable, retryable);
      assert.equal((await deliver(row)).alreadyAttempted, true);
    });
  }

  await t.test('pending mail jobs predating activation and recovered interrupted email jobs stay blocked', async () => {
    const { id: oldId } = await enqueueJob('test-email', { id: (await insert()).id });
    await db.query("UPDATE dgca_jobs SET created_at=now()-interval '5 minutes' WHERE id=$1", [oldId]);
    await processActionsJob(await claimJob(oldId), () => {});
    assert.equal((await db.prepare('SELECT status FROM dgca_jobs WHERE id=$1').get(oldId)).status, 409);
    const { id: interrupted } = await enqueueJob('smtp-check');
    await claimJob(interrupted);
    const sent = submissions.length;
    await recoverJobs();
    assert.equal(await claimJob(interrupted), undefined);
    assert.equal((await db.prepare('SELECT state FROM dgca_jobs WHERE id=$1').get(interrupted)).state, 'failed');
    assert.equal(submissions.length, sent);
    assert.equal(verified, 0);
  });

  await t.test('termination after claiming preserves ambiguity and prevents a repeat submission', async () => {
    const row = await insert();
    const sends = submissions.length;
    assert.ok(await claimRecipients(row.id, recipientList, activationTime()));
    assert.equal((await ledger(row)).recipients[first].state, 'ambiguous');
    assert.equal((await deliver(row)).alreadyAttempted, true);
    assert.equal((await deliver(row, { automatic: false, retry: true })).alreadyAttempted, true);
    assert.equal(submissions.length, sends);
  });
});
