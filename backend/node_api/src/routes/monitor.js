import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { checkForUpdates } from '../services/monitor-service.js';
import { getGitHubMonitoringSlot, getSchedulerStatus } from '../services/scheduler-service.js';
import { getRecentLogs } from '../services/state-service.js';
import { testEmailConnection, isEmailEnabled } from '../services/notification-service.js';
import { getDatabase } from '../config/database.js';
import { queueRoute } from '../services/job-service.js';

const router = express.Router();

export const scheduledMonitor = asyncRoute(async (req, res) => {
  const scheduledSlot = await getGitHubMonitoringSlot();
  if (!scheduledSlot) return res.status(202).json({ accepted: false, reason: 'Outside the monitoring window' });

  // The long-running host continues the check after the Actions job receives its acknowledgement.
  const result = await checkForUpdates({
    scheduledSlot,
    onScheduledStart: () => res.status(202).json({ accepted: true })
  });
  if (res.headersSent) return;
  if (result.skipped) return res.status(202).json({ accepted: false, reason: result.reason });
  res.status(503).json({ accepted: false, reason: 'Unable to start monitoring' });
});

router.post('/trigger', queueRoute('monitor'), async (req, res) => {
  try {
    const result = await checkForUpdates();
    res.json({
      success: result.success,
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/status', asyncRoute(async (req, res) => {
  const schedulerStatus = await getSchedulerStatus();
  const logs = await getRecentLogs(5);

  res.json({
    scheduler: schedulerStatus,
    email: { enabled: await isEmailEnabled() },
    recentRuns: logs,
    timestamp: new Date().toISOString()
  });
}));

const SETTING_LABELS = {
  emailEnabled: 'Email alerts', recipients: 'Recipients', sameDayOnly: 'Same-day only',
  categories: 'Alert categories', minPriority: 'Minimum priority', attachPdf: 'Attach PDF',
  intervalMinutes: 'Check interval (minutes)', summaryProvider: 'Summary engine'
};
const showValue = v => {
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.length ? parsed.join(', ') : '(none)';
    if (typeof parsed === 'boolean') return parsed ? 'on' : 'off';
    return String(parsed);
  } catch { return String(v); }
};
const isoUtc = sqlTime => `${String(sqlTime).replace(' ', 'T')}Z`;

// One timeline from monitoring runs, emails and settings changes.
router.get('/logs', asyncRoute(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const db = getDatabase();

  const runs = (await getRecentLogs(limit)).map(log => ({
    id: `run-${log.id}`,
    created_at: isoUtc(log.run_at),
    event_type: log.status === 'success' ? 'monitor-run' : 'system-error',
    result: log.status,
    details: log.error_message
      ? `Check failed: ${log.error_message}`
      : `Checked DGCA: ${log.items_found} publications, ${log.items_new} new (${(log.duration_ms / 1000).toFixed(1)} s)`
  }));

  const emails = (await db.prepare(`
    SELECT n.id, n.sent_at, n.status, n.recipient_email, n.error_message, u.title, u.priority
    FROM notifications n LEFT JOIN updates u ON u.id = n.update_id
    ORDER BY n.sent_at DESC NULLS LAST LIMIT NULLIF(GREATEST($1::bigint, -1), -1)
  `).all(limit)).map(n => ({
    id: `mail-${n.id}`,
    created_at: isoUtc(n.sent_at),
    event_type: n.status === 'sent' ? 'email-sent' : 'system-error',
    result: n.status === 'sent' ? 'success' : 'failed',
    details: n.status === 'sent'
      ? `Emailed ${n.priority ? `[${n.priority.toUpperCase()}] ` : ''}"${(n.title || 'publication').slice(0, 90)}" to ${n.recipient_email}`
      : `Email failed for "${(n.title || 'publication').slice(0, 70)}": ${n.error_message}`
  }));

  const changes = (await db.prepare('SELECT * FROM settings_log ORDER BY changed_at DESC NULLS LAST, id DESC LIMIT NULLIF(GREATEST($1::bigint, -1), -1)').all(limit)).map(c => ({
    id: `cfg-${c.id}`,
    created_at: isoUtc(c.changed_at),
    event_type: 'config-change',
    result: 'success',
    details: `${SETTING_LABELS[c.setting] || c.setting}: ${showValue(c.old_value)} → ${showValue(c.new_value)}`
  }));

  const STATUS_LABELS = { new: 'New', under_review: 'Under review', actioned: 'Actioned', not_applicable: 'Not applicable' };
  const reviews = (await db.prepare(`
    SELECT r.*, u.title FROM review_log r LEFT JOIN updates u ON u.id = r.update_id
    ORDER BY r.changed_at DESC NULLS LAST, r.id DESC LIMIT NULLIF(GREATEST($1::bigint, -1), -1)
  `).all(limit)).map(r => ({
    id: `review-${r.id}`,
    created_at: isoUtc(r.changed_at),
    event_type: 'review',
    result: 'success',
    details: `${r.owner || 'Someone'} marked "${(r.title || 'publication').slice(0, 80)}" as ${STATUS_LABELS[r.status] || r.status}${r.note ? ` - ${r.note.slice(0, 120)}` : ''}`
  }));

  const carChanges = (await db.prepare('SELECT * FROM car_changes ORDER BY detected_at DESC NULLS LAST, id DESC LIMIT NULLIF(GREATEST($1::bigint, -1), -1)').all(limit)).map(c => ({
    id: `car-${c.id}`,
    created_at: isoUtc(c.detected_at),
    event_type: 'car-change',
    result: 'success',
    details: c.detail
  }));

  const data = [...runs, ...emails, ...changes, ...reviews, ...carChanges]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
  res.json({ data, timestamp: new Date().toISOString() });
}));

router.get('/test-email', queueRoute('smtp-check'), async (req, res) => {
  try {
    const result = await testEmailConnection();
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
