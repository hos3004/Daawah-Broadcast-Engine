import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import {
  fillGapWithProfessionalBumpers,
  type GapFillerCursorPlan,
  type SourceRole,
} from '../playlist/gapFiller';
import { DraftValidationError } from './drafts';
import { parseTimeToMinutes } from './excelPreview';
import type { PublishedScheduleDetail } from './drafts';

type Db = ReturnType<typeof getDb>;

export type ExpandedPlaylistItemType = 'program' | 'gap_filler';
export type ExpandedPlaylistItemStatus = 'ready' | 'missing_media' | 'unknown_duration';

export interface ExpandedPlaylistItem {
  id: string;
  date: string;
  type: ExpandedPlaylistItemType;
  source: string;
  sourceRole: SourceRole;
  programKey: string | null;
  hideLogo: boolean;
  title: string;
  startTime: string;
  endTime: string;
  timelineStartSeconds: number;
  timelineEndSeconds: number;
  durationMinutes: number;
  durationSeconds: number;
  mediaFileId: string | null;
  absolutePath: string | null;
  relativePath: string | null;
  trimStartSeconds: 0;
  trimEndSeconds: number;
  isTrimmed: boolean;
  validationStatus: ExpandedPlaylistItemStatus;
}

export interface PlaylistExpansionWarning {
  code: string;
  message: string;
  itemId?: string;
}

export interface PlaylistExpansionError {
  code: string;
  message: string;
  itemId?: string;
}

export interface PlaylistExpansionSummary {
  mediaExpansionAvailable: boolean;
  missingMediaFileCount: number;
  unknownDurationCount: number;
  overlapCount: number;
  negativeGapCount: number;
  unfilledGapCount: number;
}

export interface PlaylistExpansionResult {
  items: ExpandedPlaylistItem[];
  warnings: PlaylistExpansionWarning[];
  errors: PlaylistExpansionError[];
  summary: PlaylistExpansionSummary;
}

interface MediaFileRow {
  id: string;
  path: string;
  relative_path: string | null;
  filename: string;
  type: string;
  status: string;
  folder_id: string | null;
  duration_sec: number | null;
  duration_ms: number | null;
  modified_at: string | null;
}

interface MediaFolderRow {
  id: string;
  original_relative_path: string;
}

interface ProgramCursor {
  nextIndex: number;
}

type ProgramRow = PublishedScheduleDetail['programs'][number];
type SchedulePreviewRow = PublishedScheduleDetail['schedulePreview']['days'][number]['rows'][number];
type SchedulePreviewDay = PublishedScheduleDetail['schedulePreview']['days'][number];
type SlotRow = PublishedScheduleDetail['slots'][number];
type ProgramPlayMode = 'sequential' | 'shuffle' | 'newest' | 'round_robin';
type ProgramSlotMode = 'fit' | 'playlist' | 'file_count' | 'kids_round_robin';

interface ProgramBaseItem {
  date: string;
  type: 'program';
  source: string;
  sourceRole: SourceRole;
  programKey: string | null;
  hideLogo: boolean;
  title: string;
  trimStartSeconds: 0;
}

interface ExpansionContext {
  db: Db;
  programsByKey: Map<string, PublishedScheduleDetail['programs'][number]>;
  folderIdByProgramKey: Map<string, string>;
  filesByFolderId: Map<string, MediaFileRow[]>;
  foldersById: Map<string, MediaFolderRow | null>;
  kidsRoundRobinFilesByFolderId: Map<string, MediaFileRow[]>;
  programCursors: Map<string, ProgramCursor>;
  gapFillerCursors: GapFillerCursorPlan;
  dailyFitSelections: Map<string, MediaFileRow>;
  warnings: PlaylistExpansionWarning[];
  errors: PlaylistExpansionError[];
}

const MAX_EXPANDED_ITEMS_PER_ROW = 10_000;
const DAY_MINUTES = 24 * 60;
const AUTO_CYCLE_SNAP_TOLERANCE_MINUTES = 10;
const AUTO_CYCLE_STANDARD_SPANS_MINUTES = [60, 120, 180, 240, 360, 480, 720, 1440] as const;

export function expandPublishedScheduleToFiles(schedule: PublishedScheduleDetail): PlaylistExpansionResult {
  const db = getDb();
  const context: ExpansionContext = {
    db,
    programsByKey: new Map(schedule.programs.map(program => [program.program_key, program])),
    folderIdByProgramKey: new Map(
      schedule.folderMatches
        .filter(match => match.status === 'matched' && match.matched_folder_id)
        .map(match => [match.program_key, match.matched_folder_id as string])
    ),
    filesByFolderId: new Map(),
    foldersById: new Map(),
    kidsRoundRobinFilesByFolderId: new Map(),
    programCursors: new Map(),
    gapFillerCursors: new Map(),
    dailyFitSelections: new Map(),
    warnings: [],
    errors: [],
  };

  const items: ExpandedPlaylistItem[] = [];

  for (const day of schedule.schedulePreview.days) {
    for (const row of materializationRowsForDay(schedule, day, context)) {
      const rowItems = row.type === 'gap'
        ? expandGapRow(day.date, row, context)
        : expandProgramRow(day.date, row, context);
      items.push(...rowItems);
    }
  }

  validateTimeline(items, context);

  const summary = buildExpansionSummary(items, context.errors);
  return {
    items,
    warnings: context.warnings,
    errors: context.errors,
    summary,
  };
}

function materializationRowsForDay(
  schedule: PublishedScheduleDetail,
  day: SchedulePreviewDay,
  context: ExpansionContext
): SchedulePreviewRow[] {
  const repeatedRows = buildAutoRepeatedCycleRows(schedule, day, context);
  return repeatedRows ?? day.rows;
}

