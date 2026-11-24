import dotenv from 'dotenv';
import { initializeDatabase } from '../config/database.js';
import { checkForUpdates } from '../services/monitor-service.js';
import { createLogger } from '../utils/logger.js';

dotenv.config();

const logger = createLogger('continuous-monitor');
const INTERVAL_MINUTES = parseInt(process.env.MONITOR_INTERVAL_HOURS || '2') * 60;

async function main() {
  console.log('Initializing database...');
  await initializeDatabase();

  console.log(`\nStarting continuous monitoring every ${INTERVAL_MINUTES} minutes`);
  console.log('Press Ctrl+C to stop\n');

  // Run once immediately
  await runMonitoring();

  // Then run every interval
  setInterval(runMonitoring, INTERVAL_MINUTES * 60 * 1000);
}

async function runMonitoring() {
  const timestamp = new Date().toLocaleString('en-IN');
  console.log(`\n[${timestamp}] Running monitoring check...`);

  try {
    const result = await checkForUpdates();

    console.log(`✓ Items Found: ${result.itemsFound || 0}`);
    console.log(`✓ New Items: ${result.newItems || 0}`);
    console.log(`✓ Notifications Sent: ${result.notificationsSent || 0}`);
    console.log(`✓ Duration: ${result.duration || 0}ms`);

    if (!result.success) {
      console.error(`✗ Error: ${result.error}`);
    }
  } catch (error) {
    console.error(`✗ Fatal error: ${error.message}`);
    logger.error('Monitoring cycle failed:', { error: error.message });
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down gracefully...');
  process.exit(0);
});
