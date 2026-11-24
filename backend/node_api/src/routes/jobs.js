import express from 'express';
import { asyncRoute } from '../utils/async-route.js';
import { readJob } from '../services/job-service.js';

const router = express.Router();

router.get('/:id', asyncRoute(async (req, res) => {
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000_000) {
    return res.status(400).json({ error: 'Invalid result offset' });
  }
  const job = await readJob(req.params.id, offset);
  if (!job) return res.status(404).json({ error: 'Job result was not found or has expired' });
  res.json(job);
}));

export default router;
