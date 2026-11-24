import 'dotenv/config';

// Polyfill for File API (needed for undici compatibility with Node 18.17.0)
if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File {
    constructor(bits, filename, options) {
      this.bits = bits;
      this.filename = filename;
      this.options = options || {};
    }
  };
}

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import { initializeDatabase, requireDirectMonitoringConnection } from './config/database.js';
import { createAccessPolicy } from './config/access.js';
import { backfillRevisionKeys } from './services/revision-service.js';
import { createLogger } from './utils/logger.js';
import { getGitHubMonitoringSlot, startScheduler } from './services/scheduler-service.js';
import updatesRoutes from './routes/updates.js';
import sectionsRoutes from './routes/sections.js';
import monitorsRoutes, { scheduledMonitor } from './routes/monitor.js';
import notificationsRoutes from './routes/notifications.js';
import settingsRoutes from './routes/settings.js';
import systemRoutes from './routes/system.js';
import compareRoutes from './routes/compare.js';
import archiveRoutes from './routes/archive.js';
import searchRoutes from './routes/search.js';
import carsRoutes from './routes/cars.js';
import { syncCars, CHECK_EVERY_MINUTES } from './services/car-service.js';
import { startAnalysis } from './services/archive-service.js';
import axios from 'axios';
import { getHttpsAgent } from './utils/system-ca.js';

if (process.env.VERCEL) throw new Error('The full DGCA Express API requires a long-running host');

// DGCA page and PDF downloads trust the same certificates as Windows (see utils/system-ca.js).
axios.defaults.httpsAgent = getHttpsAgent();

const __filename = fileURLToPath(import.meta.url);
const logger = createLogger('index');

const app = express();
const access = createAccessPolicy();
const PORT = process.env.PORT || 5000;

app.disable('x-powered-by');
if (access.production) app.set('trust proxy', 'loopback');
app.use('/api', (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  next();
});
app.use('/api', access.requireHttps);
app.use(cors({
  origin: [...access.allowedOrigins],
  credentials: true
}));
app.post('/api/monitor/scheduled', access.requireScheduledTrigger, scheduledMonitor);
app.use('/api', access.requireOperator);
app.use(express.json());

// Initialize Database
try {
  if (access.production || process.env.MONITOR_SCHEDULER === 'github') requireDirectMonitoringConnection();
  await initializeDatabase();
  await backfillRevisionKeys();
  if (process.env.MONITOR_SCHEDULER === 'github') await getGitHubMonitoringSlot();
  logger.info('Database initialized successfully');
} catch (error) {
  logger.error(`Startup checks failed: ${error.message}`);
  process.exit(1);
}

// API Routes
app.use('/api/updates', updatesRoutes);
app.use('/api/sections', sectionsRoutes);
app.use('/api/monitor', monitorsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/compare', compareRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/cars', carsRoutes);

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  const status = err.status || 500;
  logger.error('Express error', { status, type: err.name });
  res.status(status).json({
    error: (access.production && status >= 500) ? 'Internal Server Error' : err.message || 'Internal Server Error',
    timestamp: new Date().toISOString()
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path
  });
});

// Start Server
const HOST = access.host;
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(PORT, HOST, async () => {
    logger.info(`Server running on http://localhost:${PORT} (listening on ${HOST})`);
    logger.info(process.env.MONITOR_SCHEDULER === 'github' ? 'Waiting for GitHub monitoring triggers' : 'Starting DGCA monitoring scheduler');
    await startScheduler();
    // Finish analysing any archive imports left over from before a restart.
    setTimeout(startAnalysis, 60000);
    // Keep the stored CARs in step with DGCA: shortly after start, then every hour.
    setTimeout(() => syncCars().catch(() => {}), 90000);
    setInterval(() => syncCars().catch(() => {}), CHECK_EVERY_MINUTES * 60 * 1000);
  }).on('error', (error) => {
    // If the API is started twice (e.g. start_backend.ps1 run again), the second copy just steps aside.
    if (error.code === 'EADDRINUSE') {
      logger.info(`Port ${PORT} is already in use - the API is probably already running. Exiting.`);
      process.exit(0);
    }
    throw error;
  });
}

export default app;
