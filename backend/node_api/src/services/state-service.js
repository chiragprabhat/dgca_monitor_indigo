import crypto from 'crypto';
import { getDatabase, transaction } from '../config/database.js';
import { createLogger } from '../utils/logger.js';
import { revisionKey } from './revision-service.js';

const logger = createLogger('state-service');

export function generateHash(section, title, date) {
  const combined = `${section}:${title}:${normalizeDate(date)}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

function normalizeDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toISOString().split('T')[0];
  } catch {
    return dateStr.substring(0, 10);
  }
}

const DEVANAGARI = /[ऀ-ॿ]/;

export function attachIdFromUrl(url) {
  const m = String(url || '').match(/attachId=([^&"]+)/);
  return m ? m[1] : null;
}

// Saves a scraped publication unless it's already stored. Matching is by DGCA's PDF
// id first (the same document can be listed with a Hindi or an English title),
// then by section + title + date. options.emailStatus pre-sets the email decision
// (used for archive imports, which must never be emailed).
export async function saveUpdate(update, options = {}) {
  const hash = generateHash(update.section, update.title, update.publicationDate);
  const attachId = attachIdFromUrl(update.pdfUrl);

  const id = crypto.randomUUID();

  try {
    return await transaction(async db => {
      if (attachId) {
        await db.query("SELECT pg_advisory_xact_lock(13693, hashtext($1))", [attachId]);
        const existing = await db.prepare('SELECT id, title, in_dgca_archive FROM updates WHERE attach_id = $1').get(attachId);
        if (existing) {
          if (DEVANAGARI.test(existing.title) && !DEVANAGARI.test(update.title)) {
            await db.prepare('UPDATE updates SET title = $1, revision_key = $2 WHERE id = $3').run(update.title, revisionKey(update.title) || '', existing.id);
          }
          if (update.inArchive && !existing.in_dgca_archive) {
            await db.prepare('UPDATE updates SET in_dgca_archive = 1 WHERE id = $1').run(existing.id);
          }
          return { id: existing.id, isNew: false, hash };
        }
      }

      const stmt = db.prepare(`
        INSERT INTO updates (
          id, section, title, description, publication_date, pdf_urls, source_page_url, hash, detected_at,
          attach_id, origin, in_dgca_archive, email_status, revision_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT DO NOTHING
      `);

      const result = await stmt.run(
        id,
        update.section,
        update.title,
        update.description || '',
        update.publicationDate,
        update.pdfUrl ? JSON.stringify([update.pdfUrl]) : JSON.stringify([]),
        update.sourcePageUrl,
        hash,
        new Date().toISOString(),
        attachId,
        options.origin || 'monitor',
        update.inArchive ? 1 : 0,
        options.emailStatus ?? null,
        revisionKey(update.title) || ''
      );

      return {
        id,
        isNew: result.changes > 0,
        hash
      };
    });
  } catch (error) {
    logger.error('Error saving update:', { error: error.message, update });
    throw error;
  }
}

export async function getNewUpdates(limit = 50) {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      SELECT * FROM updates WHERE is_notified = 0
      ORDER BY detected_at DESC NULLS LAST LIMIT NULLIF(GREATEST($1::bigint, -1), -1)
    `);

    return await stmt.all(limit);
  } catch (error) {
    logger.error('Error getting new updates:', { error: error.message });
    return [];
  }
}

export async function getUpdatesByIds(ids) {
  if (ids.length === 0) return [];
  const db = getDatabase();
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
  return await db.prepare(`SELECT * FROM updates WHERE id IN (${placeholders})`).all(...ids);
}

export async function saveAnalysis(updateId, analysis) {
  await getDatabase().prepare(`
    UPDATE updates
    SET priority = $1, priority_reason = $2, summary = $3, analysis = $4, summary_source = $5, deadline = $6, analyzed_at = $7
    WHERE id = $8
  `).run(
    analysis.priority,
    analysis.priority_reason,
    analysis.summary,
    JSON.stringify({
      key_points: analysis.key_points,
      action_required: analysis.action_required,
      applies_to: analysis.applies_to
    }),
    analysis.source,
    analysis.deadline || null,
    new Date().toISOString(),
    updateId
  );
}

export function analysisFromRow(row) {
  if (!row.analyzed_at) return null;
  let extra = {};
  try { extra = JSON.parse(row.analysis || '{}'); } catch { extra = {}; }
  return {
    priority: row.priority,
    priority_reason: row.priority_reason,
    summary: row.summary,
    deadline: row.deadline,
    source: row.summary_source,
    key_points: extra.key_points || [],
    action_required: extra.action_required || '',
    applies_to: extra.applies_to || []
  };
}

// Shape returned by the API: JSON columns parsed, analysis fields at top level.
export function toApiUpdate(row) {
  const analysis = analysisFromRow(row);
  const { analysis: _raw, pdf_text: text, revision, pdf_text_full: _full, email_delivery_started_at: _claim, ...rest } = row;
  return {
    ...rest,
    revision: revision ? JSON.parse(revision) : null,
    pdf_urls: row.pdf_urls ? JSON.parse(row.pdf_urls) : [],
    has_pdf_text: text == null ? null : text.length > 80,
    key_points: analysis?.key_points || [],
    action_required: analysis?.action_required || '',
    applies_to: analysis?.applies_to || []
  };
}

