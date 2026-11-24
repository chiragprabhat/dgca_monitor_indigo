import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { toApiUpdate, analysisFromRow } from '../services/state-service.js';
import { renderEmail } from '../services/notification-service.js';
import { getDatabase, transaction } from '../config/database.js';
import { compareWithPrevious, findPreviousVersion } from '../services/revision-service.js';
import { listCars, relatedPublications } from '../services/car-service.js';

export const REVIEW_STATUSES = ['new', 'under_review', 'actioned', 'not_applicable'];

const router = express.Router();

let listColumns = null;
async function LIST_COLUMNS() {
  if (!listColumns) {
    listColumns = (await getDatabase().prepare("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'updates' ORDER BY ordinal_position").all())
      .map(c => c.name).filter(n => n !== 'pdf_text').join(', ');
  }
  return listColumns;
}

const PRIORITY_ORDER =`CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`;

router.get('/', asyncRoute(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 5000);
  const offset = parseInt(req.query.offset) || 0;
  const { section, priority, origin, review } = req.query;
  const sort = req.query.sort === 'priority' ? `${PRIORITY_ORDER}, publication_date DESC NULLS LAST` : 'publication_date DESC NULLS LAST, detected_at DESC NULLS LAST';

  const where = [];
  const params = [];
  if (section) { where.push(`section = $${params.push(section)}`); }
  if (priority) { where.push(`priority = $${params.push(priority)}`); }
  if (origin === 'archive') where.push("origin = 'archive'");
  if (origin === 'monitor') where.push("COALESCE(origin, 'monitor') <> 'archive'");
  if (review === 'open') where.push("COALESCE(review_status, 'new') IN ('new', 'under_review')");
  else if (review) { where.push(`COALESCE(review_status, 'new') = $${params.push(review)}`); }

  // Everything except the stored PDF text, which can be large.
  const cols = await LIST_COLUMNS();
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await getDatabase().prepare(`SELECT ${cols} FROM updates ${clause} ORDER BY ${sort} LIMIT NULLIF(GREATEST($${params.length + 1}::bigint, -1), -1) OFFSET GREATEST($${params.length + 2}::bigint, 0)`).all(...params, limit, offset);
  const total = (await getDatabase().prepare(`SELECT COUNT(*) as count FROM updates ${clause}`).get(...params))?.count || 0;

  // Which publications have an earlier version of the same document stored.
  const versions = new Map();
  for (const v of await getDatabase().prepare("SELECT id, revision_key, publication_date FROM updates WHERE revision_key <> ''").all()) {
    if (!versions.has(v.revision_key)) versions.set(v.revision_key, []);
    versions.get(v.revision_key).push(v);
  }
  const previousCount = row => (versions.get(row.revision_key) || []).filter(v => v.id !== row.id && v.publication_date <= row.publication_date).length;

  // The Section 8 CAR in force that each publication is about, if any.
  const carOf = new Map();
  for (const car of await listCars()) {
    for (const p of relatedPublications(car, rows)) if (!carOf.has(p.id)) carOf.set(p.id, { id: car.id, subject: car.subject, series: car.series, part: car.part });
  }

  res.json({
    data: rows.map(r => ({ ...toApiUpdate(r), earlier_versions: r.revision_key ? previousCount(r) : 0, car_in_force: carOf.get(r.id) || null })),
    total,
    limit,
    offset,
    timestamp: new Date().toISOString()
  });
}));

router.get('/:id/email-preview', asyncRoute(async (req, res) => {
  const row = await getDatabase().prepare('SELECT * FROM updates WHERE id = $1').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Update not found' });
  const email = renderEmail(row, analysisFromRow(row));
  res.type('html').send(email.html);
}));

// What changed since the previous version of the same document; worked out on first request and stored.
router.get('/:id/revision', async (req, res, next) => {
  try {
    const row = await getDatabase().prepare('SELECT * FROM updates WHERE id = $1').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Update not found' });
    if (!row.revision_key) return res.json({ revision: null, reason: 'No CAR or circular number recognised in the title' });
    let revision = row.revision ? JSON.parse(row.revision) : null;
    const previous = await findPreviousVersion(row);
    if (!previous) return res.json({ revision: null, reason: 'No earlier version of this document is stored' });
    if (!revision || revision.previous?.id !== previous.id || req.query.refresh) revision = await compareWithPrevious(row);
    res.json({ revision });
  } catch (error) {
    next(error);
  }
});

// Review tracking: status, owner and note. Every change is kept in review_log.
router.patch('/:id/review', asyncRoute(async (req, res) => {
  const result = await transaction(async db => {
    const row = await db.prepare('SELECT * FROM updates WHERE id = $1 FOR UPDATE').get(req.params.id);
    if (!row) return { code: 404, error: 'Update not found' };
    const status = req.body.status ?? row.review_status ?? 'new';
    if (!REVIEW_STATUSES.includes(status)) return { code: 400, error: `Status must be one of: ${REVIEW_STATUSES.join(', ')}` };
    const owner = String(req.body.owner ?? row.review_owner ?? '').trim().slice(0, 100);
    const note = String(req.body.note ?? row.review_note ?? '').trim().slice(0, 2000);
    if (status !== 'new' && !owner) return { code: 400, error: 'Enter your name so the review shows who did it' };

    const updated = await db.prepare(`
      UPDATE updates SET review_status = $1, review_owner = $2, review_note = $3, reviewed_at = dgca_utc_now()
      WHERE id = $4 RETURNING *
    `).get(status, owner, note, row.id);
    await db.prepare('INSERT INTO review_log (update_id, status, owner, note) VALUES ($1, $2, $3, $4)').run(row.id, status, owner, note);
    return { updated };
  });
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json(toApiUpdate(result.updated));
}));

router.get('/:id/review-log', asyncRoute(async (req, res) => {
  res.json({ data: await getDatabase().prepare('SELECT changed_at, status, owner, note FROM review_log WHERE update_id = $1 ORDER BY id DESC').all(req.params.id) });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const row = await getDatabase().prepare('SELECT * FROM updates WHERE id = $1').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Update not found' });
  res.json(toApiUpdate(row));
}));

export default router;
