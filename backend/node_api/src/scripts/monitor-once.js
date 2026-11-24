import dotenv from 'dotenv';
import { initializeDatabase } from '../config/database.js';
import { checkForUpdates } from '../services/monitor-service.js';

dotenv.config();

async function main() {
  console.log('Initializing database...');
  await initializeDatabase();

  console.log('Running monitoring check...');
  const result = await checkForUpdates();

  console.log('\n=== Monitoring Result ===');
  console.log(`Success: ${result.success}`);
  console.log(`Items Found: ${result.itemsFound || 0}`);
  console.log(`New Items: ${result.newItems || 0}`);
  console.log(`Notifications Sent: ${result.notificationsSent || 0}`);
  console.log(`Duration: ${result.duration || 0}ms`);

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
