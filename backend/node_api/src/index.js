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
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { initializeDatabase } from './config/database.js';
import { backfillRevisionKeys } from './services/revision-service.js';
import { createLogger } from './utils/logger.js';
import { startScheduler } from './services/scheduler-service.js';
import updatesRoutes from './routes/updates.js';
import sectionsRoutes from './routes/sections.js';
import monitorsRoutes from './routes/monitor.js';
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

dotenv.config();

// DGCA page and PDF downloads trust the same certificates as Windows (see utils/system-ca.js).
axios.defaults.httpsAgent = getHttpsAgent();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = createLogger('index');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
// The dashboard may be opened as localhost or 127.0.0.1 (start_dashboard.ps1 serves it on
// 127.0.0.1); FRONTEND_URL can add more addresses, comma-separated.
const allowedOrigins = [...new Set([
  ...String(process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean),
  'http://localhost:5173',
  'http://127.0.0.1:5173'
])];
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

// Initialize Database
try {
  await initializeDatabase();
  await backfillRevisionKeys();
  logger.info('Database initialized successfully');
} catch (error) {
  logger.error('Database initialization failed:', error);
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
  logger.error('Express error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
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
// Local-only by default: the API can change alert recipients, so other PCs on
// the network shouldn't reach it. Set HOST=0.0.0.0 to share it deliberately.
const HOST = process.env.HOST || '127.0.0.1';
if (!process.env.VERCEL) {
  app.listen(PORT, HOST, async () => {
    logger.info(`Server running on http://localhost:${PORT} (listening on ${HOST})`);
    logger.info('Starting DGCA monitoring scheduler...');
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
