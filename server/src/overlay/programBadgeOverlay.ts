import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { ensureDir } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import type { PlaylistItem } from '../playlist/builder';

export interface ProgramBadgeRange {
  startSeconds: number;
  endSeconds: number;
}

export interface ProgramBadgeTextLayer {
  /** Full-frame transparent PNG with the program title rendered by canvas. */
  pngPath: string;
  /** Time ranges during which this title is visible. */
  ranges: ProgramBadgeRange[];
}

export interface ProgramBadgeOverlayAssets {
  templatePath: string;
  /** One transparent PNG per program title, overlaid via ffmpeg `overlay`. */
  textLayers: ProgramBadgeTextLayer[];
  backgroundRanges: ProgramBadgeRange[];
  eventCount: number;
}

export interface ProgramBadgeOverlayOptions {
  date: string;
  width: number;
  height: number;
  tickerHeight: number;
  templatePath?: string;
  outputDir?: string;
  maxWords?: number;
  fontPath?: string;
  fontSize?: number;
}

interface ProgramBadgeGroup {
  title: string;
  ranges: ProgramBadgeRange[];
}

// NOTE: The badge text is rendered by @napi-rs/canvas (Skia + a modern HarfBuzz),
// the SAME engine the ticker uses, then composited over the video with ffmpeg's
// `overlay` filter. The previous implementation drew the text with libass (ffmpeg
// `subtitles` filter); under this server's older libass/HarfBuzz build several
// contextual Arabic forms (آ ت ق ى …) rendered as .notdef boxes (tofu) for Tajawal
// and every other modern Arabic font we tried. Canvas shapes the identical text
// correctly, so the badge now uses the project's Tajawal font like the ticker does.
// FFmpeg only ever sees a pre-rendered PNG, never raw text needing shaping.
const DEFAULT_FONT_PATH = config.overlay.fontPath;
const FONT_FAMILY = 'ProgramBadgeFont';
const DEFAULT_MAX_WORDS = 3;
const DEFAULT_FONT_SIZE = 30;
const BADGE_TEXT_RIGHT = 137;
const BADGE_HEIGHT = 45;
const BADGE_Y_MARGIN_ABOVE_TICKER = 8;
const TEXT_COLOR = '#FFFFFF';

let fontLoaded = false;
let fontAvailable = false;

function ensureFontLoaded(fontPath: string): boolean {
  if (fontLoaded) return fontAvailable;
  fontLoaded = true;
  try {
    if (fs.existsSync(fontPath)) {
      GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
      fontAvailable = true;
    } else {
      logger.warn(`Program badge font was not found: ${fontPath}`);
    }
  } catch (err) {
    logger.warn(`Could not register program badge font ${fontPath}: ${err}`);
  }
  return fontAvailable;
}

export function prepareProgramBadgeOverlayAssets(
  items: PlaylistItem[],
  playbackStartMs: number,
  options: ProgramBadgeOverlayOptions
): ProgramBadgeOverlayAssets | null {
  const templatePath = options.templatePath ?? config.overlay.programBadgeTemplatePath;
  if (!fs.existsSync(templatePath)) {
    logger.warn(`Program badge template was not found: ${templatePath}`);
    return null;
  }

  const groups = collectProgramBadgeGroups(
    items,
    playbackStartMs,
    options.maxWords ?? config.overlay.programBadgeMaxWords ?? DEFAULT_MAX_WORDS
  );
  if (groups.length === 0) return null;

  const fontPath = options.fontPath ?? DEFAULT_FONT_PATH;
  const fontFamily = ensureFontLoaded(fontPath) ? FONT_FAMILY : 'sans-serif';

  const outputDir = options.outputDir ?? path.join(config.paths.data, 'overlays', 'program-badges');
  ensureDir(outputDir);

  const datePart = sanitizeFilePart(options.date);
  const textLayers: ProgramBadgeTextLayer[] = [];
  groups.forEach((group, index) => {
    const pngPath = path.join(outputDir, `current-${datePart}-${index}.png`);
    const buffer = renderProgramBadgeTextPng(group.title, options, fontFamily);
    fs.writeFileSync(pngPath, buffer);
    textLayers.push({ pngPath, ranges: group.ranges });
  });

  return {
    templatePath,
    textLayers,
    backgroundRanges: mergeRanges(groups.flatMap(group => group.ranges)),
    eventCount: groups.reduce((count, group) => count + group.ranges.length, 0),
  };
}

