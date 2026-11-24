import { getDatabase, transaction } from '../config/database.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('settings');

export const CATEGORIES = ['tenders', 'regulation', 'guidance', 'announcements'];
export const PRIORITIES = ['low', 'medium', 'high'];
export const INTERVALS = [15, 30, 60, 240];
export const PROVIDERS = ['auto', 'claude', 'ollama', 'basic'];

// Settings the dashboard can change. Passwords and API keys deliberately stay
// in .env only so they never travel through the browser.
function envDefaults() {
  const legacyHours = process.env.MONITOR_INTERVAL_HOURS ? parseInt(process.env.MONITOR_INTERVAL_HOURS, 10) * 60 : null;
  const recipients = (process.env.EMAIL_RECIPIENTS || process.env.EMAIL_RECIPIENT || process.env.EMAIL_FROM || '')
    .split(/[,;]/).map(s => s.trim()).filter(Boolean);
  return {
    emailEnabled: process.env.EMAIL_NOTIFICATIONS_ENABLED === 'true',
    recipients,
    sameDayOnly: process.env.EMAIL_SAME_DAY_ONLY !== 'false',
    categories: [...CATEGORIES],
    minPriority: 'low',
    attachPdf: true,
    intervalMinutes: parseInt(process.env.MONITOR_INTERVAL_MINUTES || '', 10) || legacyHours || 15,
    summaryProvider: (process.env.SUMMARY_PROVIDER || 'auto').toLowerCase()
  };
}

let cache = null;

async function readSettings(db) {
  const settings = envDefaults();
  try {
    for (const { key, value } of await db.prepare('SELECT key, value FROM config').all()) {
      if (key in settings) settings[key] = JSON.parse(value);
    }
  } catch (error) {
    logger.error('Could not read saved settings; using .env values', { error: error.message });
  }
  return settings;
}

export async function getSettings() {
  cache ??= readSettings(getDatabase());
  return cache;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function validate(key, value) {
  switch (key) {
    case 'emailEnabled':
    case 'sameDayOnly':
    case 'attachPdf':
      if (typeof value !== 'boolean') return 'must be true or false';
      return null;
    case 'recipients':
      if (!Array.isArray(value)) return 'must be a list of email addresses';
      if (value.length > 50) return 'at most 50 recipients';
      for (const r of value) if (typeof r !== 'string' || !EMAIL_RE.test(r)) return `not a valid email address: ${r}`;
      return null;
    case 'categories':
      if (!Array.isArray(value) || value.some(c => !CATEGORIES.includes(c))) return `must be a list drawn from ${CATEGORIES.join(', ')}`;
      return null;
    case 'minPriority':
      return PRIORITIES.includes(value) ? null : `must be one of ${PRIORITIES.join(', ')}`;
    case 'intervalMinutes':
      return INTERVALS.includes(value) ? null : `must be one of ${INTERVALS.join(', ')}`;
    case 'summaryProvider':
      return PROVIDERS.includes(value) ? null : `must be one of ${PROVIDERS.join(', ')}`;
    default:
      return 'is not a setting that can be changed here';
  }
}

// Applies a partial update. Returns { settings, changed } or throws with a list of errors.
export async function updateSettings(patch) {
  const errors = [];
  const clean = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    const value = key === 'recipients' && Array.isArray(raw)
      ? [...new Set(raw.map(r => String(r).trim()).filter(Boolean))]
      : raw;
    const problem = validate(key, value);
    if (problem) errors.push(`${key} ${problem}`);
    else clean[key] = value;
  }
  const changed = await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(13691, 3)');
    const current = await readSettings(db);
    if (clean.emailEnabled === true && (clean.recipients ?? current.recipients).length === 0) {
      errors.push('add at least one recipient before turning email alerts on');
    }
    if (errors.length) {
      const error = new Error(errors.join('; '));
      error.status = 400;
      throw error;
    }

    const changed = [];
    const upsert = db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES ($1, $2, dgca_utc_now())
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = dgca_utc_now()
    `);
    const log = db.prepare('INSERT INTO settings_log (setting, old_value, new_value) VALUES ($1, $2, $3)');
    for (const [key, value] of Object.entries(clean)) {
      const before = JSON.stringify(current[key]);
      const after = JSON.stringify(value);
      if (before === after) continue;
      await upsert.run(key, after);
      await log.run(key, before, after);
      changed.push(key);
    }
    return changed;
  });

  cache = null;
  if (changed.length) logger.info(`Settings changed: ${changed.join(', ')}`);
  return { settings: await getSettings(), changed };
}

export async function getSettingsLog(limit = 50) {
  return await getDatabase().prepare('SELECT * FROM settings_log ORDER BY changed_at DESC NULLS LAST, id DESC LIMIT NULLIF(GREATEST($1::bigint, -1), -1)').all(limit);
}
