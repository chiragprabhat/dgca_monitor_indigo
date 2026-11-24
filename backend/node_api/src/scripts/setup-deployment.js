import { readFile } from 'node:fs/promises';
import { closeDatabase, transaction } from '../config/database.js';

try {
  const sql = await readFile(new URL('../config/deployment.sql', import.meta.url), 'utf8');
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(13691, 1)');
    await db.query(sql);
  });
  console.log('Deployment tables verified.');
} catch (error) {
  console.error('Deployment schema setup failed:', error.code || error.name);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
