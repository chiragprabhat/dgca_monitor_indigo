import cron from 'node-cron';
import { checkForUpdates } from './monitor-service.js';
import { getSettings } from './settings-service.js';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../config/database.js';

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

function scheduleExpression({ minutes, startHour, endHour }) {
  // Fields: second minute hour day month weekday. Steps under an hour go in the
  // minute field; longer intervals step through the hour field.
  return minutes < 60
    ? `0 */${minutes} ${startHour}-${endHour} * * *`
    : `0 0 ${startHour}-${endHour}/${Math.round(minutes / 60)} * * *`;
}

export async function getGitHubMonitoringSlot(now = new Date()) {
  const { minutes, startHour, endHour } = await settings();
  if (minutes < 60 && (minutes < 15 || minutes % 15 !== 0)) {
    throw new Error('MONITOR_SCHEDULER=github requires sub-hour intervals in multiples of 15 minutes');
  }
  if (!(startHour >= 0 && endHour <= 23 && startHour <= endHour)) {
    throw new Error('Set MONITOR_START_HOUR and MONITOR_END_HOUR to a valid IST hour window');
  }
  const istOffset = 330 * 60000;
  const current = new Date(now.getTime() + istOffset);
  const hour = current.getUTCHours();
  if (hour < startHour || hour > endHour) return null;
  if (minutes < 60) {
    current.setUTCMinutes(Math.floor(current.getUTCMinutes() / minutes) * minutes, 0, 0);
  } else {
    const stepHours = Math.round(minutes / 60);
    current.setUTCHours(startHour + Math.floor((hour - startHour) / stepHours) * stepHours, 0, 0, 0);
  }
  return new Date(current.getTime() - istOffset).toISOString();
}

async function schedule() {
  const config = await settings();
  const { minutes, startHour, endHour } = config;
  const cronExpression = scheduleExpression(config);

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
  if (process.env.MONITOR_SCHEDULER === 'github') return true;
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
  if (process.env.MONITOR_SCHEDULER === 'github' || process.env.VERCEL === '1') return;
  await schedule();
}

export function stopScheduler() {
  if (scheduledJob) {
    scheduledJob.destroy();
    scheduledJob = null;
    logger.info('Scheduler stopped');
  }
}

export function nextNeonExecution(now) {
  const period = 30 * 60 * 1000;
  const offset = 7 * 60 * 1000;
  return new Date((Math.floor((now - offset) / period) + 1) * period + offset).toISOString();
}

export async function getSchedulerStatus() {
  const config = await settings();
  const { minutes, startHour, endHour } = config;
  const hosted = process.env.VERCEL === '1';
  const external = hosted || process.env.MONITOR_SCHEDULER === 'github';
  const heartbeat = hosted ? await getDatabase().prepare(
    "SELECT updated_at, value FROM config WHERE key = 'actions_worker_heartbeat'"
  ).get() : undefined;
  const neon = heartbeat?.value === 'neon';
  const now = Date.now();
  const heartbeatTime = heartbeat?.updated_at ? Date.parse(`${heartbeat.updated_at.replace(' ', 'T')}Z`) : NaN;
  const healthy = heartbeatTime > now - 45 * 60 * 1000;
  return {
    running: hosted ? healthy : external || scheduledJob !== null,
    intervalMinutes: minutes,
    startHour,
    endHour,
    cron: neon ? '7,37 * * * *' : external ? scheduleExpression(config) : activeExpression,
    ...(neon && {
      provider: 'neon',
      heartbeatAt: Number.isFinite(heartbeatTime) ? new Date(heartbeatTime).toISOString() : null,
      nextExpectedRunAt: healthy ? nextNeonExecution(now) : null
    })
  };
}
