import { randomUUID } from 'node:crypto';
import { getDatabase, transaction } from '../config/database.js';
import { MAX_UPLOAD_BYTES, storeUpload } from './upload-service.js';
import { enqueueJob } from './job-service.js';

export const CHUNK_BYTES = 3 * 1024 * 1024;
const RESERVATION_LIMIT = MAX_UPLOAD_BYTES * 3;
const fail = (message, status) => Object.assign(new Error(message), { status });

export async function openUpload(filename, bytes) {
  if (!Number.isInteger(bytes) || bytes < 1) throw fail('No file received', 400);
  if (bytes > MAX_UPLOAD_BYTES) throw fail('PDF exceeds the 40 MiB upload limit', 413);
  return transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(13691, 6)');
    await db.query('DELETE FROM dgca_upload_sessions WHERE job_id IS NULL AND expires_at < now()');
    const { total } = await db.prepare('SELECT COALESCE(sum(bytes), 0) AS total FROM dgca_upload_sessions').get();
    if (total + bytes > RESERVATION_LIMIT) throw fail('PDF upload storage is busy. Try again after an upload finishes.', 429);
    const id = randomUUID();
    await db.prepare(`INSERT INTO dgca_upload_sessions (id, filename, bytes, expires_at)
      VALUES ($1, $2, $3, now() + interval '1 hour')`).run(id, String(filename || '').slice(0, 256), bytes);
    return { id, chunkBytes: CHUNK_BYTES };
  });
}

async function withUpload(id, callback) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw fail('PDF upload was not found or has expired', 404);
  return transaction(async db => {
    const upload = await db.prepare(`SELECT *, expires_at <= now() AS expired
      FROM dgca_upload_sessions WHERE id = $1 FOR UPDATE`).get(id);
    if (!upload || (upload.expired && !upload.job_id)) throw fail('PDF upload was not found or has expired', 404);
    return callback(db, upload);
  });
}

export async function putChunk(id, part, data) {
  await withUpload(id, async (db, upload) => {
    const offset = part * CHUNK_BYTES;
    if (!Number.isInteger(part) || part < 0 || offset >= upload.bytes ||
        !Buffer.isBuffer(data) || data.length !== Math.min(CHUNK_BYTES, upload.bytes - offset)) {
      throw fail('Invalid PDF chunk size or position', 400);
    }
    const previous = await db.prepare('SELECT data FROM dgca_upload_chunks WHERE upload_id = $1 AND part = $2').get(id, part);
    if (previous?.data.equals(data)) return;
    if (previous || upload.job_id) throw fail('PDF chunk already exists', 409);
    if (!part && data.subarray(0, 5).toString() !== '%PDF-') throw fail('That file is not a PDF', 415);
    await db.prepare('INSERT INTO dgca_upload_chunks (upload_id, part, data) VALUES ($1, $2, $3)').run(id, part, data);
  });
}

export async function queueUpload(id) {
  return withUpload(id, async (db, upload) => {
    if (upload.job_id) return upload.job_id;
    const { count } = await db.prepare('SELECT count(*) FROM dgca_upload_chunks WHERE upload_id = $1').get(id);
    if (count !== Math.ceil(upload.bytes / CHUNK_BYTES)) throw fail('The PDF upload is incomplete', 409);
    const job = await enqueueJob('upload', { id }, db);
    await db.prepare('UPDATE dgca_upload_sessions SET job_id = $2 WHERE id = $1').run(id, job.id);
    return job.id;
  });
}

export async function processUpload(id) {
  const db = getDatabase();
  const upload = await db.prepare('SELECT * FROM dgca_upload_sessions WHERE id = $1').get(id);
  if (!upload) throw fail('PDF upload was not found', 404);
  const chunks = await db.prepare('SELECT data FROM dgca_upload_chunks WHERE upload_id = $1 ORDER BY part').all(id);
  if (chunks.reduce((total, { data }) => total + data.length, 0) !== upload.bytes) throw fail('The PDF upload is incomplete', 409);
  return storeUpload(Buffer.concat(chunks.map(({ data }) => data)), upload.filename);
}
