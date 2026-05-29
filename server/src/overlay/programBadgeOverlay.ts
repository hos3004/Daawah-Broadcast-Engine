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

export interface ProgramBadgeOverlayAssets {
  /** The "الآن" pill template, overlaid (statically positioned) while any program runs. */
  templatePath: string;
  /**
   * A single transparent sprite PNG: row 0 is fully transparent (shown during
   * gaps), and rows 1..N each hold one program title rendered by canvas. A
   * time-based ffmpeg `crop` selects the active row, so the whole badge text is
   * composited with ONE overlay regardless of how many programs the day has.
   */
  spritePath: string;
  /** Width in px of the sprite (and of the crop window). */
  spriteWidth: number;
  /** Height in px of each sprite row (and of the crop window). */
  rowHeight: number;
  /** ffmpeg `crop` y-expression selecting the active row by playback time `t`. */
  cropYExpression: string;
  /** Y offset at which the cropped strip is overlaid (x is always 0). */
  textLayerY: number;
  /** Ranges during which the pill background is shown (any program on air). */
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
//
// PERFORMANCE: all titles share ONE sprite PNG (one transparent gap row + one row
// per title). A time-based `crop` picks the active row and a single `overlay`
// composites it. An earlier design overlaid one looped image input per title; with
// ~19 titles that deep overlay chain dropped the encoder to ~0.40x realtime. The
// single-input/single-overlay sprite restores >5x headroom.
const DEFAULT_FONT_PATH = config.overlay.fontPath;
const FONT_FAMILY = 'ProgramBadgeFont';
const DEFAULT_MAX_WORDS = 3;
const DEFAULT_FONT_SIZE = 30;
const BADGE_TEXT_RIGHT = 137;
const BADGE_HEIGHT = 45;
const BADGE_Y_MARGIN_ABOVE_TICKER = 8;
const TEXT_COLOR = '#FFFFFF';
// The sprite is a narrow strip (not full-frame) so ffmpeg only alpha-composites a
// tiny region per frame. It is wide enough to cover the pill area up to
// BADGE_TEXT_RIGHT and a bit taller than the pill to clear Arabic ascenders/descenders.
const BADGE_TEXT_STRIP_WIDTH = 256;
const BADGE_TEXT_STRIP_HEIGHT = 60;

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
  const spritePath = path.join(outputDir, `current-${datePart}.png`);
  const buffer = renderProgramBadgeSpritePng(groups.map(group => group.title), options, fontFamily);
  fs.writeFileSync(spritePath, buffer);

  return {
    templatePath,
    spritePath,
    spriteWidth: BADGE_TEXT_STRIP_WIDTH,
    rowHeight: BADGE_TEXT_STRIP_HEIGHT,
    cropYExpression: buildBadgeCropYExpression(groups, BADGE_TEXT_STRIP_HEIGHT),
    textLayerY: programBadgeTextLayerY(options.height, options.tickerHeight),
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
 * Builds the ffmpeg `crop` y-expression that selects the active sprite row by
 * playback time. Row 0 (y=0) is the transparent gap; group `i` lives on row
 * `i+1` at `y=(i+1)*rowHeight`. Groups never overlap in time, but we still nest
 * the conditions and default to 0 so any uncovered instant shows the gap row.
 */
export function buildBadgeCropYExpression(groups: ProgramBadgeGroup[], rowHeight: number): string {
  let expr = '0';
  // Build from last group to first so the first group ends up outermost.
  for (let i = groups.length - 1; i >= 0; i--) {
    const condition = buildOverlayEnableExpression(groups[i]!.ranges);
    if (!condition) continue;
    expr = `if(${condition},${(i + 1) * rowHeight},${expr})`;
  }
  return expr;
}

/**
 * Renders all program titles into a single transparent sprite PNG. Row 0 is left
 * fully transparent (shown during gaps); each subsequent row holds one title,
 * right-aligned at x=BADGE_TEXT_RIGHT and vertically centred in its row, growing
 * leftward (RTL) — identical placement to the previous per-strip layout.
 */
function renderProgramBadgeSpritePng(
  titles: string[],
  options: ProgramBadgeOverlayOptions,
  fontFamily: string
): Buffer {
  const fontSize = Math.max(10, Math.round(options.fontSize ?? DEFAULT_FONT_SIZE));
  const rowCount = titles.length + 1; // +1 for the transparent gap row at index 0.

  const canvas = createCanvas(BADGE_TEXT_STRIP_WIDTH, BADGE_TEXT_STRIP_HEIGHT * rowCount);
  const ctx = canvas.getContext('2d');

  // `bold` gives the thicker weight requested; Skia synthesises it when the
  // registered face has no dedicated bold instance (Tajawal-Medium).
  ctx.font = `bold ${fontSize}px "${fontFamily}"`;
  ctx.fillStyle = TEXT_COLOR;
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';

  titles.forEach((title, index) => {
    const rowTop = (index + 1) * BADGE_TEXT_STRIP_HEIGHT;
    ctx.fillText(title, BADGE_TEXT_RIGHT, rowTop + Math.round(BADGE_TEXT_STRIP_HEIGHT / 2));
  });

  return canvas.toBuffer('image/png');
}

export function programBadgeY(height: number, tickerHeight: number): number {
  return Math.max(0, Math.round(height - tickerHeight - BADGE_HEIGHT - BADGE_Y_MARGIN_ABOVE_TICKER));
}

/** Y offset for overlaying the cropped strip so its centre matches the pill centre. */
export function programBadgeTextLayerY(height: number, tickerHeight: number): number {
  const badgeY = programBadgeY(height, tickerHeight);
  const textCenter = badgeY + Math.round(BADGE_HEIGHT / 2);
  return Math.max(0, textCenter - Math.round(BADGE_TEXT_STRIP_HEIGHT / 2));
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