function buildAutoRepeatedCycleRows(
  schedule: PublishedScheduleDetail,
  day: SchedulePreviewDay,
  context: ExpansionContext
): SchedulePreviewRow[] | null {
  const slotRows = day.rows.filter(isSlotPreviewRow);
  if (slotRows.length === 0) return null;

  const cycleNotesByRow = collectCycleNotesBySlotRow(schedule.slots);
  if (!slotRows.some(row => row.row !== null && cycleNotesByRow.has(row.row))) return null;

  const maxCycleCount = Math.max(1, ...Array.from(cycleNotesByRow.values()).map(note => note.total));
  const baseRows = maxCycleCount > 1
    ? slotRows.filter(row => row.row !== null && cycleNotesByRow.get(row.row)?.index === 1)
    : slotRows;
  if (baseRows.length === 0) return null;

  const cyclePlan = planAutoCycle(baseRows);
  if (!cyclePlan || cyclePlan.starts.length <= 1) return null;

  context.warnings.push({
    code: 'AUTO_CYCLE_REPEAT_APPLIED',
    itemId: `${day.date}:auto-cycle-repeat`,
    message: `Auto repeated the ${cyclePlan.spanMinutes} minute cycle on ${day.date} from ${formatPreviewTime(cyclePlan.baseStartMinutes)} to fill the day.`,
  });

  return insertMaterializationGapRows(repeatCycleRows(baseRows, cyclePlan));
}

function isSlotPreviewRow(row: SchedulePreviewRow): boolean {
  return row.type !== 'gap';
}

function collectCycleNotesBySlotRow(slots: SlotRow[] | undefined): Map<number, { index: number; total: number }> {
  const notes = new Map<number, { index: number; total: number }>();
  if (!Array.isArray(slots)) return notes;

  for (const slot of slots) {
    if (typeof slot.row !== 'number') continue;
    const note = parseCycleNote(slot.notes);
    if (note) notes.set(slot.row, note);
  }
  return notes;
}

function parseCycleNote(value: string | null | undefined): { index: number; total: number } | null {
  const match = /\bcycle\s+(\d+)\/(\d+)\b/i.exec(value ?? '');
  if (!match) return null;
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1) return null;
  return { index, total };
}

function planAutoCycle(rows: SchedulePreviewRow[]): { baseStartMinutes: number; spanMinutes: number; starts: number[] } | null {
  const spans = rows
    .map(row => {
      const start = parseTimeToMinutes(row.start_time);
      if (start === null) return null;
      return {
        start,
        end: start + Math.max(1, row.duration_minutes),
      };
    })
    .filter((row): row is { start: number; end: number } => row !== null);
  if (spans.length === 0) return null;

  const baseStartMinutes = Math.min(...spans.map(row => row.start));
  const rawSpanMinutes = Math.max(...spans.map(row => row.end)) - baseStartMinutes;
  if (rawSpanMinutes <= 0) return null;

  const spanMinutes = normalizeAutoCycleSpanMinutes(rawSpanMinutes);
  if (spanMinutes <= 0 || spanMinutes >= DAY_MINUTES) return null;

  let firstStart = baseStartMinutes;
  while (firstStart - spanMinutes >= 0) {
    firstStart -= spanMinutes;
  }

  const starts: number[] = [];
  for (let start = firstStart; start < DAY_MINUTES; start += spanMinutes) {
    starts.push(start);
  }

  return { baseStartMinutes, spanMinutes, starts };
}

function normalizeAutoCycleSpanMinutes(rawSpanMinutes: number): number {
  const roundedRaw = Math.max(1, Math.round(rawSpanMinutes));
  const nearestStandard = AUTO_CYCLE_STANDARD_SPANS_MINUTES
    .map(span => ({ span, delta: Math.abs(span - roundedRaw) }))
    .sort((a, b) => a.delta - b.delta || a.span - b.span)[0];

  if (nearestStandard && nearestStandard.delta <= AUTO_CYCLE_SNAP_TOLERANCE_MINUTES) {
    return nearestStandard.span;
  }
  return roundedRaw;
}

function repeatCycleRows(
  baseRows: SchedulePreviewRow[],
  plan: { baseStartMinutes: number; spanMinutes: number; starts: number[] }
): SchedulePreviewRow[] {
  const sortedBaseRows = [...baseRows].sort((a, b) => {
    const left = parseTimeToMinutes(a.start_time) ?? 0;
    const right = parseTimeToMinutes(b.start_time) ?? 0;
    return left - right;
  });
  const rows: SchedulePreviewRow[] = [];

  for (const cycleStart of plan.starts) {
    const cycleEnd = Math.min(DAY_MINUTES, cycleStart + plan.spanMinutes);
    for (const row of sortedBaseRows) {
      const baseStart = parseTimeToMinutes(row.start_time);
      if (baseStart === null) continue;
      const start = cycleStart + (baseStart - plan.baseStartMinutes);
      if (start < 0 || start >= DAY_MINUTES || start >= cycleEnd) continue;

      const end = Math.min(start + Math.max(1, row.duration_minutes), cycleEnd, DAY_MINUTES);
      if (end <= start) continue;

      rows.push({
        ...row,
        start_time: formatPreviewTime(start),
        end_time: formatPreviewTime(end),
        duration_minutes: Math.max(0, end - start),
      });
    }
  }

  return applyMaterializationHardStartCaps(rows);
}

function applyMaterializationHardStartCaps(rows: SchedulePreviewRow[]): SchedulePreviewRow[] {
  const sorted = [...rows].sort((a, b) => {
    const left = parseTimeToMinutes(a.start_time) ?? 0;
    const right = parseTimeToMinutes(b.start_time) ?? 0;
    return left - right;
  });

  return sorted.map((row, index) => {
    const start = parseTimeToMinutes(row.start_time);
    const end = start === null ? null : start + row.duration_minutes;
    if (start === null || end === null) return row;

    const nextStart = sorted
      .slice(index + 1)
      .map(nextRow => parseTimeToMinutes(nextRow.start_time))
      .find((value): value is number => value !== null && value > start);
    if (nextStart === undefined || end <= nextStart) return row;

    return {
      ...row,
      end_time: formatPreviewTime(nextStart),
      duration_minutes: Math.max(0, nextStart - start),
    };
  });
}

