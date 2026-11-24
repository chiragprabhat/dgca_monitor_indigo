import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('database');
const schema = new URL('./schema.sql', import.meta.url);
let pool;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    throw new Error('DATABASE_URL must specify the PostgreSQL host in the URL authority');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const ssl = local && url.searchParams.get('sslmode') === 'disable' ? false : { rejectUnauthorized: true };
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl', 'uselibpqcompat']) {
    url.searchParams.delete(key);
  }

  pool = new pg.Pool({
    connectionString: url.toString(),
    ssl,
    enableChannelBinding: true,
    max: 5,
    connectionTimeoutMillis: 15000,
    allowExitOnIdle: true,
    // Keep counts and identity IDs numeric in API responses.
    types: {
      getTypeParser: (oid, format) => oid === pg.types.builtins.INT8 && format !== 'binary'
        ? Number : pg.types.getTypeParser(oid, format)
    }
  });
  pool.on('error', error => logger.error('Idle database connection failed', { error: error.message }));
  return pool;
}

function database(client) {
  return {
    query: (sql, params) => client.query(sql, params),
    prepare(sql) {
      return {
        all: async (...params) => (await client.query(sql, params)).rows,
        get: async (...params) => (await client.query(sql, params)).rows[0],
        run: async (...params) => {
          const result = await client.query(sql, params);
          return { changes: result.rowCount };
        }
      };
    }
  };
}

export function getDatabase() {
  return database(getPool());
}

export function requireDirectMonitoringConnection() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (new URL(process.env.DATABASE_URL).hostname.includes('-pooler.')) {
    throw new Error('DGCA monitoring requires a direct Neon DATABASE_URL for its session lock');
  }
}

// Keep the lock on one dedicated PostgreSQL session for the whole run.
export async function acquireMonitoringLock(key = 4) {
  requireDirectMonitoringConnection();
  const client = await getPool().connect();
  let connectionError;
  const rememberError = error => { connectionError = error; };
  client.on('error', rememberError);
  function dispose(error) {
    client.release(error);
    client.off('error', rememberError);
  }
  try {
    const { rows: [row] } = await client.query('SELECT pg_try_advisory_lock(13691, $1) AS acquired', [key]);
    if (!row.acquired) {
      dispose();
      return null;
    }
  } catch (error) {
    dispose(error);
    throw error;
  }
  return {
    assertHeld() {
      if (connectionError) throw new Error('Lost the DGCA monitoring lock connection');
    },
    async release() {
      try {
        if (!connectionError) await client.query('SELECT pg_advisory_unlock(13691, $1)', [key]);
      } catch (error) {
        connectionError = error;
      } finally {
        dispose(connectionError);
      }
    }
  };
}

export async function transaction(callback) {
  const client = await getPool().connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const result = await callback(database(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export async function initializeDatabase() {
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(13691, 1)');
    await db.query(await readFile(schema, 'utf8'));
    const missingIds = await db.prepare("SELECT id, pdf_urls FROM updates WHERE attach_id IS NULL AND pdf_urls LIKE '%attachId=%'").all();
    const setId = db.prepare('UPDATE updates SET attach_id = $1 WHERE id = $2');
    for (const row of missingIds) {
      const match = String(row.pdf_urls).match(/attachId=([^&"]+)/);
      if (match) await setId.run(match[1], row.id);
    }
  });
  logger.info('Database tables initialized');
}

export async function closeDatabase() {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}
