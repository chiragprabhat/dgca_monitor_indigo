import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, transaction } from '../config/database.js';

export const serverless = () => process.env.VERCEL === '1';
const RESULT_PAGE = 500000;

export async function enqueueJob(kind, input = {}, db = getDatabase()) {
  const payload = JSON.stringify(input);
  const scope = createHash('sha256').update(payload).digest('hex');
  const [job] = (await db.query(`
    INSERT INTO dgca_jobs (id, kind, scope, input) VALUES ($1, $2, $3, $4)
    ON CONFLICT (kind, scope) WHERE state IN ('queued', 'running')
    DO UPDATE SET scope = EXCLUDED.scope
    RETURNING id, id = $1 AS inserted
  `, [randomUUID(), kind, scope, payload])).rows;
  return job;
}

export async function jobStatus(kind) {
  const db = getDatabase();
  const { active, result, progress } = await db.prepare(`
    SELECT EXISTS (SELECT 1 FROM dgca_jobs WHERE kind = $1 AND state IN ('queued', 'running')) AS active,
      (SELECT input->'progress' FROM dgca_jobs WHERE kind = $1 AND state IN ('queued', 'running') LIMIT 1) AS progress,
      (SELECT result FROM dgca_jobs WHERE kind = $1 AND state IN ('done', 'failed')
       ORDER BY finished_at DESC LIMIT 1) AS result
  `).get(kind);
  return { active, progress, latest: result ? JSON.parse(result) : null };
}

export async function readJob(id, offset) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
  return getDatabase().prepare(`
    SELECT state, status, substring(result FROM $2::integer + 1 FOR $3::integer) AS chunk,
      CASE WHEN length(result) > $2::integer + $3::integer THEN $2::integer + $3::integer END AS next
    FROM dgca_jobs WHERE id = $1
  `).get(id, offset, RESULT_PAGE);
}

export async function recoverJobs() {
  await transaction(async db => {
    // The caller holds the worker session lock, so any running rows belong to a stopped runner.
    await db.query(`
      UPDATE dgca_jobs SET state = 'queued'
      WHERE state = 'running' AND kind IN ('car', 'archive', 'archive-analysis', 'compare', 'revision', 'upload')
    `);
    await db.query(`
      UPDATE dgca_jobs SET state = 'failed', finished_at = now(), status = 503,
        result = '{"success":false,"error":"The runner stopped. Check monitoring or email history before retrying."}'
      WHERE state = 'running'
    `);
    await db.query(`
      UPDATE dgca_jobs SET state = 'failed', finished_at = now(), status = 410,
        result = '{"success":false,"error":"This background request expired before processing."}'
      WHERE state = 'queued' AND kind NOT IN ('car', 'archive', 'archive-analysis')
        AND created_at < now() - interval '1 day'
    `);
    await db.query(`
      DELETE FROM dgca_upload_sessions u WHERE
        (u.job_id IS NULL AND u.expires_at < now())
        OR EXISTS (SELECT 1 FROM dgca_jobs j WHERE j.id = u.job_id AND j.state IN ('done','failed'))
    `);
    await db.query(`
      DELETE FROM dgca_jobs j WHERE finished_at < now() - interval '1 day'
        AND (kind NOT IN ('archive', 'car') OR EXISTS (
          SELECT 1 FROM dgca_jobs newer WHERE newer.kind = j.kind AND newer.finished_at > j.finished_at
        ))
    `);
  });
}

export async function claimJob(id = null) {
  const { rows: [job] } = await getDatabase().query(`
    UPDATE dgca_jobs SET state = 'running' WHERE id = (
      SELECT id FROM dgca_jobs WHERE state = 'queued' AND ($1::uuid IS NULL OR id = $1)
      ORDER BY (kind IN ('archive', 'car')), created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, input
  `, [id]);
  return job;
}

export async function finishJob(job, status, result) {
  await transaction(async db => {
    await db.query(`
      UPDATE dgca_jobs SET state = $2, finished_at = now(), status = $3, result = $4
      WHERE id = $1 AND state = 'running'
    `, [job.id, status < 400 ? 'done' : 'failed', status, JSON.stringify(result)]);
    if (job.kind === 'upload') await db.query('DELETE FROM dgca_upload_sessions WHERE job_id = $1', [job.id]);
  });
}

export async function deferJob(job) {
  await getDatabase().query("UPDATE dgca_jobs SET state = 'queued' WHERE id = $1 AND state = 'running'", [job.id]);
}

export async function saveJobProgress(job, progress) {
  await getDatabase().query(`UPDATE dgca_jobs SET input = jsonb_set(input, '{progress}', $2::jsonb)
    WHERE id = $1 AND state = 'running'`, [job.id, JSON.stringify(progress)]);
}

export function queueRoute(kind, getInput = () => ({})) {
  return async (req, res, next) => {
    if (!serverless()) return next();
    if (req.get('sec-fetch-site') === 'cross-site' && !req.get('origin')) {
      return res.status(403).json({ error: 'Request origin not allowed' });
    }
    try {
      const job = await enqueueJob(kind, getInput(req));
      res.status(202).json({ jobId: job.id });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };
}
