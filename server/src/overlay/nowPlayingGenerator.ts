import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ensureDir } from '../utils/fileUtils';
import type { PlaylistItem } from '../playlist/builder';

let fontLoaded = false;

function ensureFont(): void {
  if (fontLoaded) return;
  try {
    const fontPath = config.overlay.fontPath;
    if (fs.existsSync(fontPath)) {
      GlobalFonts.registerFromPath(fontPath, 'ArabicFont');
      fontLoaded = true;
    }
  } catch (err) {
    logger.warn(`Could not register font: ${err}`);
  }
}

export interface NowPlayingConfig {
  width: number;
  height: number;
  fontSize: number;
  subtitleFontSize: number;
  textColor: string;
  bgColor: string;
  accentColor: string;
  position: 'left' | 'center' | 'right';
  safeMargin: number;
}

export async function generateNowPlayingPng(
  item: PlaylistItem,
  customConfig?: Partial<NowPlayingConfig>
): Promise<string> {
  ensureFont();

  const broadcastRes = config.broadcast.resolution.split('x');
  const broadcastWidth = parseInt(broadcastRes[0] ?? '1280', 10);
  const broadcastHeight = parseInt(broadcastRes[1] ?? '720', 10);

  const cfg: NowPlayingConfig = {
    width: broadcastWidth,
    height: broadcastHeight,
    fontSize: customConfig?.fontSize ?? config.overlay.nowPlayingFontSize,
    subtitleFontSize: customConfig?.subtitleFontSize ?? Math.round(config.overlay.nowPlayingFontSize * 0.65),
    textColor: customConfig?.textColor ?? '#FFFFFF',
    bgColor: customConfig?.bgColor ?? 'rgba(0,0,0,0.75)',
    accentColor: customConfig?.accentColor ?? '#E8A020',
    position: customConfig?.position ?? config.overlay.nowPlayingPosition,
    safeMargin: customConfig?.safeMargin ?? 40,
  };

  const canvas = createCanvas(cfg.width, cfg.height);
  const ctx = canvas.getContext('2d');

  // Transparent background
  ctx.clearRect(0, 0, cfg.width, cfg.height);

  const fontFamily = fs.existsSync(config.overlay.fontPath) ? 'ArabicFont' : 'Arial';

  // Card dimensions
  const cardWidth = Math.min(600, cfg.width - cfg.safeMargin * 2);
  const cardHeight = 100;
  const cardY = cfg.height - cardHeight - cfg.safeMargin - 60;

  let cardX: number;
  if (cfg.position === 'left') cardX = cfg.safeMargin;
  else if (cfg.position === 'right') cardX = cfg.width - cardWidth - cfg.safeMargin;
  else cardX = (cfg.width - cardWidth) / 2;

  // Accent bar
  ctx.fillStyle = cfg.accentColor;
  ctx.fillRect(cardX, cardY, 6, cardHeight);

  // Card background
  ctx.fillStyle = cfg.bgColor;
  ctx.fillRect(cardX + 6, cardY, cardWidth - 6, cardHeight);

  // "الآن يُعرض" label
  ctx.fillStyle = cfg.accentColor;
  ctx.font = `bold ${cfg.subtitleFontSize}px "${fontFamily}"`;
  ctx.textBaseline = 'top';
  ctx.direction = 'rtl';
  const labelX = cfg.position === 'left' ? cardX + cardWidth - cfg.safeMargin : cardX + cfg.safeMargin;
  ctx.fillText('الآن يُعرض', labelX, cardY + 12);

  // Program title
  ctx.fillStyle = cfg.textColor;
  ctx.font = `bold ${cfg.fontSize}px "${fontFamily}"`;
  ctx.fillText(item.title_ar ?? item.title, labelX, cardY + 12 + cfg.subtitleFontSize + 6);

  ensureDir(path.join(config.paths.assets, 'overlays', 'now-playing'));
  const pngPath = path.join(config.paths.assets, 'overlays', 'now-playing', `${item.id}.png`);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(pngPath, buffer);

  logger.debug(`Generated now-playing PNG: ${pngPath}`);
  return pngPath;
}

export async function generateNowPlayingForPlaylist(playlistItems: PlaylistItem[]): Promise<void> {
  const programs = playlistItems.filter(i => i.show_lower_third);
  logger.info(`Generating now-playing PNGs for ${programs.length} program items`);

  for (const item of programs) {
    try {
      const pngPath = await generateNowPlayingPng(item);
      item.lower_third_path = pngPath;
    } catch (err) {
      logger.error(`Failed now-playing PNG for item ${item.id}`, err);
    }
  }
}
