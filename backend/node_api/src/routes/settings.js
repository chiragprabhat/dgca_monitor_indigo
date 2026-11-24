import express from 'express';
import { getSettings, updateSettings, CATEGORIES, PRIORITIES, INTERVALS, PROVIDERS } from '../services/settings-service.js';
import { getEmailConfiguration } from '../services/notification-service.js';
import { getSummaryEngineStatus } from '../services/summary-service.js';
import { restartScheduler, getSchedulerStatus } from '../services/scheduler-service.js';

const router = express.Router();

async function payload() {
  return {
    settings: await getSettings(),
    options: { categories: CATEGORIES, priorities: PRIORITIES, intervals: INTERVALS, providers: PROVIDERS },
    status: {
      email: await getEmailConfiguration(),
      summaries: await getSummaryEngineStatus(),
      scheduler: await getSchedulerStatus()
    },
    timestamp: new Date().toISOString()
  };
}

router.get('/', async (req, res, next) => {
  try { res.json(await payload()); } catch (error) { next(error); }
});

router.put('/', async (req, res, next) => {
  try {
    const { changed } = await updateSettings(req.body);
    if (changed.includes('intervalMinutes')) await restartScheduler();
    res.json({ ...(await payload()), changed });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    next(error);
  }
});

export default router;