// full = the whole document was read (not just the opening pages used for summaries).
export async function savePdfText(updateId, text, pages, full = false) {
  await getDatabase().prepare('UPDATE updates SET pdf_text = $1, pdf_pages = $2, pdf_text_full = $3 WHERE id = $4')
    .run(text || '', pages ?? null, full || !pages || pages <= 30 ? 1 : 0, updateId);
}

export async function setEmailStatus(updateId, status) {
  await getDatabase().prepare('UPDATE updates SET email_status = $1 WHERE id = $2').run(status, updateId);
}

const PENDING_DELIVERY = `email_status IS NULL AND email_delivery_started_at IS NULL
  AND COALESCE(is_notified, 0) = 0
  AND NOT EXISTS (SELECT 1 FROM notifications WHERE update_id = updates.id AND status = 'sent')`;

// An attempt is durable before contacting SMTP. An interrupted attempt must be reviewed
// before an operator explicitly resends it, since SMTP may already have accepted it.
export async function claimEmailDelivery(updateId) {
  const result = await getDatabase().prepare(`
    UPDATE updates SET email_delivery_started_at = dgca_utc_now()
    WHERE id = $1 AND ${PENDING_DELIVERY}
  `).run(updateId);
  return result.changes === 1;
}

export async function getPendingEmailUpdates() {
  return await getDatabase().prepare(`SELECT * FROM updates WHERE ${PENDING_DELIVERY}
    ORDER BY detected_at ASC NULLS FIRST`).all();
}

// The monitor's backfill skips archive imports; the archive worker analyses those.
export async function getUnanalyzedUpdates(limit = 50, origin = null) {
  const db = getDatabase();
  if (origin) {
    return await db.prepare('SELECT * FROM updates WHERE analyzed_at IS NULL AND origin = $1 ORDER BY publication_date DESC NULLS LAST LIMIT NULLIF(GREATEST($2::bigint, -1), -1)').all(origin, limit);
  }
  return await db.prepare(`
    SELECT * FROM updates WHERE analyzed_at IS NULL AND COALESCE(origin, 'monitor') <> 'archive'
    ORDER BY publication_date DESC NULLS LAST LIMIT NULLIF(GREATEST($1::bigint, -1), -1)
  `).all(limit);
}

export async function markAsNotified(updateId) {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      UPDATE updates SET is_notified = 1, notified_at = $1 WHERE id = $2
    `);

    await stmt.run(new Date().toISOString(), updateId);
    return true;
  } catch (error) {
    logger.error('Error marking update as notified:', { error: error.message });
    return false;
  }
}

export async function getUpdatesBySection(section, limit = 20) {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      SELECT * FROM updates WHERE section = $1
      ORDER BY publication_date DESC NULLS LAST LIMIT NULLIF(GREATEST($2::bigint, -1), -1)
    `);

    return await stmt.all(section, limit);
  } catch (error) {
    logger.error('Error getting updates by section:', { error: error.message });
    return [];
  }
}

export async function getAllUpdates(limit = 100, offset = 0) {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      SELECT * FROM updates
      ORDER BY publication_date DESC NULLS LAST LIMIT NULLIF(GREATEST($1::bigint, -1), -1) OFFSET GREATEST($2::bigint, 0)
    `);

    const updates = await stmt.all(limit, offset);

    const countStmt = db.prepare('SELECT COUNT(*) as count FROM updates');
    const { count } = await countStmt.get();

    return {
      updates,
      total: count
    };
  } catch (error) {
    logger.error('Error getting all updates:', { error: error.message });
    return { updates: [], total: 0 };
  }
}

export async function getSectionCounts() {
  const db = getDatabase();

  try {
    const sections = ['tenders', 'regulation', 'guidance', 'announcements'];
    const counts = {};

    for (const section of sections) {
      const stmt = db.prepare('SELECT COUNT(*) as count FROM updates WHERE section = $1');
      const result = await stmt.get(section);
      counts[section] = result?.count || 0;
    }

    return counts;
  } catch (error) {
    logger.error('Error getting section counts:', { error: error.message });
    return { tenders: 0, regulation: 0, guidance: 0, announcements: 0 };
  }
}

export async function logMonitoringRun(status, itemsFound, itemsNew, duration, error = null) {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO monitoring_logs (status, items_found, items_new, duration_ms, error_message)
      VALUES ($1, $2, $3, $4, $5)
    `);

    await stmt.run(status, itemsFound, itemsNew, duration, error);
    return true;
  } catch (error) {
    logger.error('Error logging monitoring run:', { error: error.message });
    return false;
  }
}

export async function getRecentLogs(limit = 20) {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      SELECT * FROM monitoring_logs ORDER BY run_at DESC NULLS LAST LIMIT NULLIF(GREATEST($1::bigint, -1), -1)
    `);

    return await stmt.all(limit);
  } catch (error) {
    logger.error('Error getting logs:', { error: error.message });
    return [];
  }
}
