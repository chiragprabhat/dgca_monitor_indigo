import { closeDatabase } from '../config/database.js';
import { runActionsWorker } from '../services/actions-worker.js';

try {
  const result = await runActionsWorker();
  if (result.busy) console.log('Another DGCA worker holds the database lock.');
  else console.log('Jobs processed:', result.processed);
  if (result.monitoring?.sectionResults) {
    console.log('DGCA sections:', JSON.stringify(result.monitoring.sectionResults));
  }
  if (result.monitoring?.success === false) {
    console.error('Monitoring failed. Check summary configuration and the dashboard monitoring log.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error('DGCA worker failed:', error.code || error.name);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
