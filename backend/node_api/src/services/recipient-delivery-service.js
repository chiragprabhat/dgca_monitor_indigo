import { getDatabase, transaction } from '../config/database.js';
import { todayIST } from './priority-service.js';

const prefix = 'neon_email_delivery_v1:';
const retryDelay = 5 * 60_000;

export function activationTime(env = process.env, now = Date.now()) {
  const value = env.NEON_EMAIL_ACTIVATED_AT;
  if (env.EMAIL_NOTIFICATIONS_ENABLED !== 'true' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value ?? '')) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now && new Date(time).toISOString() === value ? time : null;
}

export function eligiblePublication(update, cutoff, now = Date.now()) {
  if (cutoff === null || (update.origin ?? 'monitor') !== 'monitor') return false;
  const raw = update.detected_at;
  const detected = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2} \d\d:\d\d:\d\d$/.test(raw)
    ? Date.parse(raw.replace(' ', 'T') + 'Z')
    : typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(raw) ? Date.parse(raw) : NaN;
  return Number.isFinite(detected) && detected >= cutoff && detected <= now &&
    update.publication_date === todayIST(detected) && update.publication_date === todayIST(now);
}

export async function savedEmailEnabled(db = getDatabase()) {
  const { rows: [row] } = await db.query("SELECT value FROM config WHERE key = 'emailEnabled'");
  return row?.value === 'true';
}

export function classifyDelivery(recipients, info, error) {
  const includes = (list, address) => Array.isArray(list) &&
    list.some(value => typeof value === 'string' && value.toLowerCase() === address);
  const outcomes = {};
  for (const address of recipients) {
    if (!error && includes(info?.accepted, address) &&
        !includes(info?.rejected, address) && !includes(info?.pending, address)) {
      outcomes[address] = { state: 'accepted' };
    } else if (!error && includes(info?.pending, address)) {
      outcomes[address] = { state: 'pending' };
    } else if (includes((info ?? error)?.rejected, address)) {
      const detail = (info ?? error).rejectedErrors?.find(item => item.recipient?.toLowerCase() === address);
      outcomes[address] = { state: 'rejected', retryable: detail?.responseCode >= 400 && detail.responseCode < 500 };
    } else if (error?.code === 'ETIMEDOUT' && ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT'].includes(error.timeoutType)) {
      outcomes[address] = { state: 'rejected', retryable: true };
    } else if (error?.code === 'EAUTH' || ['EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM'].includes(error?.command)) {
      outcomes[address] = { state: 'rejected', retryable: error.code !== 'EAUTH' &&
        error.responseCode >= 400 && error.responseCode < 500 };
    } else {
      // A disconnect during DATA can follow acceptance. An accepted RCPT in a thrown
      // transaction is also insufficient evidence that the message was accepted.
      outcomes[address] = { state: 'ambiguous' };
    }
  }
  return outcomes;
}

export async function claimRecipients(id, recipients, cutoff, retry = false, now = Date.now()) {
  return transaction(async db => {
    const { rows: [update] } = await db.query('SELECT * FROM updates WHERE id=$1 FOR UPDATE', [id]);
    if (!update || !eligiblePublication(update, cutoff, now) || !await savedEmailEnabled(db)) return null;
    const key = prefix + id;
    const { rows: [record] } = await db.query('SELECT value FROM config WHERE key=$1 FOR UPDATE', [key]);
    let ledger;
    let addresses;
    if (record) {
      if (!retry || update.is_notified) return null;
      ledger = JSON.parse(record.value);
      addresses = Object.keys(ledger.recipients).filter(address => {
        const entry = ledger.recipients[address];
        return recipients.includes(address) && entry.state === 'rejected' && entry.retryable === true &&
          entry.attempts === 1 && now - entry.at >= retryDelay;
      });
    } else {
      if (retry || update.email_delivery_started_at || update.email_status || update.is_notified ||
          (await db.query("SELECT 1 FROM notifications WHERE update_id=$1 AND status='sent' LIMIT 1", [id])).rowCount) return null;
      addresses = recipients;
      ledger = { version: 1, recipients: Object.fromEntries(recipients.map(address => [address, { attempts: 0 }])) };
      await db.query('UPDATE updates SET email_delivery_started_at=dgca_utc_now() WHERE id=$1', [id]);
    }
    if (!addresses.length) return null;
    for (const address of addresses) {
      ledger.recipients[address] = { state: 'ambiguous', attempts: ledger.recipients[address].attempts + 1, at: now };
    }
    const claim = JSON.stringify(ledger);
    await db.query(`INSERT INTO config (key,value) VALUES ($1,$2)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=dgca_utc_now()`, [key, claim]);
    return { key, claim, ledger, addresses };
  });
}

export async function recordDelivery(id, attempt, outcomes) {
  return transaction(async db => {
    // Take locks in the same order as claimRecipients.
    await db.query('SELECT 1 FROM updates WHERE id=$1 FOR UPDATE', [id]);
    for (const address of attempt.addresses) Object.assign(attempt.ledger.recipients[address], outcomes[address]);
    const changed = await db.query('UPDATE config SET value=$1,updated_at=dgca_utc_now() WHERE key=$2 AND value=$3',
      [JSON.stringify(attempt.ledger), attempt.key, attempt.claim]);
    if (changed.rowCount !== 1) throw new Error('Delivery claim changed before outcome was recorded');
    const entries = Object.entries(attempt.ledger.recipients);
    const accepted = entries.filter(([, entry]) => entry.state === 'accepted').length;
    const success = accepted === entries.length;
    const status = success ? 'sent' : accepted ? 'partial' : 'failed';
    await db.query('INSERT INTO notifications (update_id,recipient_email,status,error_message) VALUES ($1,$2,$3,$4)',
      [id, attempt.addresses.join(', '), status, success ? null : 'One or more recipients require delivery review']);
    if (success) await db.query('UPDATE updates SET is_notified=1,notified_at=dgca_utc_now() WHERE id=$1', [id]);
    await db.query('UPDATE updates SET email_status=$1 WHERE id=$2', [status, id]);
    return { success, accepted, total: entries.length, results: Object.fromEntries(entries.map(([address, entry]) => [address, entry.state])) };
  });
}
