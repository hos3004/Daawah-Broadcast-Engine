import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import {
  fillGapWithProfessionalBumpers,
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
  duration_sec: number | null;
  duration_ms: number | null;
  modified_at: string | null;
}

interface ProgramCursor {
  nextIndex: number;
}

interface ExpansionContext {
  db: Db;
  programsByKey: Map<string, PublishedScheduleDetail['programs'][number]>;
  folderIdByProgramKey: Map<string, string>;
  filesByFolderId: Map<string, MediaFileRow[]>;
  programCursors: Map<string, ProgramCursor>;
  warnings: PlaylistExpansionWarning[];
  errors: PlaylistExpansionError[];
}

const MAX_EXPANDED_ITEMS_PER_ROW = 10_000;

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
    programCursors: new Map(),
    warnings: [],
    errors: [],
  };

  const items: ExpandedPlaylistItem[] = [];

  for (const day of schedule.schedulePreview.days) {
    for (const row of day.rows) {
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
  row: PublishedScheduleDetail['schedulePreview']['days'][number]['rows'][number],
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const startSeconds = timeToSeconds(row.start_time);
  const slotDurationSeconds = Math.round(row.duration_minutes * 60);
  const endSeconds = startSeconds + slotDurationSeconds;
  const programKey = row.program_key ?? '';
  const source = row.row === null ? `${date}:program:${row.start_time}` : `excel-row:${row.row}`;
  const baseItem = {
    date,
    type: 'program' as const,
    source,
    sourceRole: 'program' as SourceRole,
    programKey: programKey || null,
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

  const folderId = context.folderIdByProgramKey.get(programKey);
  if (!folderId) {
    context.errors.push({
      code: 'PROGRAM_FOLDER_NOT_MATCHED',
      itemId: source,
      message: `Program "${programKey}" has no approved matched media folder.`,
    });
    return [missingItem(baseItem, startSeconds, endSeconds, 'missing_media')];
  }

  const files = getReadyFilesForFolder(folderId, context);
  if (files.length === 0) {
    context.errors.push({
      code: 'PROGRAM_MEDIA_NOT_AVAILABLE',
      itemId: source,
      message: `Program "${programKey}" has no ready media files in matched folder ${folderId}.`,
    });
    return [missingItem(baseItem, startSeconds, endSeconds, 'missing_media')];
  }

  const cursor = getProgramCursor(programKey, context);
  const items: ExpandedPlaylistItem[] = [];
  let currentSeconds = startSeconds;
  let remainingSeconds = slotDurationSeconds;
  let attempts = 0;

  while (remainingSeconds > 0 && attempts < MAX_EXPANDED_ITEMS_PER_ROW) {
    attempts++;
    const media = files[cursor.nextIndex % files.length];
    if (!media) break;
    cursor.nextIndex = (cursor.nextIndex + 1) % files.length;

    const mediaDurationSeconds = mediaDuration(media);
    if (mediaDurationSeconds === null) {
      context.errors.push({
        code: 'MEDIA_DURATION_UNKNOWN',
        itemId: source,
        message: `Media file "${media.filename}" for program "${programKey}" has no known QC duration.`,
      });
      items.push(missingItem(baseItem, currentSeconds, endSeconds, 'unknown_duration', media));
      break;
    }

    if (!fs.existsSync(media.path)) {
      context.errors.push({
        code: 'MEDIA_FILE_MISSING_ON_DISK',
        itemId: source,
        message: `Media file "${media.filename}" for program "${programKey}" is ready in DB but missing on disk.`,
      });
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
      itemId: source,
      message: `Program slot "${row.title}" on ${date} could not be expanded to its full duration.`,
    });
    items.push(missingItem(baseItem, currentSeconds, endSeconds, 'missing_media'));
  }

  if (attempts >= MAX_EXPANDED_ITEMS_PER_ROW) {
    context.errors.push({
      code: 'PROGRAM_EXPANSION_SAFETY_LIMIT',
      itemId: source,
      message: `Program slot "${row.title}" exceeded the file expansion safety limit.`,
    });
  }

  return items;
}

function expandGapRow(
  date: string,
  row: PublishedScheduleDetail['schedulePreview']['days'][number]['rows'][number],
  context: ExpansionContext
): ExpandedPlaylistItem[] {
  const dayStartMs = Date.parse(`${date}T00:00:00.000Z`);
  const startSeconds = timeToSeconds(row.start_time);
  const gapDurationSeconds = Math.round(row.duration_minutes * 60);
  const endSeconds = startSeconds + gapDurationSeconds;
  const startMs = dayStartMs + startSeconds * 1000;
  const endMs = dayStartMs + endSeconds * 1000;
  const source = row.row === null ? `${date}:gap:${row.start_time}` : `excel-row:${row.row}`;
  const professional = fillGapWithProfessionalBumpers(startMs, endMs, context.db, 0, { updateCursors: false })
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
      title: row.title,
      trimStartSeconds: 0,
    }, startSeconds, endSeconds, 'missing_media')];
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
    SELECT id, path, relative_path, filename, type, status, duration_sec, duration_ms, modified_at
    FROM media_files
    WHERE folder_id=? AND status='ready'
    ORDER BY filename, id
  `).all(folderId) as MediaFileRow[];
  context.filesByFolderId.set(folderId, files);
  return files;
}

function getProgramCursor(programKey: string, context: ExpansionContext): ProgramCursor {
  const existing = context.programCursors.get(programKey);
  if (existing) return existing;
  const cursor = { nextIndex: 0 };
  context.programCursors.set(programKey, cursor);
  return cursor;
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
