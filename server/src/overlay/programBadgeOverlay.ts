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
  templatePath: string;
  assPath: string;
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
  fontFamily?: string;
  fontSize?: number;
}

interface ProgramBadgeGroup {
  title: string;
  ranges: ProgramBadgeRange[];
}

// NOTE: The badge is rendered by libass (ffmpeg `subtitles` filter), NOT node-canvas.
// Tajawal renders as .notdef boxes (tofu) for several contextual Arabic forms
// (آ ت ق ى …) under this libass/harfbuzz build — confirmed even with the official
// Google font. "Noto Sans Arabic" is a modern geometric sans-serif that shapes
// correctly with libass, is installed system-wide, and visually matches Tajawal.
// (The ticker keeps Tajawal because it uses node-canvas, a different text engine.)
const DEFAULT_FONT_FAMILY = 'Noto Sans Arabic';
const DEFAULT_MAX_WORDS = 3;
const DEFAULT_FONT_SIZE = 30;
const BADGE_TEXT_RIGHT = 137;
const BADGE_HEIGHT = 45;
const BADGE_Y_MARGIN_ABOVE_TICKER = 8;

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

  const outputDir = options.outputDir ?? path.join(config.paths.data, 'overlays', 'program-badges');
  ensureDir(outputDir);
  const assPath = path.join(outputDir, `current-${sanitizeFilePart(options.date)}.ass`);
  const ass = renderProgramBadgeAss(groups, options);
  fs.writeFileSync(assPath, ass, 'utf8');

  return {
    templatePath,
    assPath,
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

function renderProgramBadgeAss(groups: ProgramBadgeGroup[], options: ProgramBadgeOverlayOptions): string {
  const fontFamily = cleanAssStyleField(options.fontFamily ?? DEFAULT_FONT_FAMILY);
  const fontSize = Math.max(10, Math.round(options.fontSize ?? DEFAULT_FONT_SIZE));
  const badgeY = programBadgeY(options.height, options.tickerHeight);
  const textY = badgeY + Math.round(BADGE_HEIGHT / 2);

  const dialogues: string[] = [];
  for (const group of groups) {
    const text = escapeAssText(group.title);
    for (const range of group.ranges) {
      dialogues.push(
        `Dialogue: 1,${formatAssTime(range.startSeconds)},${formatAssTime(range.endSeconds)},ProgramBadge,,0,0,0,,{\\an6\\pos(${BADGE_TEXT_RIGHT},${textY})}${text}`
      );
    }
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${Math.round(options.width)}`,
    `PlayResY: ${Math.round(options.height)}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ProgramBadge,${fontFamily},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,6,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogues,
    '',
  ].join('\n');
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
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function cleanAssStyleField(value: string): string {
  return value.replace(/,/g, ' ').replace(/\s+/g, ' ').trim() || DEFAULT_FONT_FAMILY;
}

function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N');
}

function formatAssTime(secondsValue: number): string {
  const totalCentiseconds = Math.max(0, Math.round(secondsValue * 100));
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(centiseconds)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function formatFilterSeconds(value: number): string {
  return Number(value.toFixed(3)).toString();
}
