import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { getDatabase } from '../config/database.js';
import { listCars, relatedPublications, syncCars, carSyncStatus, recentCarChanges } from '../services/car-service.js';
import { enqueueJob, jobStatus, serverless } from '../services/job-service.js';
import { sendPayload } from '../utils/send-payload.js';

const router = express.Router();

async function statusForApi() {
  const status = await carSyncStatus();
  if (!serverless()) return status;
  const { active, latest } = await jobStatus('car');
  return { ...status, syncing: active, lastSync: latest };
}

async function publications() {
  return (await getDatabase().prepare(`SELECT id, section, title, publication_date, origin, priority, revision_key, pdf_urls,
    length(pdf_text) > 80 AS has_text FROM updates ORDER BY publication_date DESC NULLS LAST`).all())
    .map(p => ({ ...p, has_text: !!p.has_text, pdf_urls: JSON.parse(p.pdf_urls || '[]') }));
}

// GET /api/cars - every stored CAR with the What's New publications about it.
router.get('/', asyncRoute(async (req, res) => {
  const pubs = await publications();
  const cars = (await listCars()).map(car => ({ ...car, related: relatedPublications(car, pubs) }));
  await sendPayload(res, { status: await statusForApi(), cars, changes: await recentCarChanges(20), timestamp: new Date().toISOString() });
}));

// POST /api/cars/sync - re-read DGCA's CAR list and any new or amended PDFs (runs in the background).
router.post('/sync', asyncRoute(async (req, res) => {
  if (serverless()) {
    const { inserted } = await enqueueJob('car');
    const status = await statusForApi();
    return inserted ? res.status(202).json({ started: true, status })
      : res.status(409).json({ error: 'Already refreshing the CAR list', status });
  }
  const status = await carSyncStatus();
  if (status.syncing) return res.status(409).json({ error: 'Already refreshing the CAR list', status });
  syncCars().catch(() => {});
  res.status(202).json({ started: true, status: await carSyncStatus() });
}));

router.get('/status', asyncRoute(async (req, res) => res.json(await statusForApi())));

export default router;