function insertMaterializationGapRows(rows: SchedulePreviewRow[]): SchedulePreviewRow[] {
  const sorted = [...rows].sort((a, b) => {
    const left = parseTimeToMinutes(a.start_time) ?? 0;
    const right = parseTimeToMinutes(b.start_time) ?? 0;
    return left - right;
  });
  const result: SchedulePreviewRow[] = [];
  let cursor = 0;

  for (const row of sorted) {
    const start = parseTimeToMinutes(row.start_time);
    if (start === null) continue;
    const safeStart = Math.max(0, Math.min(DAY_MINUTES, start));
    const safeEnd = Math.max(safeStart, Math.min(DAY_MINUTES, safeStart + row.duration_minutes));

    if (safeStart > cursor) {
      result.push(gapPreviewRow(cursor, safeStart));
    }

    if (safeEnd > safeStart) {
      result.push({
        ...row,
        start_time: formatPreviewTime(safeStart),
        end_time: formatPreviewTime(safeEnd),
        duration_minutes: safeEnd - safeStart,
      });
      cursor = Math.max(cursor, safeEnd);
    }
  }

  if (cursor < DAY_MINUTES) {
    result.push(gapPreviewRow(cursor, DAY_MINUTES));
  }

  return result;
}

function gapPreviewRow(start: number, end: number): SchedulePreviewRow {
  return {
    type: 'gap',
    row: null,
    program_key: null,
    title: 'Professional Gap Preview',
    start_time: formatPreviewTime(start),
    end_time: formatPreviewTime(end),
    duration_minutes: Math.max(0, end - start),
  };
}

