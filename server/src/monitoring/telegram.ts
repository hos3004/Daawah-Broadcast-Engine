import https from 'https';
import { config } from '../config';
import { logger } from '../utils/logger';

export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

export interface Alert {
  level: AlertLevel;
  title: string;
  message: string;
  timestamp?: string;
}

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info:     'ℹ️',
  warning:  '⚠️',
  error:    '🔴',
  critical: '🚨',
};

let lastAlertTime: Record<string, number> = {};
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes between same alerts

function shouldSend(key: string): boolean {
  const now = Date.now();
  const last = lastAlertTime[key] ?? 0;
  if (now - last < DEBOUNCE_MS) return false;
  lastAlertTime[key] = now;
  return true;
}

export async function sendTelegramAlert(alert: Alert): Promise<void> {
  if (!config.telegram.enabled || !config.telegram.botToken || !config.telegram.chatId) {
    logger.debug(`Telegram disabled — suppressed alert: [${alert.level}] ${alert.title}`);
    return;
  }

  const key = `${alert.level}:${alert.title}`;
  if (!shouldSend(key)) return;

  const ts = alert.timestamp ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = [
    `${LEVEL_EMOJI[alert.level]} *${escapeMarkdown(alert.title)}*`,
    escapeMarkdown(alert.message),
    `_${ts} UTC_`,
  ].join('\n');

  const payload = JSON.stringify({
    chat_id:    config.telegram.chatId,
    text,
    parse_mode: 'MarkdownV2',
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${config.telegram.botToken}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });

    req.on('error', (err) => {
      logger.error('Telegram alert failed', err);
      resolve();
    });

    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  });
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
