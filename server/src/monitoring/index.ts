import cron from 'node-cron';
import os from 'os';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sendTelegramAlert } from './telegram';
import { checkHlsHealth, getBroadcastState, reactToHlsStale } from '../broadcast/ffmpegRunner';
import { diskUsage } from '../utils/fileUtils';

let monitoringStarted = false;

export function startMonitoring(): void {
  if (monitoringStarted) return;
  monitoringStarted = true;

  // Check HLS health every 30 seconds
  const hlsInterval = config.monitoring.healthCheckInterval;
  setInterval(checkHlsStatus, hlsInterval);

  // Check disk usage every 10 minutes
  cron.schedule('*/10 * * * *', checkDiskUsage);

  // Check broadcast status every minute
  cron.schedule('* * * * *', checkBroadcastStatus);

  logger.info('Monitoring started');
}

async function checkHlsStatus(): Promise<void> {
  const hls = checkHlsHealth();
  const broadcast = getBroadcastState();

  if (broadcast.status === 'running' && !hls.ok) {
    logger.warn(`HLS stale: ${Math.round(hls.ageSeconds)}s — triggering reaction`);
    try {
      await sendTelegramAlert({
        level: 'error',
        title: 'HLS Stream Stale',
        message: `Stream not updated for ${Math.round(hls.ageSeconds)} seconds. Attempting restart.`,
      });
    } catch (alertErr) {
      logger.warn('Telegram alert failed during HLS stale check', alertErr);
    }
    try {
      await reactToHlsStale();
    } catch (err) {
      logger.error('reactToHlsStale threw unexpectedly', err);
    }
  }
}

async function checkDiskUsage(): Promise<void> {
  const mediaDisk = diskUsage(config.paths.mediaLibrary);
  if (mediaDisk.percent >= config.monitoring.diskAlertThreshold) {
    logger.warn(`Disk usage high: ${mediaDisk.percent}%`);
    await sendTelegramAlert({
      level: mediaDisk.percent >= 95 ? 'critical' : 'warning',
      title: 'Disk Usage Alert',
      message: `Media disk at ${mediaDisk.percent}% capacity. Please free space or add storage.`,
    });
  }
}

async function checkBroadcastStatus(): Promise<void> {
  const state = getBroadcastState();
  if (state.status === 'error') {
    await sendTelegramAlert({
      level: 'critical',
      title: 'FFmpeg Stopped',
      message: `Broadcast engine is in error state. Last error: ${state.lastError ?? 'unknown'}. Restart count: ${state.restartCount}`,
    });
  }
}

export async function sendAlert(title: string, message: string, level: 'info' | 'warning' | 'error' | 'critical' = 'info'): Promise<void> {
  logger.warn(`Alert [${level}]: ${title} — ${message}`);
  await sendTelegramAlert({ level, title, message });
}