export function renderFfconcat(items: ExpandedPlaylistItem[]): string {
  const lines = ['ffconcat version 1.0'];
  for (const item of items) {
    if (!item.absolutePath || item.validationStatus !== 'ready') continue;
    lines.push(formatConcatFileLine(item.absolutePath));
    if (item.isTrimmed) {
      const seconds = formatSeconds(item.durationSeconds);
      lines.push(`outpoint ${seconds}`);
      lines.push(`duration ${seconds}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function expandProgramRow(
  date: string,
  row: SchedulePreviewRow,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const startSeconds = timeToSeconds(row.start_time);
  const slotDurationSeconds = Math.round(row.duration_minutes * 60);
  const endSeconds = startSeconds + slotDurationSeconds;
  const programKey = row.program_key ?? '';
  const source = row.row === null ? `${date}:program:${row.start_time}` : `excel-row:${row.row}`;
  const baseItem: ProgramBaseItem = {
    date,
    type: 'program' as const,
    source,
    sourceRole: 'program' as SourceRole,
    programKey: programKey || null,
    hideLogo: false,
    title: row.title,
    trimStartSeconds: 0 as const,
  };

  if (!programKey || !context.programsByKey.has(programKey)) {
    context.errors.push({
      code: 'PROGRAM_KEY_NOT_FOUND',
      itemId: source,
      message: `Program slot "${row.title}" on ${date} does not map to a known program_key.`,
    });
    return [missingItem(baseItem, startSeconds, endSeconds, 'missing_media')];
  }

  const program = context.programsByKey.get(programKey)!;
  const programBaseItem: ProgramBaseItem = {
    ...baseItem,
    hideLogo: program.hide_logo === true,
  };
  const folderId = context.folderIdByProgramKey.get(programKey);
  if (!folderId) {
    context.errors.push({
      code: 'PROGRAM_FOLDER_NOT_MATCHED',
      itemId: source,
      message: `Program "${programKey}" has no approved matched media folder.`,
    });
    return [missingItem(programBaseItem, startSeconds, endSeconds, 'missing_media')];
  }

  const files = getReadyFilesForFolder(folderId, context);
  if (files.length === 0) {
    context.errors.push({
      code: 'PROGRAM_MEDIA_NOT_AVAILABLE',
      itemId: source,
      message: `Program "${programKey}" has no ready media files in matched folder ${folderId}.`,
    });
    return [missingItem(programBaseItem, startSeconds, endSeconds, 'missing_media')];
  }

  const slotMode = normalizeSlotMode(program.slot_mode);
  if (slotMode === 'kids_round_robin') {
    return expandKidsRoundRobinProgramRow(program, folderId, programBaseItem, startSeconds, endSeconds, context);
  }
  if (slotMode === 'playlist') {
    return expandPlaylistProgramRow(program, files, programBaseItem, startSeconds, endSeconds, context);
  }
  if (slotMode === 'file_count') {
    return expandFileCountProgramRow(program, files, programBaseItem, startSeconds, endSeconds, context);
  }
  return expandFitProgramRow(program, files, programBaseItem, startSeconds, endSeconds, context);
}

function expandFitProgramRow(
  program: ProgramRow,
  files: MediaFileRow[],
  baseItem: ProgramBaseItem,
  startSeconds: number,
  endSeconds: number,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const slotDurationSeconds = endSeconds - startSeconds;
  const playMode = normalizePlayMode(program.play_mode);
  const cacheKey = `${baseItem.date}:${program.program_key}`;
  let media = program.repeat_policy === 'advance_each_airing'
    ? null
    : context.dailyFitSelections.get(cacheKey) ?? null;

  if (!media) {
    media = selectNextFiles(program.program_key, files, playMode, 1, context)[0] ?? null;
    if (media && program.repeat_policy !== 'advance_each_airing') {
      context.dailyFitSelections.set(cacheKey, media);
    }
  }

  if (!media) {
    context.errors.push({
      code: 'PROGRAM_MEDIA_NOT_AVAILABLE',
      itemId: baseItem.source,
      message: `Program "${program.program_key}" has no media file available for fit mode.`,
    });
    return [missingItem(baseItem, startSeconds, endSeconds, 'missing_media')];
  }

  const duration = validateProgramMedia(media, program.program_key, baseItem.source, context);
  if (duration === null) {
    return [missingItem(baseItem, startSeconds, endSeconds, 'unknown_duration', media)];
  }

  const items: ExpandedPlaylistItem[] = [];
  const playSeconds = Math.min(duration, slotDurationSeconds);
  items.push(readyItem({
    ...baseItem,
    media,
    startSeconds,
    endSeconds: startSeconds + playSeconds,
    isTrimmed: duration > slotDurationSeconds,
  }));

  if (startSeconds + playSeconds < endSeconds) {
    items.push(...expandInternalGap(
      baseItem.date,
      startSeconds + playSeconds,
      endSeconds,
      `${baseItem.source}:fit-gap`,
      context
    ));
  }

  return items;
}

function expandPlaylistProgramRow(
  program: ProgramRow,
  files: MediaFileRow[],
  baseItem: ProgramBaseItem,
  startSeconds: number,
  endSeconds: number,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const playMode = normalizePlayMode(program.play_mode);
  const items: ExpandedPlaylistItem[] = [];
  let currentSeconds = startSeconds;
  let remainingSeconds = endSeconds - startSeconds;
  let attempts = 0;

  while (remainingSeconds > 0 && attempts < MAX_EXPANDED_ITEMS_PER_ROW) {
    attempts++;
    const media = selectNextFiles(program.program_key, files, playMode, 1, context)[0];
    if (!media) break;

    const mediaDurationSeconds = validateProgramMedia(media, program.program_key, baseItem.source, context);
    if (mediaDurationSeconds === null) {
      items.push(missingItem(baseItem, currentSeconds, endSeconds, 'missing_media', media));
      break;
    }

    const durationSeconds = Math.min(mediaDurationSeconds, remainingSeconds);
    const isTrimmed = mediaDurationSeconds > remainingSeconds;
    items.push(readyItem({
      ...baseItem,
      media,
      startSeconds: currentSeconds,
      endSeconds: currentSeconds + durationSeconds,
      isTrimmed,
    }));

    currentSeconds += durationSeconds;
    remainingSeconds -= durationSeconds;
  }

  if (remainingSeconds > 0 && items.every(item => item.validationStatus === 'ready')) {
    context.errors.push({
      code: 'PROGRAM_SLOT_UNDERFILLED',
      itemId: baseItem.source,
      message: `Program slot "${baseItem.title}" on ${baseItem.date} could not be expanded to its full duration.`,
    });
    items.push(missingItem(baseItem, currentSeconds, endSeconds, 'missing_media'));
  }

  if (attempts >= MAX_EXPANDED_ITEMS_PER_ROW) {
    context.errors.push({
      code: 'PROGRAM_EXPANSION_SAFETY_LIMIT',
      itemId: baseItem.source,
      message: `Program slot "${baseItem.title}" exceeded the file expansion safety limit.`,
    });
  }

  return items;
}

function expandFileCountProgramRow(
  program: ProgramRow,
  files: MediaFileRow[],
  baseItem: ProgramBaseItem,
  startSeconds: number,
  endSeconds: number,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const playMode = normalizePlayMode(program.play_mode);
  const fileCount = Math.max(1, program.file_count ?? 1);
  const selected = selectNextFiles(program.program_key, files, playMode, fileCount, context);
  const items: ExpandedPlaylistItem[] = [];
  let currentSeconds = startSeconds;

  for (const media of selected) {
    if (currentSeconds >= endSeconds) break;

    const mediaDurationSeconds = validateProgramMedia(media, program.program_key, baseItem.source, context);
    if (mediaDurationSeconds === null) {
      items.push(missingItem(baseItem, currentSeconds, endSeconds, 'missing_media', media));
      break;
    }

    const fileEndSeconds = currentSeconds + mediaDurationSeconds;
    if (fileEndSeconds > endSeconds) {
      const remainingSeconds = endSeconds - currentSeconds;
      if (remainingSeconds > mediaDurationSeconds * 0.3) {
        items.push(readyItem({
          ...baseItem,
          media,
          startSeconds: currentSeconds,
          endSeconds,
          isTrimmed: true,
        }));
      }
      currentSeconds = endSeconds;
      break;
    }

    items.push(readyItem({
      ...baseItem,
      media,
      startSeconds: currentSeconds,
      endSeconds: fileEndSeconds,
      isTrimmed: false,
    }));
    currentSeconds = fileEndSeconds;
  }

  if (items.length === 0) {
    context.errors.push({
      code: 'PROGRAM_MEDIA_NOT_AVAILABLE',
      itemId: baseItem.source,
      message: `Program "${program.program_key}" has no playable media for file_count mode.`,
    });
    return [missingItem(baseItem, startSeconds, endSeconds, 'missing_media')];
  }

  if (currentSeconds < endSeconds && items.every(item => item.validationStatus === 'ready')) {
    items.push(...expandInternalGap(
      baseItem.date,
      currentSeconds,
      endSeconds,
      `${baseItem.source}:file-count-gap`,
      context
    ));
  }

  return items;
}

function expandKidsRoundRobinProgramRow(
  program: ProgramRow,
  folderId: string,
  baseItem: ProgramBaseItem,
  startSeconds: number,
  endSeconds: number,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const sequence = getKidsRoundRobinFilesForFolder(folderId, context);
  if (sequence.length === 0) {
    context.errors.push({
      code: 'KIDS_MEDIA_NOT_AVAILABLE',
      itemId: baseItem.source,
      message: `Kids program "${program.program_key}" has no playable media under its child folders.`,
    });
    return [missingItem(baseItem, startSeconds, endSeconds, 'missing_media')];
  }

  const cursor = getProgramCursor(`kids:${program.program_key}`, context);
  const items: ExpandedPlaylistItem[] = [];
  let currentSeconds = startSeconds;
  let attempts = 0;

  while (currentSeconds < endSeconds && attempts < MAX_EXPANDED_ITEMS_PER_ROW) {
    attempts++;
    const media = sequence[cursor.nextIndex % sequence.length]!;
    cursor.nextIndex = (cursor.nextIndex + 1) % sequence.length;

    const mediaDurationSeconds = validateProgramMedia(media, program.program_key, baseItem.source, context);
    if (mediaDurationSeconds === null) {
      items.push(missingItem(baseItem, currentSeconds, endSeconds, 'unknown_duration', media));
      break;
    }

    const remainingSeconds = endSeconds - currentSeconds;
    if (mediaDurationSeconds > remainingSeconds) {
      const canTrim = items.length === 0 || remainingSeconds > mediaDurationSeconds * 0.3;
      if (canTrim) {
        items.push(readyItem({
          ...baseItem,
          media,
          startSeconds: currentSeconds,
          endSeconds,
          isTrimmed: true,
        }));
        currentSeconds = endSeconds;
      } else {
        cursor.nextIndex = (cursor.nextIndex - 1 + sequence.length) % sequence.length;
      }
      break;
    }

    items.push(readyItem({
      ...baseItem,
      media,
      startSeconds: currentSeconds,
      endSeconds: currentSeconds + mediaDurationSeconds,
      isTrimmed: false,
    }));
    currentSeconds += mediaDurationSeconds;
  }

  if (attempts >= MAX_EXPANDED_ITEMS_PER_ROW) {
    context.errors.push({
      code: 'KIDS_EXPANSION_SAFETY_LIMIT',
      itemId: baseItem.source,
      message: `Kids program slot "${baseItem.title}" exceeded the file expansion safety limit.`,
    });
  }

  if (currentSeconds < endSeconds && items.every(item => item.validationStatus === 'ready')) {
    items.push(...expandInternalGap(
      baseItem.date,
      currentSeconds,
      endSeconds,
      `${baseItem.source}:kids-gap`,
      context
    ));
  }

  return items.length > 0 ? items : [missingItem(baseItem, startSeconds, endSeconds, 'missing_media')];
}

function expandGapRow(
  date: string,
  row: SchedulePreviewRow,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const dayStartMs = Date.parse(`${date}T00:00:00.000Z`);
  const startSeconds = timeToSeconds(row.start_time);
  const gapDurationSeconds = Math.round(row.duration_minutes * 60);
  const endSeconds = startSeconds + gapDurationSeconds;
  const startMs = dayStartMs + startSeconds * 1000;
  const endMs = dayStartMs + endSeconds * 1000;
  const source = row.row === null ? `${date}:gap:${row.start_time}` : `excel-row:${row.row}`;
  const items = expandGapRange(date, startMs, endMs, source, context);

  if (items.length === 0) {
    context.errors.push({
      code: 'GAP_FILLER_MEDIA_NOT_AVAILABLE',
      itemId: source,
      message: `Gap from ${row.start_time} to ${row.end_time} on ${date} has no ready filler or emergency media.`,
    });
    return [missingItem({
      date,
      type: 'gap_filler',
      source,
      sourceRole: 'filler',
      programKey: null,
      hideLogo: false,
      title: row.title,
      trimStartSeconds: 0,
    }, startSeconds, endSeconds, 'missing_media')];
  }

  return items;
}

function expandInternalGap(
  date: string,
  startSeconds: number,
  endSeconds: number,
  source: string,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const dayStartMs = Date.parse(`${date}T00:00:00.000Z`);
  const startMs = dayStartMs + startSeconds * 1000;
  const endMs = dayStartMs + endSeconds * 1000;
  const items = expandGapRange(date, startMs, endMs, source, context);

  if (items.length === 0) {
    context.errors.push({
      code: 'GAP_FILLER_MEDIA_NOT_AVAILABLE',
      itemId: source,
      message: `Internal gap from ${formatClock(startSeconds)} to ${formatClock(endSeconds)} on ${date} has no ready filler or emergency media.`,
    });
    return [missingItem({
      date,
      type: 'gap_filler',
      source,
      sourceRole: 'filler',
      programKey: null,
      hideLogo: false,
      title: 'Professional Gap Preview',
      trimStartSeconds: 0,
    }, startSeconds, endSeconds, 'missing_media')];
  }

  return items;
}

function expandGapRange(
  date: string,
  startMs: number,
  endMs: number,
  source: string,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const dayStartMs = Date.parse(`${date}T00:00:00.000Z`);
  const professional = fillGapWithProfessionalBumpers(startMs, endMs, context.db, 0, {
    updateCursors: false,
    plannedCursors: context.gapFillerCursors,
  })
    .sort((a, b) => a.start_time_ms - b.start_time_ms);

  const items: ExpandedPlaylistItem[] = [];
  let currentMs = startMs;

  for (const item of professional) {
    if (item.end_time_ms <= currentMs) continue;
    if (item.start_time_ms > currentMs) {
      items.push(...expandGapFromFallbackFiles(date, currentMs, item.start_time_ms, source, context));
    }
    items.push(gapItemFromPlaylistItem(date, source, item, dayStartMs));
    currentMs = item.end_time_ms;
  }

  if (currentMs < endMs) {
    items.push(...expandGapFromFallbackFiles(date, currentMs, endMs, source, context));
  }

  return items;
}

function expandGapFromFallbackFiles(
  date: string,
  startMs: number,
  endMs: number,
  source: string,
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const files = context.db.prepare(`
    SELECT id, path, relative_path, filename, type, status, duration_sec, duration_ms, modified_at
    FROM media_files
    WHERE type IN ('filler', 'emergency') AND status='ready'
    ORDER BY CASE type WHEN 'filler' THEN 0 ELSE 1 END, filename, id
  `).all() as MediaFileRow[];

  if (files.length === 0) return [];

  const items: ExpandedPlaylistItem[] = [];
  let currentMs = startMs;
  let index = 0;
  const maxItems = Math.max(1, Math.ceil((endMs - startMs) / 1000));

  while (currentMs < endMs && index < maxItems) {
    const media = files[index % files.length];
    if (!media) break;
    const durationSeconds = mediaDuration(media);
    if (durationSeconds === null) {
      context.errors.push({
        code: 'MEDIA_DURATION_UNKNOWN',
        itemId: source,
        message: `Gap filler file "${media.filename}" has no known QC duration.`,
      });
      break;
    }
    if (!fs.existsSync(media.path)) {
      context.errors.push({
        code: 'MEDIA_FILE_MISSING_ON_DISK',
        itemId: source,
        message: `Gap filler file "${media.filename}" is ready in DB but missing on disk.`,
      });
      break;
    }

    const mediaDurationMs = durationSeconds * 1000;
    const itemEndMs = Math.min(currentMs + mediaDurationMs, endMs);
    const dayStartMs = Date.parse(`${date}T00:00:00.000Z`);
    const startSeconds = Math.round((currentMs - dayStartMs) / 1000);
    const endSeconds = Math.round((itemEndMs - dayStartMs) / 1000);
    items.push(readyItem({
      date,
      type: 'gap_filler',
      source,
      sourceRole: media.type === 'emergency' ? 'emergency' : 'filler',
      programKey: null,
      hideLogo: false,
      title: media.type === 'emergency' ? 'Emergency Fallback' : 'Filler',
      trimStartSeconds: 0,
      media,
      startSeconds,
      endSeconds,
      isTrimmed: itemEndMs - currentMs < mediaDurationMs,
    }));
    currentMs = itemEndMs;
    index++;
  }

  return items;
}

function gapItemFromPlaylistItem(
  date: string,
  source: string,
  item: {
    media_file_id: string;
    media_path: string;
    title: string;
    source_role: SourceRole;
    start_time_ms: number;
    end_time_ms: number;
    is_trimmed: boolean;
  },
  dayStartMs: number
): ExpandedPlaylistItem {
  const startSeconds = Math.round((item.start_time_ms - dayStartMs) / 1000);
  const endSeconds = Math.round((item.end_time_ms - dayStartMs) / 1000);
  return {
    id: uuidv4(),
    date,
    type: 'gap_filler',
    source,
    sourceRole: item.source_role,
    programKey: null,
    hideLogo: false,
    title: item.title,
    startTime: formatClock(startSeconds),
    endTime: formatClock(endSeconds),
    timelineStartSeconds: startSeconds,
    timelineEndSeconds: endSeconds,
    durationMinutes: (endSeconds - startSeconds) / 60,
    durationSeconds: endSeconds - startSeconds,
    mediaFileId: item.media_file_id,
    absolutePath: item.media_path,
    relativePath: null,
    trimStartSeconds: 0,
    trimEndSeconds: endSeconds - startSeconds,
    isTrimmed: item.is_trimmed,
    validationStatus: 'ready',
  };
}

function readyItem(args: {
  date: string;
  type: ExpandedPlaylistItemType;
  source: string;
  sourceRole: SourceRole;
  programKey: string | null;
  hideLogo: boolean;
  title: string;
  trimStartSeconds: 0;
  media: MediaFileRow;
  startSeconds: number;
  endSeconds: number;
  isTrimmed: boolean;
}): ExpandedPlaylistItem {
  const durationSeconds = args.endSeconds - args.startSeconds;
  return {
    id: uuidv4(),
    date: args.date,
    type: args.type,
    source: args.source,
    sourceRole: args.sourceRole,
    programKey: args.programKey,
    hideLogo: args.hideLogo,
    title: args.title,
    startTime: formatClock(args.startSeconds),
    endTime: formatClock(args.endSeconds),
    timelineStartSeconds: args.startSeconds,
    timelineEndSeconds: args.endSeconds,
    durationMinutes: durationSeconds / 60,
    durationSeconds,
    mediaFileId: args.media.id,
    absolutePath: args.media.path,
    relativePath: args.media.relative_path,
    trimStartSeconds: 0,
    trimEndSeconds: durationSeconds,
    isTrimmed: args.isTrimmed,
    validationStatus: 'ready',
  };
}

function missingItem(
  base: {
    date: string;
    type: ExpandedPlaylistItemType;
    source: string;
    sourceRole: SourceRole;
    programKey: string | null;
    hideLogo: boolean;
    title: string;
    trimStartSeconds: 0;
  },
  startSeconds: number,
  endSeconds: number,
  status: ExpandedPlaylistItemStatus,
  media?: MediaFileRow
): ExpandedPlaylistItem {
  const durationSeconds = Math.max(0, endSeconds - startSeconds);
  return {
    id: uuidv4(),
    date: base.date,
    type: base.type,
    source: base.source,
    sourceRole: base.sourceRole,
    programKey: base.programKey,
    hideLogo: base.hideLogo,
    title: base.title,
    startTime: formatClock(startSeconds),
    endTime: formatClock(endSeconds),
    timelineStartSeconds: startSeconds,
    timelineEndSeconds: endSeconds,
    durationMinutes: durationSeconds / 60,
    durationSeconds,
    mediaFileId: media?.id ?? null,
    absolutePath: media?.path ?? null,
    relativePath: media?.relative_path ?? null,
    trimStartSeconds: 0,
    trimEndSeconds: durationSeconds,
    isTrimmed: false,
    validationStatus: status,
  };
}

function getReadyFilesForFolder(folderId: string, context: ExpansionContext): MediaFileRow[] {
  const cached = context.filesByFolderId.get(folderId);
  if (cached) return cached;

  const files = context.db.prepare(`
    WITH RECURSIVE folder_tree(id) AS (
      SELECT id FROM media_folders WHERE id=?
      UNION ALL
      SELECT child.id
      FROM media_folders child
      JOIN folder_tree parent ON child.parent_folder_id=parent.id
    )
    SELECT id, path, relative_path, filename, type, status, folder_id, duration_sec, duration_ms, modified_at
    FROM media_files
    WHERE folder_id IN (SELECT id FROM folder_tree)
      AND status='ready'
      AND COALESCE(trash_status, 'active') = 'active'
    ORDER BY relative_path, filename, id
  `).all(folderId) as MediaFileRow[];
  context.filesByFolderId.set(folderId, files);
  return files;
}

function getFolderForId(folderId: string, context: ExpansionContext): MediaFolderRow | null {
  if (context.foldersById.has(folderId)) return context.foldersById.get(folderId) ?? null;

  const folder = context.db.prepare(`
    SELECT id, original_relative_path
    FROM media_folders
    WHERE id=?
  `).get(folderId) as MediaFolderRow | undefined;
  const value = folder ?? null;
  context.foldersById.set(folderId, value);
  return value;
}

function getKidsRoundRobinFilesForFolder(folderId: string, context: ExpansionContext): MediaFileRow[] {
  const cached = context.kidsRoundRobinFilesByFolderId.get(folderId);
  if (cached) return cached;

  const parent = getFolderForId(folderId, context);
  const files = getReadyFilesForFolder(folderId, context);
  const grouped = groupFilesByImmediateChildFolder(parent?.original_relative_path ?? '', files);
  const sequence = interleaveFileGroups(grouped);
  context.kidsRoundRobinFilesByFolderId.set(folderId, sequence);
  return sequence;
}

function groupFilesByImmediateChildFolder(parentRelativePath: string, files: MediaFileRow[]): MediaFileRow[][] {
  const parent = normalizeMediaRelativePath(parentRelativePath);
  const byChild = new Map<string, MediaFileRow[]>();

  for (const file of files) {
    const relativePath = normalizeMediaRelativePath(file.relative_path ?? file.filename ?? file.path);
    const childKey = immediateChildKey(parent, relativePath);
    const list = byChild.get(childKey) ?? [];
    list.push(file);
    byChild.set(childKey, list);
  }

  return Array.from(byChild.entries())
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
    .map(([, group]) => sortByEpisodeNumber(group));
}

function interleaveFileGroups(groups: MediaFileRow[][]): MediaFileRow[] {
  if (groups.length === 0) return [];
  const maxLength = Math.max(...groups.map(group => group.length));
  const interleaved: MediaFileRow[] = [];
  for (let index = 0; index < maxLength; index++) {
    for (const group of groups) {
      const item = group[index];
      if (item) interleaved.push(item);
    }
  }
  return interleaved;
}

function immediateChildKey(parentRelativePath: string, fileRelativePath: string): string {
  const parent = parentRelativePath.replace(/\/+$/g, '');
  let rest = fileRelativePath;
  if (parent && (fileRelativePath === parent || fileRelativePath.startsWith(`${parent}/`))) {
    rest = fileRelativePath.slice(parent.length).replace(/^\/+/g, '');
  }

  const segments = rest.split('/').filter(Boolean);
  if (segments.length <= 1) return '.';
  return segments[0]!;
}

function normalizeMediaRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/g, '').replace(/\/+/g, '/');
}

function getProgramCursor(programKey: string, context: ExpansionContext): ProgramCursor {
  const existing = context.programCursors.get(programKey);
  if (existing) return existing;
  const cursor = { nextIndex: 0 };
  context.programCursors.set(programKey, cursor);
  return cursor;
}

function selectNextFiles(
  programKey: string,
  files: MediaFileRow[],
  playMode: ProgramPlayMode,
  count: number,
  context: ExpansionContext
): MediaFileRow[] {
  if (files.length === 0 || count <= 0) return [];

  const ordered = orderFilesForPlayMode(files, playMode);
  if (ordered.length === 0) return [];

  if (playMode === 'shuffle') {
    return ordered.slice(0, count);
  }

  if (playMode === 'newest') {
    return ordered.slice(0, count);
  }

  const cursorKey = playMode === 'round_robin' ? `rr:${programKey}` : programKey;
  const cursor = getProgramCursor(cursorKey, context);
  const selected: MediaFileRow[] = [];
  for (let offset = 0; offset < count; offset++) {
    selected.push(ordered[(cursor.nextIndex + offset) % ordered.length]!);
  }
  cursor.nextIndex = (cursor.nextIndex + selected.length) % ordered.length;
  return selected;
}

function orderFilesForPlayMode(files: MediaFileRow[], playMode: ProgramPlayMode): MediaFileRow[] {
  if (playMode === 'shuffle') {
    return shuffleFiles(files);
  }
  if (playMode === 'newest') {
    return [...files].sort((a, b) => mediaModifiedTime(b) - mediaModifiedTime(a) || compareMediaFiles(a, b));
  }
  if (playMode === 'round_robin') {
    return interleaveRoundRobinFiles(files);
  }
  return sortByEpisodeNumber(files);
}

function interleaveRoundRobinFiles(files: MediaFileRow[]): MediaFileRow[] {
  const byDir = new Map<string, MediaFileRow[]>();
  for (const file of files) {
    const dir = path.dirname(file.relative_path ?? file.path);
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }

  const dirs = Array.from(byDir.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  for (const dir of dirs) {
    byDir.set(dir, sortByEpisodeNumber(byDir.get(dir)!));
  }

  const maxLength = Math.max(...dirs.map(dir => byDir.get(dir)!.length));
  const interleaved: MediaFileRow[] = [];
  for (let index = 0; index < maxLength; index++) {
    for (const dir of dirs) {
      const item = byDir.get(dir)![index];
      if (item) interleaved.push(item);
    }
  }
  return interleaved;
}

function sortByEpisodeNumber(files: MediaFileRow[]): MediaFileRow[] {
  return [...files].sort((a, b) => {
    const left = extractEpisodeNumber(a);
    const right = extractEpisodeNumber(b);
    if (left !== right) return left - right;
    return compareMediaFiles(a, b);
  });
}

function extractEpisodeNumber(file: MediaFileRow): number {
  const basename = path.basename(file.relative_path ?? file.filename ?? file.path, path.extname(file.filename ?? file.path));
  const leading = basename.match(/^(\d+)/);
  if (leading) return Number(leading[1]);
  const separated = basename.match(/(?:^|[\s_.-])(\d+)(?:[\s_.-]|$)/);
  if (separated) return Number(separated[1]);
  const any = basename.match(/\d+/);
  return any ? Number(any[0]) : Number.POSITIVE_INFINITY;
}

function compareMediaFiles(a: MediaFileRow, b: MediaFileRow): number {
  const left = a.relative_path ?? a.filename ?? a.path;
  const right = b.relative_path ?? b.filename ?? b.path;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

function shuffleFiles(files: MediaFileRow[]): MediaFileRow[] {
  const shuffled = [...files];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function mediaModifiedTime(file: MediaFileRow): number {
  const parsed = file.modified_at ? Date.parse(file.modified_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSlotMode(value: string): ProgramSlotMode {
  if (value === 'playlist' || value === 'file_count' || value === 'kids_round_robin') return value;
  return 'fit';
}

function normalizePlayMode(value: string): ProgramPlayMode {
  if (value === 'shuffle' || value === 'newest' || value === 'round_robin') return value;
  return 'sequential';
}

function validateProgramMedia(
  media: MediaFileRow,
  programKey: string,
  source: string,
  context: ExpansionContext
): number | null {
  const mediaDurationSeconds = mediaDuration(media);
  if (mediaDurationSeconds === null) {
    context.errors.push({
      code: 'MEDIA_DURATION_UNKNOWN',
      itemId: source,
      message: `Media file "${media.filename}" for program "${programKey}" has no known QC duration.`,
    });
    return null;
  }

  if (!fs.existsSync(media.path)) {
    context.errors.push({
      code: 'MEDIA_FILE_MISSING_ON_DISK',
      itemId: source,
      message: `Media file "${media.filename}" for program "${programKey}" is ready in DB but missing on disk.`,
    });
    return null;
  }

  return mediaDurationSeconds;
}

function validateTimeline(items: ExpandedPlaylistItem[], context: ExpansionContext): void {
  const byDate = new Map<string, ExpandedPlaylistItem[]>();
  for (const item of items) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    byDate.get(item.date)!.push(item);
  }

  for (const [date, dayItems] of byDate) {
    dayItems.sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds || a.timelineEndSeconds - b.timelineEndSeconds);
    let previousEnd = 0;
    for (const item of dayItems) {
      if (item.timelineEndSeconds < item.timelineStartSeconds) {
        context.errors.push({
          code: 'NEGATIVE_DURATION',
          itemId: item.id,
          message: `Item "${item.title}" on ${date} has a negative duration.`,
        });
      }
      if (item.timelineStartSeconds < previousEnd) {
        context.errors.push({
          code: 'PLAYLIST_OVERLAP',
          itemId: item.id,
          message: `Item "${item.title}" on ${date} overlaps the previous expanded item.`,
        });
      }
      if (item.timelineStartSeconds > previousEnd) {
        context.errors.push({
          code: 'UNFILLED_GAP',
          itemId: item.id,
          message: `Expanded playlist has an unfilled gap on ${date} before "${item.title}".`,
        });
      }
      previousEnd = Math.max(previousEnd, item.timelineEndSeconds);
    }
  }
}

function buildExpansionSummary(
  items: ExpandedPlaylistItem[],
  errors: PlaylistExpansionError[]
): PlaylistExpansionSummary {
  const missingMediaFileCount = items.filter(item => item.validationStatus === 'missing_media').length;
  const unknownDurationCount = items.filter(item => item.validationStatus === 'unknown_duration').length;
  const overlapCount = errors.filter(error => error.code === 'PLAYLIST_OVERLAP').length;
  const negativeGapCount = errors.filter(error => error.code === 'NEGATIVE_DURATION').length;
  const unfilledGapCount = errors.filter(error => error.code === 'UNFILLED_GAP').length;

  return {
    mediaExpansionAvailable: errors.length === 0 && items.length > 0 && items.every(item => item.validationStatus === 'ready'),
    missingMediaFileCount,
    unknownDurationCount,
    overlapCount,
    negativeGapCount,
    unfilledGapCount,
  };
}

function mediaDuration(media: MediaFileRow): number | null {
  if (typeof media.duration_ms === 'number' && media.duration_ms > 0) {
    return Math.round(media.duration_ms / 1000);
  }
  if (typeof media.duration_sec === 'number' && media.duration_sec > 0) {
    return Math.round(media.duration_sec);
  }
  return null;
}

function timeToSeconds(value: string): number {
  const minutes = parseTimeToMinutes(value);
  return (minutes ?? 0) * 60;
}

function formatClock(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
}

function formatPreviewTime(minutes: number): string {
  const safeMinutes = Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes)));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return `${pad2(hours)}:${pad2(mins)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatConcatFileLine(filePath: string): string {
  if (/[\u0000-\u001F\u007F]/.test(filePath)) {
    throw new DraftValidationError(
      'Media path contains characters that are unsafe for ffconcat',
      'MEDIA_PATH_UNSAFE_FOR_FFCONCAT'
    );
  }
  return `file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

function formatSeconds(seconds: number): string {
  return seconds.toFixed(3);
}
