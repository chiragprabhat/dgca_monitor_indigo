import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { importArchive, getArchiveStatus } from '../services/archive-service.js';

const router = express.Router();

router.get('/status', asyncRoute(async (req, res) => {
  res.json({ ...await getArchiveStatus(), timestamp: new Date().toISOString() });
}));

router.post('/import', asyncRoute(async (req, res) => {
  const result = await importArchive();
  res.status(result.started ? 202 : 409).json({ ...result, ...await getArchiveStatus() });
}));

export default router;
