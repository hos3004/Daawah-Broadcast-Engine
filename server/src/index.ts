import 'dotenv/config';
import express from 'express';
import http from 'http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import cron from 'node-cron';
import dayjs from 'dayjs';

import { config } from './config';
import { initDb } from './db/schema';
import { ensureAdminUser, requireAuth } from './auth';
import { initWs } from './ws';
import { logger } from './utils/logger';
import { ensureDir } from './utils/fileUtils';
import { buildDailyPlaylist, getCurrentAndNext } from './playlist/builder';
import { checkHlsHealth, getBroadcastState, stopBroadcast, tryAutoResumeBroadcastOnStartup } from './broadcast/ffmpegRunner';
import { checkFfmpeg, checkFfprobe } from './media/ffprobe';
import { startMonitoring } from './monitoring';
import { startTranscodeWorker } from './workers/transcodeWorker';

import { authRouter } from './api/routes/auth';
import { mediaRouter } from './api/routes/media';
import { scheduleRouter } from './api/routes/schedule';
import { broadcastRouter } from './api/routes/broadcast';
import { overlaysRouter } from './api/routes/overlays';
import { systemRouter } from './api/routes/system';
import { schedulerFoundationRouter } from './api/routes/schedulerFoundation';

async function main(): Promise<void> {
  // Init directories
  const dirs = [
    config.paths.data,
    config.paths.assets,
    config.paths.playlists,
    config.paths.logs,
    config.paths.hlsOutput,
    path.join(config.paths.assets, 'overlays', 'logo'),
    path.join(config.paths.assets, 'overlays', 'tickers'),
    path.join(config.paths.assets, 'overlays', 'now-playing'),
    path.join(config.paths.assets, 'fonts'),
    path.join(config.paths.data, 'uploads'),
  ];
  dirs.forEach(ensureDir);

  // Init DB
  initDb();
  ensureAdminUser();

  const app = express();
  const server = http.createServer(app);

  // Security middlewares
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(cors({
    origin: config.security.corsOrigin,
    credentials: true,
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser(config.security.cookieSecret));

  if (config.env === 'production') {
    app.set('trust proxy', 1);
  }

  // ── Public routes ──────────────────────────────────────────────
  app.get('/health', async (_req, res): Promise<void> => {
    const [ffmpegOk, ffprobeOk] = await Promise.all([checkFfmpeg(), checkFfprobe()]);
    const hls = checkHlsHealth();
    const broadcast = getBroadcastState();
    const ok = ffmpegOk && ffprobeOk;
    res.status(ok ? 200 : 503).json({
      ok,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      broadcast: broadcast.status,
      hls: hls.ok ? 'ok' : `stale (${Math.round(hls.ageSeconds)}s)`,
      ffmpeg: ffmpegOk ? 'ok' : 'missing',
      ffprobe: ffprobeOk ? 'ok' : 'missing',
    });
  });

  // Public now/next (for display boards, widgets, etc.)
  app.get('/api/now', (_req, res): void => {
    const date = dayjs().format('YYYY-MM-DD');
    const { current, next, lookahead } = getCurrentAndNext(date);
    res.json({ current, next, lookahead, timestamp: Date.now() });
  });

  app.get('/api/next', (_req, res): void => {
    const date = dayjs().format('YYYY-MM-DD');
    const { next } = getCurrentAndNext(date);
    res.json({ next });
  });

  // HLS stream (dev only; production uses Nginx direct)
  if (config.env !== 'production') {
    app.use('/hls', express.static(config.paths.hlsOutput));
  }

  // ── Auth routes (public) ───────────────────────────────────────
  app.use('/api/auth', authRouter);

  // ── Protected API routes ───────────────────────────────────────
  app.use('/api/media',     requireAuth, mediaRouter);
  app.use('/api/schedules', requireAuth, scheduleRouter);
  app.use('/api/broadcast', requireAuth, broadcastRouter);
  app.use('/api/overlays',  requireAuth, overlaysRouter);
  app.use('/api/system',    requireAuth, systemRouter);
  app.use('/api/scheduler-foundation', requireAuth, schedulerFoundationRouter);

  // Admin dashboard SPA (production; dev uses Vite proxy)
  if (config.env === 'production') {
    const adminBuildPath = path.resolve(__dirname, '../../web/dist');
    app.use('/admin', express.static(adminBuildPath));
    app.get('/admin/*', (_req, res) => res.sendFile(path.join(adminBuildPath, 'index.html')));
  }

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', err);
    res.status(500).json({ error: config.env === 'development' ? err.message : 'Internal server error' });
  });

  // WebSocket
  initWs(server);

  // ── Cron jobs ──────────────────────────────────────────────────
  // Build next-day playlist at configured hour
  cron.schedule(`0 ${config.playlist.buildHour} * * *`, async () => {
    const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
    logger.info(`Cron: building playlist for ${tomorrow}`);
    try {
      await buildDailyPlaylist(tomorrow);
    } catch (err) {
      logger.error(`Cron playlist build failed for ${tomorrow}`, err);
    }
  });

  // Start background workers
  startMonitoring();
  startTranscodeWorker();

  // Start server
  server.listen(config.port, config.host, () => {
    logger.info(`Daawah Broadcast Engine running on http://${config.host}:${config.port}`);
    logger.info(`Environment: ${config.env}`);
    logger.info(`DB: ${config.db.path}`);
    logger.info(`Media: ${config.paths.mediaLibrary}`);
    void tryAutoResumeBroadcastOnStartup();
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal} — shutting down gracefully`);
    try {
      const broadcast = getBroadcastState();
      if (broadcast.status !== 'idle') {
        await stopBroadcast('shutdown');
      }
    } catch (err) {
      logger.error('Broadcast shutdown cleanup failed', err);
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
