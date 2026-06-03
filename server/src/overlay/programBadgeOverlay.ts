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
  /**
   * Pre-built ffmpeg `enable` expression for the pill background. When the
   * schedule is periodic (a fixed cycle repeated over many days) the ranges are
   * folded into one cycle with `mod(t,period)`, collapsing thousands of
   * `between()` terms into a handful — the per-frame, single-threaded cost of
   * that expression was the dominant encoder bottleneck. Falls back to the full
   * absolute-time expression when no clean cycle is detected.
   */
  backgroundEnableExpression: string;
  /**
   * Detected schedule cycle period in seconds, or null when the schedule isn't a
   * clean repeat. Exposed so other periodic per-frame expressions built for the
   * same broadcast (e.g. the logo-hide expression) can fold by the same period.
   */
  cyclePeriod: number | null;
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
const DEFAULT_FONT_SIZE = 24;
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
  // Write to a temp file then rename: ffmpeg may be reading the previous sprite,
  // and a partial write produces an "Invalid PNG signature" crash. rename() is
  // atomic on the same filesystem so readers always see a complete file.
  const tmpSpritePath = spritePath + '.tmp';
  fs.writeFileSync(tmpSpritePath, buffer);
  fs.renameSync(tmpSpritePath, spritePath);

  // Fold a repeated schedule into a single cycle BEFORE building any expression.
  // Folding by start phase (not duration) collapses ~45 cycles × 16 titles into
  // one cycle; the badge windows then carry the longest episode per title, capped
  // at the next program's start so they never overlap. The folded groups keep the
  // SAME order/index as `groups`, so they still index the sprite's rows correctly.
  const detectedCycle = detectScheduleCycle(groups);
  const cycle = detectedCycle ?? undefined;
  const effectiveGroups = detectedCycle ? foldGroupsIntoCycle(groups, detectedCycle.period) : groups;
  const backgroundRanges = mergeRanges(effectiveGroups.flatMap(group => group.ranges));
  const backgroundEnableExpression = buildOverlayEnableExpression(backgroundRanges, cycle);

  if (detectedCycle) {
    const before = groups.reduce((count, group) => count + group.ranges.length, 0);
    const after = effectiveGroups.reduce((count, group) => count + group.ranges.length, 0);
    logger.info(
      `Program badge: schedule is periodic (cycle ${detectedCycle.period}s) — folded ${before} program ranges into ${after} to keep the ffmpeg enable/crop expressions small.`
    );
  }

  return {
    templatePath,
    spritePath,
    spriteWidth: BADGE_TEXT_STRIP_WIDTH,
    rowHeight: BADGE_TEXT_STRIP_HEIGHT,
    cropYExpression: buildBadgeCropYExpression(effectiveGroups, BADGE_TEXT_STRIP_HEIGHT, cycle),
    textLayerY: programBadgeTextLayerY(options.height, options.tickerHeight),
    backgroundRanges,
    backgroundEnableExpression,
    cyclePeriod: detectedCycle?.period ?? null,
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

export interface ScheduleCycle {
  /** Period in seconds; the whole schedule is this one cycle repeated. */
  period: number;
}

export function buildOverlayEnableExpression(ranges: ProgramBadgeRange[], cycle?: ScheduleCycle): string {
  // The ranges are pre-folded into [0,period) by foldGroupsIntoCycle when a cycle
  // is detected, so here we only choose the time variable: `mod(t,period)` makes
  // the same handful of `between()` terms match every repeated cycle; otherwise
  // we match absolute playback time `t`.
  const timeVar = cycle ? `mod(t,${formatFilterSeconds(cycle.period)})` : 't';
  return ranges
    .map(range => `between(${timeVar},${formatFilterSeconds(range.startSeconds)},${formatFilterSeconds(range.endSeconds)})`)
    .join('+');
}

/**
 * Builds the ffmpeg `crop` y-expression that selects the active sprite row by
 * playback time. Row 0 (y=0) is the transparent gap; group `i` lives on row
 * `i+1` at `y=(i+1)*rowHeight`. Groups never overlap in time, but we still nest
 * the conditions and default to 0 so any uncovered instant shows the gap row.
 * When `cycle` is set the conditions use `mod(t,period)` so a schedule repeated
 * over many days collapses to one cycle's worth of `between()` terms.
 */
export function buildBadgeCropYExpression(groups: ProgramBadgeGroup[], rowHeight: number, cycle?: ScheduleCycle): string {
  let expr = '0';
  // Build from last group to first so the first group ends up outermost.
  for (let i = groups.length - 1; i >= 0; i--) {
    const condition = buildOverlayEnableExpression(groups[i]!.ranges, cycle);
    if (!condition) continue;
    expr = `if(${condition},${(i + 1) * rowHeight},${expr})`;
  }
  return expr;
}

/**
 * Detects whether the schedule is one fixed cycle repeated (the auto-repeat
 * materializer emits the same day/cycle over and over for up to ~2 weeks).
 *
 * Folding is validated on START PHASE and TITLE ROW only — NOT duration. Real
 * cycles reuse the same time slots every period but swap in different episodes, so
 * each program's duration varies cycle to cycle. We therefore require that every
 * program start lands at one of a small set of phases, and that each phase always
 * carries the same title (no slot is reused for two different programs). Durations
 * are reconciled later by foldGroupsIntoCycle (longest episode, capped at the next
 * slot). Returns null when the schedule isn't a clean repeat, and the caller keeps
 * the full absolute-time expression (correct, just slower).
 */
export function detectScheduleCycle(groups: ProgramBadgeGroup[]): ScheduleCycle | null {
  const labeled: Array<{ start: number; row: number }> = [];
  groups.forEach((group, index) => {
    for (const range of group.ranges) {
      labeled.push({ start: range.startSeconds, row: index + 1 });
    }
  });
  if (labeled.length < 6) return null;
  labeled.sort((a, b) => a.start - b.start);

  const period = estimateCyclePeriod(groups);
  if (period === null || period <= 1) return null;

  const span = labeled[labeled.length - 1]!.start - labeled[0]!.start;
  if (span < period * 2) return null; // need at least a couple of cycles to fold

  // Every program start must land at the same phase (within tol) and on the same
  // title row each cycle. Collect the distinct phases as we go; a phase that ever
  // carries two different rows means the slot isn't a clean repeat → bail.
  const tol = 2.0; // seconds
  const phaseRows: Array<{ phase: number; row: number }> = [];
  for (const l of labeled) {
    const phase = ((l.start % period) + period) % period;
    const match = phaseRows.find(ref => {
      const rawDiff = Math.abs(ref.phase - phase);
      const phaseDiff = Math.min(rawDiff, period - rawDiff); // wrap-around distance
      return phaseDiff <= tol;
    });
    if (match) {
      if (match.row !== l.row) return null;
    } else {
      phaseRows.push({ phase, row: l.row });
    }
  }

  // Require genuine folding: distinct phases must be far fewer than total ranges
  // (otherwise there's nothing to collapse and folding could only lose accuracy).
  if (phaseRows.length >= labeled.length / 2) return null;
  return { period };
}

/**
 * Folds a repeated schedule into ONE cycle's worth of groups, by start phase.
 * Each program collapses to a single window starting at its phase and lasting the
 * LONGEST episode seen for that title, capped at the gap to the next program's
 * start so windows never overlap. A window that crosses the cycle boundary is
 * split into a head + wrapped tail. Group order/index is preserved so the folded
 * groups still index the sprite's title rows correctly.
 */
export function foldGroupsIntoCycle(groups: ProgramBadgeGroup[], period: number): ProgramBadgeGroup[] {
  const meta = groups.map((group, index) => {
    let phase = 0;
    let maxDur = 0;
    let hasPhase = false;
    for (const range of group.ranges) {
      const dur = range.endSeconds - range.startSeconds;
      if (dur > maxDur) maxDur = dur;
      if (!hasPhase) {
        phase = ((range.startSeconds % period) + period) % period;
        hasPhase = true;
      }
    }
    return { index, phase, maxDur };
  });

  // Cap each program at the next program's start (in phase order, wrapping).
  const order = [...meta].sort((a, b) => a.phase - b.phase);
  const capByIndex = new Map<number, number>();
  for (let i = 0; i < order.length; i++) {
    const cur = order[i]!;
    const next = order[(i + 1) % order.length]!;
    const gap = i + 1 < order.length ? next.phase - cur.phase : next.phase + period - cur.phase;
    capByIndex.set(cur.index, Math.max(0, gap));
  }

  return groups.map((group, index) => {
    const m = meta[index]!;
    const cap = capByIndex.get(index) ?? period;
    const dur = Math.min(m.maxDur, cap);
    const ranges: ProgramBadgeRange[] = [];
    if (dur > 0) {
      const start = m.phase;
      const end = start + dur;
      if (end <= period) {
        ranges.push({ startSeconds: start, endSeconds: end });
      } else {
        ranges.push({ startSeconds: start, endSeconds: period });
        ranges.push({ startSeconds: 0, endSeconds: end - period });
      }
    }
    return { title: group.title, ranges };
  });
}

/** Most common gap (rounded to whole seconds) between successive starts of the same program. */
function estimateCyclePeriod(groups: ProgramBadgeGroup[]): number | null {
  const counts = new Map<number, number>();
  for (const group of groups) {
    const ranges = group.ranges; // already merged & sorted by collectProgramBadgeGroups
    for (let i = 1; i < ranges.length; i++) {
      const diff = Math.round(ranges[i]!.startSeconds - ranges[i - 1]!.startSeconds);
      if (diff > 1) counts.set(diff, (counts.get(diff) ?? 0) + 1);
    }
  }
  let period: number | null = null;
  let best = 0;
  for (const [diff, count] of counts) {
    if (count > best) {
      best = count;
      period = diff;
    }
  }
  return period;
}

/**
 * Folds a flat list of periodic time ranges into one [0,period) cycle by start
 * phase, using the LONGEST instance seen at each phase (capped to the period and
 * split at the boundary). Like the badge fold, this trades a few seconds of extra
 * on-screen time in short cycles for collapsing thousands of per-frame `between()`
 * terms into a handful. Used for the logo-hide expression, which repeats every
 * cycle but would otherwise emit one term per program across the whole timeline.
 */
export function foldRangesByPeriod(ranges: ProgramBadgeRange[], period: number): ProgramBadgeRange[] {
  if (period <= 1) return mergeRanges(ranges);
  const tol = 2.0; // seconds
  const buckets: Array<{ phase: number; maxDur: number }> = [];
  for (const range of ranges) {
    const dur = range.endSeconds - range.startSeconds;
    if (dur <= 0) continue;
    const phase = ((range.startSeconds % period) + period) % period;
    const bucket = buckets.find(b => {
      const raw = Math.abs(b.phase - phase);
      return Math.min(raw, period - raw) <= tol;
    });
    if (bucket) {
      if (dur > bucket.maxDur) bucket.maxDur = dur;
    } else {
      buckets.push({ phase, maxDur: dur });
    }
  }
  const folded: ProgramBadgeRange[] = [];
  for (const bucket of buckets) {
    const start = bucket.phase;
    const end = start + Math.min(bucket.maxDur, period);
    if (end <= period) {
      folded.push({ startSeconds: start, endSeconds: end });
    } else {
      folded.push({ startSeconds: start, endSeconds: period });
      folded.push({ startSeconds: 0, endSeconds: end - period });
    }
  }
  return mergeRanges(folded);
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
  const fontSize = Math.max(10, Math.round(options.fontSize ?? config.overlay.programBadgeFontSize ?? DEFAULT_FONT_SIZE));
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
