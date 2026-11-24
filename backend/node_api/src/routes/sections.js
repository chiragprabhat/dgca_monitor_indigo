import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { getDatabase } from '../config/database.js';
import { toApiUpdate } from '../services/state-service.js';

const router = express.Router();

const SECTIONS = {
  tenders: { name: 'Tenders', icon: '🎯' },
  regulation: { name: 'Regulation', icon: '📋' },
  guidance: { name: 'Guidance', icon: '📖' },
  announcements: { name: 'Announcements', icon: '📢' }
};

router.get('/', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const data = [];

  for (const [key, config] of Object.entries(SECTIONS)) {
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM updates WHERE section = $1');
    const result = await countStmt.get(key);

    const lastUpdateStmt = db.prepare(
      'SELECT publication_date FROM updates WHERE section = $1 ORDER BY publication_date DESC NULLS LAST LIMIT 1'
    );
    const lastUpdate = await lastUpdateStmt.get(key);

    data.push({
      id: key,
      name: config.name,
      icon: config.icon,
      count: result?.count || 0,
      lastUpdated: lastUpdate?.publication_date || null
    });
  }

  res.json({
    data,
    timestamp: new Date().toISOString()
  });
}));

router.get('/:section', asyncRoute(async (req, res) => {
  const { section } = req.params;

  if (!SECTIONS[section]) {
    return res.status(404).json({ error: 'Section not found' });
  }

  const db = getDatabase();
  const limit = parseInt(req.query.limit) || 20;
  const offset = parseInt(req.query.offset) || 0;

  const updates = await db.prepare(`
    SELECT * FROM updates WHERE section = $1
    ORDER BY publication_date DESC NULLS LAST LIMIT NULLIF(GREATEST($2::bigint, -1), -1) OFFSET GREATEST($3::bigint, 0)
  `).all(section, limit, offset);

  const countResult = await db.prepare(
    'SELECT COUNT(*) as count FROM updates WHERE section = $1'
  ).get(section);

  const updates_parsed = updates.map(toApiUpdate);

  res.json({
    section: SECTIONS[section].name,
    data: updates_parsed,
    total: countResult?.count || 0,
    limit,
    offset,
    timestamp: new Date().toISOString()
  });
}));

export default router;
