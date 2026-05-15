import { createCanvas, GlobalFonts, type SKRSContext2D as CanvasRenderingContext2D } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ensureDir } from '../utils/fileUtils';
import { getPlaylistForDate } from '../playlist/builder';

const execFileAsync = promisify(execFile);

export interface TickerConfig {
  width: number;
  height: number;
  fontSize: number;
  textColor: string;
  bgColor: string;
  speed: number;
  safeMargin: number;
  fontPath: string;
}

export interface TickerGenerationResult {
  pngPath: string;
  webmPath: string;
  textContent: string;
  width: number;
  height: number;
}

let fontLoaded = false;

function loadFont(fontPath: string): void {
  if (fontLoaded) return;
  try {
    if (fs.existsSync(fontPath)) {
      GlobalFonts.registerFromPath(fontPath, 'ArabicFont');
      fontLoaded = true;
    }
  } catch (err) {
    logger.warn(`Could not register font ${fontPath}: ${err}`);
  }
}

function buildTickerText(date: string): string {
  const playlist = getPlaylistForDate(date);
  if (!playlist || playlist.items.length === 0) {
    return `بث مباشر على مدار الساعة — ${date}`;
  }

  const programs = playlist.items
    .filter(item => item.type === 'program')
    .slice(0, 10);

  if (programs.length === 0) {
    return `تشاهدون اليوم: بث مستمر ${date}`;
  }

  const parts = programs.map(item => {
    const time = new Date(item.start_time_ms).toLocaleTimeString('ar-SA', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${item.title_ar ?? item.title} ${time}`;
  });

  return `تشاهدون اليوم: ${parts.join('  |  ')}      `;
}

function parseColor(colorStr: string): { r: number; g: number; b: number; a: number } {
  if (colorStr.startsWith('#')) {
    const hex = colorStr.slice(1);
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
  }
  return { r: 0, g: 0, b: 0, a: 0.6 };
}

export async function generateTickerPng(
  date: string,
  tickerConfig?: Partial<TickerConfig>
): Promise<{ pngPath: string; textContent: string; width: number; height: number }> {
  const broadcastRes = config.broadcast.resolution.split('x');
  const broadcastWidth = parseInt(broadcastRes[0] ?? '1280', 10);

  const cfg: TickerConfig = {
    width: broadcastWidth,
    height: tickerConfig?.height ?? config.overlay.tickerHeight,
    fontSize: tickerConfig?.fontSize ?? config.overlay.tickerFontSize,
    textColor: tickerConfig?.textColor ?? config.overlay.tickerTextColor,
    bgColor: tickerConfig?.bgColor ?? config.overlay.tickerBgColor,
    speed: tickerConfig?.speed ?? config.overlay.tickerSpeed,
    safeMargin: tickerConfig?.safeMargin ?? config.overlay.tickerSafeMargin,
    fontPath: tickerConfig?.fontPath ?? config.overlay.fontPath,
  };

  loadFont(cfg.fontPath);

  const text = buildTickerText(date);
  const fontFamily = fs.existsSync(cfg.fontPath) ? 'ArabicFont' : 'Arial';

  // Measure text width with a temp canvas
  const measureCanvas = createCanvas(100, cfg.height);
  const mCtx = measureCanvas.getContext('2d');
  mCtx.font = `${cfg.fontSize}px "${fontFamily}"`;
  const metrics = mCtx.measureText(text);
  const textWidth = Math.ceil(metrics.width) + cfg.safeMargin * 2;

  // The PNG must be wide enough to scroll (screen width + text width)
  const totalWidth = cfg.width + textWidth + cfg.width;

  const canvas = createCanvas(totalWidth, cfg.height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  // Background
  const bg = parseColor(cfg.bgColor);
  ctx.fillStyle = `rgba(${bg.r},${bg.g},${bg.b},${bg.a})`;
  ctx.fillRect(0, 0, totalWidth, cfg.height);

  // Text — right-to-left Arabic
  ctx.font = `${cfg.fontSize}px "${fontFamily}"`;
  ctx.fillStyle = cfg.textColor;
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';

  // Draw text starting from right side
  ctx.fillText(text, cfg.safeMargin + textWidth, cfg.height / 2);

  ensureDir(path.join(config.paths.assets, 'overlays', 'tickers'));
  const pngPath = path.join(config.paths.assets, 'overlays', 'tickers', `${date}.png`);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(pngPath, buffer);

  logger.info(`Generated ticker PNG for ${date}: ${pngPath} (${totalWidth}x${cfg.height})`);
  return { pngPath, textContent: text, width: totalWidth, height: cfg.height };
}

export async function generateTickerWebm(date: string): Promise<TickerGenerationResult> {
  const { pngPath, textContent, width, height } = await generateTickerPng(date);

  const broadcastRes = config.broadcast.resolution.split('x');
  const broadcastWidth = parseInt(broadcastRes[0] ?? '1280', 10);
  const scrollDuration = Math.ceil(width / config.overlay.tickerSpeed);

  const webmPath = pngPath.replace('.png', '.webm');

  // Use FFmpeg scroll filter: scrolls the PNG horizontally
  const args = [
    '-y',
    '-loop', '1',
    '-t', String(scrollDuration),
    '-i', pngPath,
    '-vf', `scroll=horizontal=1/${config.overlay.tickerSpeed}:v=0,crop=${broadcastWidth}:${height},format=yuva420p`,
    '-c:v', 'libvpx-vp9',
    '-b:v', '0',
    '-crf', '18',
    '-auto-alt-ref', '0',
    '-pix_fmt', 'yuva420p',
    '-an',
    webmPath,
  ];

  try {
    await execFileAsync(config.ffmpeg.ffmpegPath, args, { timeout: 300000 });
    logger.info(`Generated ticker WebM for ${date}: ${webmPath}`);
  } catch (err) {
    logger.error(`Failed to generate ticker WebM for ${date}`, err);
    throw new Error(`FFmpeg ticker encoding failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { pngPath, webmPath, textContent, width, height };
}

export async function generateTickerMonth(yearMonth: string): Promise<void> {
  const [year, month] = yearMonth.split('-').map(Number);
  if (!year || !month) throw new Error('yearMonth must be YYYY-MM');

  const daysInMonth = new Date(year, month, 0).getDate();
  logger.info(`Generating ticker WebMs for ${daysInMonth} days in ${yearMonth}`);

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    try {
      await generateTickerWebm(date);
    } catch (err) {
      logger.error(`Failed ticker for ${date}`, err);
    }
  }
}
