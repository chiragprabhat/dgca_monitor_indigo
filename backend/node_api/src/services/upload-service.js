import crypto from 'crypto';
import { getDatabase } from '../config/database.js';
import { extractText, FULL_DOCUMENT_PAGES } from './pdf-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('upload-service');

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
// Below this, a PDF is almost certainly a scan with no text layer, so a comparison would be empty.
const MIN_READABLE_CHARS = 80;

const fail = (message, status) => Object.assign(new Error(message), { status });

function cleanFilename(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 120);
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned || 'uploaded-document'}.pdf`;
}

const summary = row => ({
  id: `upload:${row.id}`,
  filename: row.filename,
  pages: row.pdf_pages,
  sizeBytes: row.size_bytes,
  uploadedAt: row.uploaded_at,
  hasText: (row.text_length ?? 0) >= MIN_READABLE_CHARS
});

const SUMMARY_SQL = `SELECT id, filename, size_bytes, pdf_pages, uploaded_at, length(pdf_text) AS text_length FROM uploaded_documents`;

// Reads an uploaded PDF's text and stores it. Uploading the same file again returns the stored copy.
export async function storeUpload(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail('No file received', 400);
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw fail('That file is not a PDF', 415);

  const db = getDatabase();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await db.prepare(`${SUMMARY_SQL} WHERE content_hash = $1`).get(hash);
  if (existing) return { ...summary(existing), duplicate: true };

  let extracted;
  try {
    extracted = await extractText(buffer, FULL_DOCUMENT_PAGES);
  } catch (error) {
    logger.warn('Uploaded PDF could not be read', { error: error.message });
    throw fail('Could not read this PDF (it may be damaged or password-protected)', 422);
  }

  const id = crypto.randomUUID();
  const insertion = await db.prepare('INSERT INTO uploaded_documents (id, filename, size_bytes, pdf_pages, pdf_text, content_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (content_hash) DO NOTHING')
    .run(id, cleanFilename(filename), buffer.length, extracted.pageCount, extracted.text, hash);
  const row = await db.prepare(`${SUMMARY_SQL} WHERE content_hash = $1`).get(hash);
  logger.info('PDF uploaded for comparison', { filename: row.filename, pages: row.pdf_pages });
  return { ...summary(row), duplicate: insertion.changes === 0 };
}

export async function listUploads() {
  return (await getDatabase().prepare(`${SUMMARY_SQL} ORDER BY uploaded_at DESC NULLS LAST, upload_order DESC`).all()).map(summary);
}

export async function deleteUpload(id) {
  return (await getDatabase().prepare('DELETE FROM uploaded_documents WHERE id = $1').run(id)).changes > 0;
}

// Same shape as the other loaders in routes/compare.js.
export async function loadUpload(id) {
  const row = await getDatabase().prepare('SELECT * FROM uploaded_documents WHERE id = $1').get(id);
  if (!row) throw fail('That uploaded file is no longer stored - upload it again', 404);
  return { label: `Uploaded file: ${row.filename}`, published: null, section: 'upload', pages: row.pdf_pages, text: row.pdf_text || '' };
}
