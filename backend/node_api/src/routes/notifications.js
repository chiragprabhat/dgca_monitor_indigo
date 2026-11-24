import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { acquireMonitoringLock, getDatabase } from '../config/database.js';
import { getNotificationHistory, getEmailConfiguration, validateEmailConfig, sendNotification, isEmailEnabled } from '../services/notification-service.js';
import { analyzeAndPrepare } from '../services/monitor-service.js';
import { setEmailStatus } from '../services/state-service.js';

const router = express.Router();

router.get('/history', asyncRoute(async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({ data: await getNotificationHistory(limit), limit, timestamp: new Date().toISOString() });
}));

router.get('/config', asyncRoute(async (req, res) => {
  res.json({ ...await getEmailConfiguration(), validation: await validateEmailConfig(), timestamp: new Date().toISOString() });
}));

// Sends the alert for one stored publication now, regardless of its date or the
// category/priority filters. Without an id it uses the newest highest-priority one.
router.post('/test/:id?', asyncRoute(async (req, res) => {
  if (!await isEmailEnabled()) {
    return res.status(409).json({ success: false, error: 'Email alerts are turned off - switch them on in Settings first' });
  }
  const db = getDatabase();
  const row = req.params.id
    ? await db.prepare('SELECT * FROM updates WHERE id = $1').get(req.params.id)
    : await db.prepare(`SELECT * FROM updates ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, publication_date DESC NULLS LAST LIMIT 1`).get();
  if (!row) return res.status(404).json({ success: false, error: 'Update not found' });

  const lock = await acquireMonitoringLock();
  if (!lock) return res.status(409).json({ success: false, error: 'A monitoring or email operation is already in progress' });
  try {
    const { pdf, analysis } = await analyzeAndPrepare(row);
    const result = await sendNotification(row, { analysis, pdf, assertHeld: lock.assertHeld });
    await setEmailStatus(row.id, result.success ? `sent (test) ${new Date().toISOString()}` : `failed - ${result.error}`);
    res.status(result.success ? 200 : 502).json({ ...result, timestamp: new Date().toISOString() });
  } finally {
    await lock.release();
  }
}));

export default router;
