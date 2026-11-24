import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { acquireMonitoringLock, getDatabase } from '../config/database.js';
import { getNotificationHistory, getEmailConfiguration, validateEmailConfig, sendNotification, isEmailEnabled } from '../services/notification-service.js';
import { analyzeAndPrepare } from '../services/monitor-service.js';
import { setEmailStatus } from '../services/state-service.js';
import { queueRoute } from '../services/job-service.js';

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
export async function sendTestNotification(id) {
  if (!await isEmailEnabled()) {
    return { status: 409, result: { success: false, error: 'Email alerts are turned off - switch them on in Settings first' } };
  }
  const db = getDatabase();
  const row = id
    ? await db.prepare('SELECT * FROM updates WHERE id = $1').get(id)
    : await db.prepare(`SELECT * FROM updates ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, publication_date DESC NULLS LAST LIMIT 1`).get();
  if (!row) return { status: 404, result: { success: false, error: 'Update not found' } };

  const lock = await acquireMonitoringLock();
  if (!lock) return { status: 409, result: { success: false, error: 'A monitoring or email operation is already in progress' } };
  try {
    const { pdf, analysis } = await analyzeAndPrepare(row);
    const result = await sendNotification(row, { analysis, pdf, assertHeld: lock.assertHeld });
    await setEmailStatus(row.id, result.success ? `sent (test) ${new Date().toISOString()}` : `failed - ${result.error}`);
    return { status: result.success ? 200 : 502, result: { ...result, timestamp: new Date().toISOString() } };
  } finally {
    await lock.release();
  }
}

router.post('/test/:id?', queueRoute('test-email', req => ({ id: req.params.id })),
  asyncRoute(async (req, res) => {
    const { status, result } = await sendTestNotification(req.params.id);
    res.status(status).json(result);
  }));

export default router;
