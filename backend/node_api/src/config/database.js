import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';
import { createLogger } from '../utils/logger.js';
import { monitoringSmokeTest, runWithBackgroundSmokeClient } from './monitoring-smoke-context.js';

const logger = createLogger('database');
const schema = new URL('./schema.sql', import.meta.url);
let pool;

function getPool() {
  const smoke = monitoringSmokeTest();
  const existing = smoke ? smoke.pool : pool;
  if (existing) return existing;
  const connectionString = smoke ? smoke.target?.connectionString : process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    throw new Error('DATABASE_URL must specify the PostgreSQL host in the URL authority');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const ssl = local && url.searchParams.get('sslmode') === 'disable' ? false : { rejectUnauthorized: true };
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl', 'uselibpqcompat']) {
    url.searchParams.delete(key);
  }

  const created = new pg.Pool({
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
  created.on('error', error => logger.error('Idle database connection failed', { error: error.message }));
  if (smoke) smoke.pool = created;
  else pool = created;
  return created;
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
  return database(monitoringSmokeTest()?.backgroundClient ?? getPool());
}

export function requireDirectMonitoringConnection() {
  const smoke = monitoringSmokeTest();
  const connectionString = smoke ? smoke.target?.connectionString : process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  if (new URL(connectionString).hostname.includes('-pooler.')) {
    throw new Error('DGCA monitoring requires a direct Neon DATABASE_URL for its session lock');
  }
}

export async function verifyMonitoringSmokeConnection() {
  const smoke = monitoringSmokeTest();
  if (!smoke) throw new Error('Monitoring smoke-test context required');
  smoke.connectionVerified = false;
  const { hostname, databaseName } = smoke.target;
  const client = await getPool().connect();
  try {
    const socket = client.connection?.stream;
    const certificate = socket?.encrypted === true && socket.authorized === true
      ? socket.getPeerCertificate()
      : null;
    if (!certificate || checkServerIdentity(hostname, certificate)) {
      throw Object.assign(new Error('Test database certificate could not be verified'), { code: 'SMOKE_TLS' });
    }
    const { rows: [info] } = await client.query(`
      SELECT current_database() AS database_name, current_schema() AS schema_name,
             pg_is_in_recovery() AS in_recovery, current_setting('transaction_read_only') AS read_only
    `);
    if (info.database_name !== databaseName || info.schema_name !== 'public' ||
        info.in_recovery !== false || info.read_only !== 'off') {
      throw Object.assign(new Error('Expected the writable test database and public schema'), { code: 'SMOKE_DATABASE' });
    }
    smoke.connectionVerified = true;
  } finally {
    client.release();
  }
}

export async function withBackgroundSmokeDatabase(callback) {
  const smoke = monitoringSmokeTest();
  if (!smoke || smoke.backgroundClient) throw new Error('A smoke-test context is required');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(smoke.target.connectionString).hostname);
  if (!local && !smoke.connectionVerified) {
    throw new Error('A verified smoke-test database is required');
  }
  const namespace = `dgca_smoke_${randomUUID().replaceAll('-', '')}`;
  const client = await getPool().connect();
  let connectionError;
  let releaseError;
  const rememberError = error => { connectionError ??= error; };
  client.on('error', rememberError);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '45s'; SET LOCAL idle_in_transaction_session_timeout = '120s'");
    await client.query(`CREATE SCHEMA ${namespace}; SET LOCAL search_path TO ${namespace}, pg_catalog`);
    const applicationSchema = await readFile(schema, 'utf8');
    // The smoke exercises queues and documents, not the shared public search configuration.
    const searchSetup = applicationSchema.indexOf('CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;');
    if (searchSetup < 0) throw new Error('Cannot isolate application schema from public search setup');
    await client.query(applicationSchema.slice(0, searchSetup));
    const deploymentSchema = await readFile(new URL('./deployment.sql', import.meta.url), 'utf8');
    await client.query(deploymentSchema);
    return await runWithBackgroundSmokeClient(client, () => callback(namespace));
  } finally {
    try {
      if (connectionError) throw connectionError;
      await client.query('ROLLBACK');
      const { rows: [row] } = await client.query('SELECT pg_catalog.to_regnamespace($1) IS NULL AS removed', [namespace]);
      if (!row.removed) throw new Error('Smoke-test schema rollback was not verified');
    } catch (error) {
      releaseError = error;
      throw error;
    } finally {
      client.release(releaseError);
      client.off('error', rememberError);
    }
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
  const smoke = monitoringSmokeTest();
  if (smoke?.backgroundClient) {
    const client = smoke.backgroundClient;
    const savepoint = `dgca_nested_${++smoke.savepoint}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await callback(database(client));
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
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
  const smoke = monitoringSmokeTest();
  const current = smoke ? smoke.pool : pool;
  if (smoke) {
    smoke.pool = undefined;
    smoke.connectionVerified = false;
  } else pool = undefined;
  await current?.end();
}
