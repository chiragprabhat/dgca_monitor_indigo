import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { getDatabase } from '../config/database.js';
import { getSchedulerStatus } from '../services/scheduler-service.js';
import { getEmailConfiguration } from '../services/notification-service.js';
import { getSummaryEngineStatus } from '../services/summary-service.js';

const router = express.Router();

// Live status of each component, for the Overview "System Health" panel.
router.get('/health', async (req, res, next) => {
  try {
    const db = getDatabase();
    let database;
    try {
      const count = (await db.prepare('SELECT COUNT(*) AS n FROM updates').get()).n;
      database = { ok: true, detail: `${count} publications stored` };
    } catch (error) {
      database = { ok: false, detail: error.message };
    }

    const scheduler = await getSchedulerStatus();
    const lastRun = await db.prepare('SELECT * FROM monitoring_logs ORDER BY run_at DESC NULLS LAST, id DESC LIMIT 1').get();
    const monitoring = {
      ok: scheduler.running && (!lastRun || lastRun.status === 'success'),
      detail: !scheduler.running ? 'Scheduler not running'
        : !lastRun ? `Every ${scheduler.intervalMinutes} min - no check yet`
        : lastRun.status === 'success' ? `Every ${scheduler.intervalMinutes} min - last check OK`
        : `Last check failed: ${lastRun.error_message || 'unknown error'}`,
      lastRunAt: lastRun?.run_at || null
    };

    const docs = await db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN pdf_text IS NOT NULL THEN 1 ELSE 0 END) AS read,
             SUM(CASE WHEN pdf_text IS NOT NULL AND LENGTH(pdf_text) > 80 THEN 1 ELSE 0 END) AS "withText"
      FROM updates
    `).get();
    const engines = await getSummaryEngineStatus();
    const engineLabel = { claude: 'Claude AI', ollama: `local model (${engines.ollama.model})`, basic: 'built-in text summary' }[engines.active];
    const documents = {
      ok: !docs.read || docs.withText > 0,
      detail: !docs.read
        ? `PDFs not read yet - summaries: ${engineLabel}`
        : `${docs.withText} of ${docs.read} PDFs have readable text${docs.read > docs.withText ? ` (${docs.read - docs.withText} scanned)` : ''} - summaries: ${engineLabel}`
    };

    const emailCfg = await getEmailConfiguration();
    const email = {
      ok: !emailCfg.enabled || (emailCfg.isConfigured && !(emailCfg.lastFailed && (!emailCfg.lastSent || emailCfg.lastFailed.sent_at > emailCfg.lastSent.sent_at))),
      enabled: emailCfg.enabled,
      detail: !emailCfg.enabled ? 'Alerts turned off'
        : !emailCfg.isConfigured ? 'Turned on but sender or recipients missing'
        : emailCfg.lastFailed && (!emailCfg.lastSent || emailCfg.lastFailed.sent_at > emailCfg.lastSent.sent_at) ? `Last send failed: ${emailCfg.lastFailed.error_message}`
        : `On - ${emailCfg.recipients.length} recipient${emailCfg.recipients.length === 1 ? '' : 's'}`
    };

    res.json({ database, monitoring, documents, email, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.get('/storage', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const count = async table => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;
  const { sizeBytes } = await db.prepare(`
    SELECT SUM(pg_total_relation_size(name::regclass))::bigint AS "sizeBytes"
    FROM unnest(ARRAY['updates', 'notifications', 'monitoring_logs', 'config', 'settings_log',
      'review_log', 'car_documents', 'car_history', 'car_changes', 'uploaded_documents']) AS tables(name)
  `).get();
  res.json({
    publications: await count('updates'),
    emails: await count('notifications'),
    checks: await count('monitoring_logs'),
    settingsChanges: await count('settings_log'),
    sizeBytes,
    oldestPublication: (await db.prepare('SELECT MIN(publication_date) AS d FROM updates').get()).d,
    timestamp: new Date().toISOString()
  });
}));

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/export.csv', asyncRoute(async (req, res) => {
  const rows = await getDatabase().prepare(`
    SELECT publication_date, section, priority, priority_reason, title, summary, deadline, email_status, pdf_urls, detected_at
    FROM updates ORDER BY publication_date DESC NULLS LAST
  `).all();
  const header = ['Published', 'Category', 'Priority', 'Priority reason', 'Title', 'Summary', 'Deadline', 'Email status', 'PDF', 'Detected at'];
  const lines = [header.join(',')];
  for (const r of rows) {
    let pdf = '';
    try { pdf = JSON.parse(r.pdf_urls || '[]')[0] || ''; } catch { pdf = ''; }
    lines.push([r.publication_date, r.section, r.priority, r.priority_reason, r.title, r.summary, r.deadline, r.email_status, pdf, r.detected_at].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dgca-publications-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

export default router;
