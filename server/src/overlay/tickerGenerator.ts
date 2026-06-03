import { createCanvas, GlobalFonts, type SKRSContext2D as CanvasRenderingContext2D } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ensureDir } from '../utils/fileUtils';
import { getPlaylistForDate } from '../playlist/builder';
import { buildTickerPreview } from '../overlays/controlPanel';

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
  stablePngPath?: string;
  stableWebmPath?: string;
  textContent: string;
  width: number;
  height: number;
  scrollCycleWidth: number;
}

export interface LoopedTickerLayout {
  textWidth: number;
  tileWidth: number;
  totalWidth: number;
  repeatCount: number;
}

let fontLoaded = false;
const TICKER_LOOP_SEPARATOR = '   •   ';
export const STABLE_TICKER_BASENAME = 'current-schedule';
const TICKER_EMPTY_TEXT = '\u062a\u0634\u0627\u0647\u062f\u0648\u0646 \u0627\u0644\u064a\u0648\u0645';
const TICKER_SCHEDULE_PREFIX = '\u062a\u0634\u0627\u0647\u062f\u0648\u0646 \u0639\u0644\u0649 \u0645\u062f\u0627\u0631 \u0627\u0644\u064a\u0648\u0645';
const TICKER_PROGRAM_SEPARATOR = ' \u2022 ';

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
  try {
    const previewText = buildTickerPreview({ mode: 'today', date }).text.trim();
    if (previewText && previewText !== TICKER_EMPTY_TEXT) return previewText;
  } catch (err) {
    logger.warn(`Could not build ticker text from active schedule: ${err}`);
  }

  const playlist = getPlaylistForDate(date);
  if (!playlist || playlist.items.length === 0) {
    return TICKER_EMPTY_TEXT;
  }

  const programNames = playlist.items
    .filter(item => item.type === 'program')
    .map(item => (item.title_ar ?? item.title).trim())
    .filter(Boolean)
    .filter((title, index, all) => all.indexOf(title) === index);

  if (programNames.length === 0) {
    return TICKER_EMPTY_TEXT;
  }

  return `${TICKER_SCHEDULE_PREFIX}: ${programNames.join(TICKER_PROGRAM_SEPARATOR)}`;
}

export function getStableTickerAssetPaths(): { pngPath: string; webmPath: string } {
  const tickerDir = path.join(config.paths.assets, 'overlays', 'tickers');
  return {
    pngPath: path.join(tickerDir, `${STABLE_TICKER_BASENAME}.png`),
    webmPath: path.join(tickerDir, `${STABLE_TICKER_BASENAME}.mp4`),
  };
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

function drawTickerBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bgColor: string
): void {
  if (bgColor.toLowerCase() !== 'gradient-blue') {
    const bg = parseColor(bgColor);
    ctx.fillStyle = `rgba(${bg.r},${bg.g},${bg.b},${bg.a})`;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#042B66');
  gradient.addColorStop(0.45, '#0B69D1');
  gradient.addColorStop(1, '#021A3D');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const shine = ctx.createLinearGradient(0, 0, 0, height);
  shine.addColorStop(0, 'rgba(255,255,255,0.22)');
  shine.addColorStop(0.45, 'rgba(255,255,255,0.04)');
  shine.addColorStop(1, 'rgba(0,0,0,0.24)');
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, width, height);
}

