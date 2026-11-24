import cron from 'node-cron';
import { checkForUpdates } from './monitor-service.js';
import { getSettings } from './settings-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('scheduler');

let scheduledJob = null;
let activeExpression = null;

async function settings() {
  return {
    minutes: Math.max(5, (await getSettings()).intervalMinutes),
    startHour: parseInt(process.env.MONITOR_START_HOUR || '0', 10),
    endHour: parseInt(process.env.MONITOR_END_HOUR || '23', 10)
  };
}

async function schedule() {
  const { minutes, startHour, endHour } = await settings();
  // Fields: second minute hour day month weekday. Steps under an hour go in the
  // minute field; longer intervals step through the hour field.
  const cronExpression = minutes < 60
    ? `0 */${minutes} ${startHour}-${endHour} * * *`
    : `0 0 ${startHour}-${endHour}/${Math.round(minutes / 60)} * * *`;

  if (scheduledJob) scheduledJob.destroy();
  // noOverlap: a check still running when the next one is due is not started twice.
  scheduledJob = cron.schedule(cronExpression, async () => {
    logger.info('Scheduled monitoring cycle started');
    await checkForUpdates();
  }, { timezone: 'Asia/Kolkata', noOverlap: true });
  activeExpression = cronExpression;

  logger.info(`Scheduler set: ${cronExpression} (every ${minutes} minutes between ${startHour}:00 and ${endHour}:59 IST)`);
}

export async function startScheduler() {
  try {
    await schedule();
    setTimeout(async () => {
      logger.info('Running initial monitoring check...');
      await checkForUpdates();
    }, 5000);
    return true;
  } catch (error) {
    logger.error('Failed to start scheduler:', { error: error.message });
    return false;
  }
}

// Called after the check interval is changed in Settings.
export async function restartScheduler() {
  await schedule();
}

export function stopScheduler() {
  if (scheduledJob) {
    scheduledJob.destroy();
    scheduledJob = null;
    logger.info('Scheduler stopped');
  }
}

export async function getSchedulerStatus() {
  const { minutes, startHour, endHour } = await settings();
  return {
    running: scheduledJob !== null,
    intervalMinutes: minutes,
    startHour,
    endHour,
    cron: activeExpression
  };
}
