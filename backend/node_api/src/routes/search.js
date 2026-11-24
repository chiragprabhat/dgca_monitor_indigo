import express from 'express';
import { getDatabase } from '../config/database.js';

const router = express.Router();

// Adjacent terms must all match, quoted words form a phrase, and OR separates groups.
export function toFtsQuery(input) {
  const groups = [[]];
  for (const match of String(input || '').matchAll(/"([^"]+)"|(\S+)/g)) {
    const group = groups.at(-1);
    if (match[2] === 'OR') {
      if (group.length) groups.push([]);
      continue;
    }
    const words = (match[1] || match[2]).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (match[1] && words.length) {
      const phrase = weight => words.map(word => `'${word}':${weight}`).join(' <-> ');
      // A phrase must occur entirely in either the title or the PDF body.
      group.push(`((${phrase('A')}) | (${phrase('D')}))`);
    } else {
      group.push(...words.map(word => `'${word}'${word.length >= 3 ? ':*' : ''}`));
    }
  }
  return groups.filter(group => group.length).map(group => group.join(' & ')).join(' | ');
}

// GET /api/search?q=EFB&section=regulation&origin=archive&limit=50
router.get('/', async (req, res) => {
  const match = toFtsQuery(req.query.q);
  if (!match) return res.status(400).json({ error: 'Type something to search for' });
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const vector = 'dgca_search_vector(u.title, u.pdf_text)';
  const where = [`${vector} @@ search.query`];
  const params = [match];
  if (req.query.section) where.push(`u.section = $${params.push(req.query.section)}`);
  if (req.query.origin === 'archive') where.push("u.origin = 'archive'");
  if (req.query.origin === 'monitor') where.push("COALESCE(u.origin, 'monitor') <> 'archive'");

  const sql = `
    FROM updates u CROSS JOIN to_tsquery('public.dgca_search', $1) AS search(query)
    WHERE ${where.join(' AND ')}`;
  try {
    const db = getDatabase();
    const { n: total } = await db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...params);
    // Title hits are weighted 5:1 over body hits. Keep the frontend's highlight markers.
    const rows = await db.prepare(`
      SELECT u.id, u.section, u.title, u.publication_date, u.priority, u.origin, u.pdf_urls, u.pdf_pages,
             u.review_status, length(u.pdf_text) > 80 AS has_text,
             ts_headline('public.dgca_search', coalesce(u.pdf_text, ''), search.query,
               'StartSel="' || chr(1) || '", StopSel="' || chr(2) || '", MaxWords=30, MinWords=10, MaxFragments=1') AS snippet
      ${sql}
      ORDER BY ${req.query.sort === 'date' ? 'u.publication_date DESC NULLS LAST' : `ts_rank(ARRAY[0.2, 0.2, 0.2, 1.0]::real[], ${vector}, search.query) DESC`}
      LIMIT NULLIF(GREATEST($${params.length + 1}::bigint, -1), -1)`).all(...params, limit);
    res.json({
      query: req.query.q,
      total,
      searchable: (await db.prepare('SELECT COUNT(*) AS n FROM updates WHERE length(pdf_text) > 80').get()).n,
      data: rows.map(r => ({ ...r, pdf_urls: JSON.parse(r.pdf_urls || '[]'), has_text: !!r.has_text }))
    });
  } catch (error) {
    res.status(400).json({ error: `Could not search for that: ${error.message}` });
  }
});

export default router;
