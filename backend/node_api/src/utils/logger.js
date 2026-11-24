import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || './logs';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const currentLevel = levels[LOG_LEVEL] || levels.info;

export function createLogger(module) {
  const timestamp = () => new Date().toISOString();

  return {
    error: (message, data) => {
      if (currentLevel >= levels.error) {
        const logEntry = `[${timestamp()}] [${module}] ERROR: ${message} ${data ? JSON.stringify(data) : ''}`;
        console.error(logEntry);
        appendLog(logEntry, 'error');
      }
    },
    warn: (message, data) => {
      if (currentLevel >= levels.warn) {
        const logEntry = `[${timestamp()}] [${module}] WARN: ${message} ${data ? JSON.stringify(data) : ''}`;
        console.warn(logEntry);
        appendLog(logEntry, 'warn');
      }
    },
    info: (message, data) => {
      if (currentLevel >= levels.info) {
        const logEntry = `[${timestamp()}] [${module}] INFO: ${message} ${data ? JSON.stringify(data) : ''}`;
        console.log(logEntry);
        appendLog(logEntry, 'info');
      }
    },
    debug: (message, data) => {
      if (currentLevel >= levels.debug) {
        const logEntry = `[${timestamp()}] [${module}] DEBUG: ${message} ${data ? JSON.stringify(data) : ''}`;
        console.debug(logEntry);
        appendLog(logEntry, 'debug');
      }
    }
  };
}

function appendLog(message, level) {
  const logFile = path.join(LOG_DIR, 'application.log');
  try {
    fs.appendFileSync(logFile, message + '\n');
  } catch (err) {
    console.error('Failed to write log:', err);
  }
}