export async function generateTickerPng(
  date: string,
  tickerConfig?: Partial<TickerConfig>,
  textOverride?: string
): Promise<{ pngPath: string; textContent: string; width: number; height: number; scrollCycleWidth: number }> {
  const broadcastRes = config.broadcast.resolution.split('x');
  const broadcastWidth = tickerConfig?.width ?? parseInt(broadcastRes[0] ?? '1280', 10);

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

  const text = (textOverride?.trim() || buildTickerText(date)).trim();
  const loopText = `${text}${TICKER_LOOP_SEPARATOR}`;
  const fontFamily = fs.existsSync(cfg.fontPath) ? 'ArabicFont' : 'Arial';

  // Measure text width with a temp canvas
  const measureCanvas = createCanvas(100, cfg.height);
  const mCtx = measureCanvas.getContext('2d');
  mCtx.font = `${cfg.fontSize}px "${fontFamily}"`;
  const layout = calculateLoopedTickerLayout({
    screenWidth: cfg.width,
    textWidth: Math.ceil(mCtx.measureText(loopText).width),
    gapWidth: cfg.safeMargin,
  });

  const canvas = createCanvas(layout.totalWidth, cfg.height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  // Background
  drawTickerBackground(ctx, layout.totalWidth, cfg.height, cfg.bgColor);

  // Text — right-to-left Arabic
  ctx.font = `${cfg.fontSize}px "${fontFamily}"`;
  ctx.fillStyle = cfg.textColor;
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';

  for (let i = 0; i < layout.repeatCount; i++) {
    ctx.fillText(loopText, layout.textWidth + i * layout.tileWidth, cfg.height / 2);
  }

  ensureDir(path.join(config.paths.assets, 'overlays', 'tickers'));
  const pngPath = path.join(config.paths.assets, 'overlays', 'tickers', `${date}.png`);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(pngPath, buffer);

  logger.info(
    `Generated ticker PNG for ${date}: ${pngPath} ` +
      `(${layout.totalWidth}x${cfg.height}, cycle=${layout.tileWidth}px)`
  );
  return {
    pngPath,
    textContent: text,
    width: layout.totalWidth,
    height: cfg.height,
    scrollCycleWidth: layout.tileWidth,
  };
}

export async function generateTickerWebm(
  date: string,
  tickerConfig?: Partial<TickerConfig>,
  textOverride?: string
): Promise<TickerGenerationResult> {
  const { pngPath, textContent, width, height, scrollCycleWidth } = await generateTickerPng(date, tickerConfig, textOverride);

  const broadcastRes = config.broadcast.resolution.split('x');
  const broadcastWidth = parseInt(broadcastRes[0] ?? '1280', 10);
  const tickerSpeed = tickerConfig?.speed ?? config.overlay.tickerSpeed;
  const scrollDuration = Math.max(1, scrollCycleWidth / tickerSpeed);

  const webmPath = pngPath.replace('.png', '.mp4');

  // tickerSpeed is in px/sec. The scroll filter's `horizontal` value is a
  // per-frame fraction of the source width, so we must divide by fps × width:
  //   h = tickerSpeed_px_per_sec / (fps * src_width_px)
  // Without this correction the old formula (1/speed) ran ~fps× too fast.
  const fps = config.broadcast.fps;
  const h = (tickerSpeed / (fps * width)).toFixed(8);

  // Double hflip reverses scroll direction so Arabic text moves RIGHT-to-LEFT
  // (enters from the right, exits left) matching standard Arabic broadcast convention.
  // Characters are un-mirrored because the flip is applied twice.
  const scrollVf = `hflip,scroll=horizontal=${h}:v=0,hflip,crop=${broadcastWidth}:${height},format=yuv420p`;

  // Use FFmpeg scroll filter: scrolls the PNG horizontally
  const args = [
    '-y',
    '-loop', '1',
    '-t', String(scrollDuration),
    '-i', pngPath,
    '-vf', scrollVf,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
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

  const stablePaths = getStableTickerAssetPaths();
  fs.copyFileSync(pngPath, stablePaths.pngPath);
  fs.copyFileSync(webmPath, stablePaths.webmPath);
  logger.info(`Updated stable ticker assets: ${stablePaths.webmPath}`);

  return {
    pngPath,
    webmPath,
    stablePngPath: stablePaths.pngPath,
    stableWebmPath: stablePaths.webmPath,
    textContent,
    width,
    height,
    scrollCycleWidth,
  };
}

export function calculateLoopedTickerLayout(input: {
  screenWidth: number;
  textWidth: number;
  gapWidth: number;
}): LoopedTickerLayout {
  const screenWidth = Math.max(1, Math.ceil(input.screenWidth));
  const textWidth = Math.max(1, Math.ceil(input.textWidth));
  const gapWidth = Math.max(0, Math.ceil(input.gapWidth));
  const tileWidth = textWidth + gapWidth;
  const repeatCount = Math.max(3, Math.ceil((screenWidth + tileWidth) / tileWidth) + 2);
  return {
    textWidth,
    tileWidth,
    totalWidth: tileWidth * repeatCount,
    repeatCount,
  };
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