export function collectProgramBadgeGroups(
  items: PlaylistItem[],
  playbackStartMs: number,
  maxWords = DEFAULT_MAX_WORDS
): ProgramBadgeGroup[] {
  const groups = new Map<string, ProgramBadgeRange[]>();

  for (const item of items) {
    if (!isProgramItem(item)) continue;
    const title = truncateProgramBadgeTitle(item.title_ar ?? item.title, maxWords);
    if (!title) continue;

    const startSeconds = Math.max(0, (item.start_time_ms - playbackStartMs) / 1000);
    const endSeconds = Math.max(0, (item.end_time_ms - playbackStartMs) / 1000);
    if (endSeconds - startSeconds < 0.5) continue;

    const ranges = groups.get(title) ?? [];
    ranges.push({ startSeconds, endSeconds });
    groups.set(title, ranges);
  }

  return [...groups.entries()].map(([title, ranges]) => ({
    title,
    ranges: mergeRanges(ranges),
  }));
}

export function truncateProgramBadgeTitle(value: string | null | undefined, maxWords = DEFAULT_MAX_WORDS): string {
  const title = cleanTitle(value);
  if (!title) return '';
  const limit = Math.max(1, Math.floor(maxWords));
  return title.split(/\s+/u).slice(0, limit).join(' ');
}

export function buildOverlayEnableExpression(ranges: ProgramBadgeRange[]): string {
  return ranges
    .map(range => `between(t,${formatFilterSeconds(range.startSeconds)},${formatFilterSeconds(range.endSeconds)})`)
    .join('+');
}

/**
 * Renders the program title as a full-frame transparent PNG, positioned exactly
 * where the old ASS layout placed it: right-aligned at x=BADGE_TEXT_RIGHT, centred
 * vertically inside the badge pill, growing leftward (RTL). Using full-frame
 * coordinates keeps the placement identical to the previous libass behaviour and
 * lets ffmpeg overlay the layer at 0:0.
 */
function renderProgramBadgeTextPng(
  title: string,
  options: ProgramBadgeOverlayOptions,
  fontFamily: string
): Buffer {
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const fontSize = Math.max(10, Math.round(options.fontSize ?? DEFAULT_FONT_SIZE));
  const badgeY = programBadgeY(height, options.tickerHeight);
  const textY = badgeY + Math.round(BADGE_HEIGHT / 2);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // `bold` gives the thicker weight requested; Skia synthesises it when the
  // registered face has no dedicated bold instance (Tajawal-Medium).
  ctx.font = `bold ${fontSize}px "${fontFamily}"`;
  ctx.fillStyle = TEXT_COLOR;
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillText(title, BADGE_TEXT_RIGHT, textY);

  return canvas.toBuffer('image/png');
}

export function programBadgeY(height: number, tickerHeight: number): number {
  return Math.max(0, Math.round(height - tickerHeight - BADGE_HEIGHT - BADGE_Y_MARGIN_ABOVE_TICKER));
}

function mergeRanges(ranges: ProgramBadgeRange[]): ProgramBadgeRange[] {
  const sorted = [...ranges].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  const merged: ProgramBadgeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startSeconds <= last.endSeconds + 0.05) {
      last.endSeconds = Math.max(last.endSeconds, range.endSeconds);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function isProgramItem(item: PlaylistItem): boolean {
  return item.source_role === 'program' || item.type === 'program' || item.show_lower_third === true;
}

function cleanTitle(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[‎‏‪-‮⁦-⁩]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function formatFilterSeconds(value: number): string {
  return Number(value.toFixed(3)).toString();
}
