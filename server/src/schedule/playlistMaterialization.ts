import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import {
  DraftValidationError,
  getActiveScheduleState,
  getPublishedSchedule,
  type PublishedScheduleDetail,
} from './drafts';
import {
  expandPublishedScheduleToFiles,
  renderFfconcat,
  type ExpandedPlaylistItem,
  type PlaylistExpansionSummary as FileExpansionSummary,
} from './playlistExpansion';
import { listNormalizedSets, type NormalizedSetDiffItem } from '../media/normalizationManager';

export interface PlaylistMaterializationDryRunInput {
  confirmDryRun?: boolean;
  publishedScheduleId?: string;
  outputRoot?: string;
  createdBy?: string | null;
}

export interface PlaylistMaterializationWarning {
  code: string;
  message: string;
  itemId?: string;
}

export interface PlaylistMaterializationError {
  code: string;
  message: string;
  itemId?: string;
}

export interface PlaylistMaterializationSummary {
  runId: string;
  mode: 'dry_run';
  status: 'completed' | 'failed';
  scheduleId: string;
  scheduleName: string;
  dateRange: {
    start: string;
    end: string;
  };
  timezone: string;
  sourceExcelFilename: string;
  sourceExcelSha256: string;
  dayCount: number;
  itemCount: number;
  scheduledItemCount: number;
  gapFillerItemCount: number;
  totalScheduledMinutes: number;
  totalGapMinutes: number;
  mediaExpansionAvailable: boolean;
  missingMediaFileCount: number;
  unknownDurationCount: number;
  normalizedSetId: string | null;
  normalizedSetApplied: boolean;
  normalizedMediaCount: number;
  originalSafeFallbackCount: number;
  missingNormalizedCount: number;
  originalNotNormalizedCount: number;
  concatRiskCount: number;
  overlapCount: number;
  negativeGapCount: number;
  unfilledGapCount: number;
  testPlayoutEligible: boolean;
  ffconcatPath: string | null;
  outputPath: string;
  safety: {
    publish: false;
    activate: false;
    playlistArtifactsUsedForPlayout: false;
    cursorMutation: false;
    ffmpeg: false;
    ffprobe: false;
    playout: false;
    broadcast: false;
    mediaModification: false;
  };
}

export type MaterializedPlaylistItem = ExpandedPlaylistItem;

export interface PlaylistMaterializationRunDetail {
  id: string;
  publishedScheduleId: string;
  mode: 'dry_run';
  status: 'completed' | 'failed';
  outputPath: string;
  summary: PlaylistMaterializationSummary;
  warnings: PlaylistMaterializationWarning[];
  errors: PlaylistMaterializationError[];
  createdBy: string | null;
  createdAt: string;
}

interface PlaylistMaterializationRunRow {
  id: string;
  published_schedule_id: string;
  mode: 'dry_run';
  status: 'completed' | 'failed';
  output_path: string;
  summary_json: string;
  warnings_json: string;
  errors_json: string;
  created_by: string | null;
  created_at: string;
}

interface ValidatedDryRunInput {
  confirmDryRun: true;
  schedule: PublishedScheduleDetail;
  outputRoot: string;
  createdBy: string | null;
}

interface SafeOutputPaths {
  generatedRoot: string;
  outputRoot: string;
  runDir: string;
}

interface NormalizedApplicationSummary {
  normalizedSetId: string | null;
  normalizedSetApplied: boolean;
  normalizedMediaCount: number;
  originalSafeFallbackCount: number;
  missingNormalizedCount: number;
  originalNotNormalizedCount: number;
  concatRiskCount: number;
}

export function validateMaterializationDryRunInput(input: PlaylistMaterializationDryRunInput): ValidatedDryRunInput {
  if (input.confirmDryRun !== true) {
    throw new DraftValidationError('Playlist materialization dry-run requires confirmDryRun=true', 'DRY_RUN_CONFIRMATION_REQUIRED');
  }

  const requestedScheduleId = cleanString(input.publishedScheduleId);
  const activeState = getActiveScheduleState();
  const scheduleId = requestedScheduleId || activeState?.publishedScheduleId || '';
  if (!scheduleId) {
    throw new DraftValidationError('No active or selected published schedule is available for dry-run materialization', 'NO_ACTIVE_OR_SELECTED_SCHEDULE', 404);
  }

  const schedule = getPublishedSchedule(scheduleId);
  if (!schedule) {
    throw new DraftValidationError('Published schedule not found for dry-run materialization', 'PUBLISHED_SCHEDULE_NOT_FOUND', 404);
  }
  validateScheduleSnapshot(schedule);

  return {
    confirmDryRun: true,
    schedule,
    outputRoot: validateOutputRoot(input.outputRoot).outputRoot,
    createdBy: input.createdBy ?? null,
  };
}

export function createPlaylistMaterializationDryRun(input: PlaylistMaterializationDryRunInput): PlaylistMaterializationRunDetail {
  const validated = validateMaterializationDryRunInput(input);
  const runId = uuidv4();
  const paths = validateOutputRoot(validated.outputRoot, runId);
  const createdAt = new Date().toISOString();
  const expansion = expandPublishedScheduleToFiles(validated.schedule);
  const warnings: PlaylistMaterializationWarning[] = expansion.warnings;
  const errors: PlaylistMaterializationError[] = expansion.errors;
  const normalized = applyLatestNormalizedSet(expansion.items, warnings, errors);
  const expansionSummary = {
    ...expansion.summary,
    mediaExpansionAvailable: expansion.summary.mediaExpansionAvailable && normalized.summary.concatRiskCount === 0,
  };
  const ffconcatPath = expansionSummary.mediaExpansionAvailable
    ? path.join(paths.runDir, 'playlist.ffconcat')
    : null;
  const playlist = buildPlaylistSnapshot(
    validated.schedule,
    runId,
    createdAt,
    normalized.items,
    expansionSummary.mediaExpansionAvailable,
    ffconcatPath
  );
  const summary = buildSummary(
    validated.schedule,
    runId,
    paths.runDir,
    playlist.items,
    warnings,
    errors,
    expansionSummary,
    ffconcatPath,
    normalized.summary
  );
  const status: 'completed' | 'failed' = errors.length === 0 ? 'completed' : 'failed';
  summary.status = status;

  const db = getDb();
  try {
    fs.mkdirSync(paths.runDir, { recursive: true });
    writeJsonWithin(paths.generatedRoot, path.join(paths.runDir, 'playlist.json'), playlist);
    if (ffconcatPath) {
      writeTextWithin(paths.generatedRoot, ffconcatPath, renderFfconcat(playlist.items));
    }
    writeJsonWithin(paths.generatedRoot, path.join(paths.runDir, 'report.json'), {
      runId,
      summary,
      warnings,
      errors,
    });
    writeTextWithin(paths.generatedRoot, path.join(paths.runDir, 'report.md'), renderMarkdownReport(summary, warnings, errors));

    const saveRun = db.transaction(() => {
      db.prepare(`
        INSERT INTO playlist_materialization_runs (
          id, published_schedule_id, mode, status, output_path,
          summary_json, warnings_json, errors_json, created_by, created_at
        )
        VALUES (
          @id, @published_schedule_id, @mode, @status, @output_path,
          @summary_json, @warnings_json, @errors_json, @created_by, @created_at
        )
      `).run({
        id: runId,
        published_schedule_id: validated.schedule.id,
        mode: 'dry_run',
        status,
        output_path: paths.runDir,
        summary_json: JSON.stringify(summary),
        warnings_json: JSON.stringify(warnings),
        errors_json: JSON.stringify(errors),
        created_by: validated.createdBy,
        created_at: createdAt,
      });

      db.prepare(`
        INSERT INTO audit_logs (id, action, entity_type, entity_id, detail)
        VALUES (@id, @action, @entity_type, @entity_id, @detail)
      `).run({
        id: uuidv4(),
        action: 'scheduler_foundation.playlist_materialization_dry_run',
        entity_type: 'playlist_materialization_run',
        entity_id: runId,
        detail: JSON.stringify({
          runId,
          publishedScheduleId: validated.schedule.id,
          outputPath: paths.runDir,
          status,
          createdBy: validated.createdBy,
          warningCount: warnings.length,
          errorCount: errors.length,
          dryRun: true,
          mediaExpansionAvailable: summary.mediaExpansionAvailable,
          testPlayoutEligible: summary.testPlayoutEligible,
          ffconcatPath,
          cursorMutation: false,
          playout: false,
          broadcast: false,
        }),
      });
    });
    saveRun();

    const saved = getPlaylistMaterializationRun(runId);
    if (!saved) {
      throw new Error('Playlist materialization dry-run was saved but could not be read back');
    }
    return saved;
  } catch (err) {
    cleanupRunDir(paths.generatedRoot, paths.runDir);
    throw err;
  }
}

export function listPlaylistMaterializationRuns(limit = 50): PlaylistMaterializationRunDetail[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM playlist_materialization_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(clampLimit(limit)) as PlaylistMaterializationRunRow[];
  return rows.map(rowToRun);
}

export function getPlaylistMaterializationRun(id: string): PlaylistMaterializationRunDetail | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM playlist_materialization_runs WHERE id=?').get(id) as
    | PlaylistMaterializationRunRow
    | undefined;
  return row ? rowToRun(row) : null;
}

export function getDefaultPlaylistMaterializationRoot(): string {
  return path.join(getProjectRoot(), 'generated', 'playlists');
}

function validateScheduleSnapshot(schedule: PublishedScheduleDetail): void {
  if (schedule.status !== 'published') {
    throw new DraftValidationError('Only published schedules can be materialized in dry-run mode', 'PUBLISHED_STATUS_REQUIRED');
  }
  if (schedule.validationStatus !== 'draft_valid' || schedule.validationErrors.length > 0) {
    throw new DraftValidationError('Only valid published schedules can be materialized in dry-run mode', 'PUBLISHED_NOT_MATERIALIZABLE');
  }
  if (schedule.validationSummary.errors !== 0) {
    throw new DraftValidationError('Published schedule errors must be zero before materialization dry-run', 'PUBLISHED_PREVIEW_ERRORS_PRESENT');
  }
  if (typeof schedule.validationSummary.conflicts === 'number' && schedule.validationSummary.conflicts > 0) {
    throw new DraftValidationError('Published schedule conflicts must be zero before materialization dry-run', 'PUBLISHED_CONFLICTS_PRESENT');
  }
  if (!schedule.scheduleStartDate || !schedule.scheduleEndDate || schedule.scheduleEndDate < schedule.scheduleStartDate) {
    throw new DraftValidationError('Published schedule date range is invalid', 'PUBLISHED_DATE_RANGE_INVALID');
  }
  if (
    schedule.willActivateSchedule !== false ||
    schedule.willUpdateCursors !== false ||
    schedule.willMaterializePlaylist !== false
  ) {
    throw new DraftValidationError('Unsafe published schedule cannot be materialized', 'UNSAFE_PUBLISHED_SCHEDULE');
  }
}

function validateOutputRoot(outputRoot?: string, runId?: string): SafeOutputPaths {
  const generatedRoot = getDefaultPlaylistMaterializationRoot();
  const resolvedOutputRoot = outputRoot
    ? path.resolve(getProjectRoot(), outputRoot)
    : generatedRoot;
  if (!isPathInside(resolvedOutputRoot, generatedRoot)) {
    throw new DraftValidationError('Playlist materialization output path must stay under generated/playlists', 'UNSAFE_OUTPUT_PATH');
  }
  const runDir = path.join(resolvedOutputRoot, runId ?? '__validation__');
  if (!isPathInside(runDir, generatedRoot)) {
    throw new DraftValidationError('Playlist materialization run path must stay under generated/playlists', 'UNSAFE_OUTPUT_PATH');
  }
  return {
    generatedRoot,
    outputRoot: resolvedOutputRoot,
    runDir,
  };
}

function applyLatestNormalizedSet(
  items: MaterializedPlaylistItem[],
  warnings: PlaylistMaterializationWarning[],
  errors: PlaylistMaterializationError[]
): { items: MaterializedPlaylistItem[]; summary: NormalizedApplicationSummary } {
  const normalizedSet = listNormalizedSets(1).find(set => set.status === 'ready' && set.summary.canUseForPlaylist);
  if (!normalizedSet) {
    return {
      items,
      summary: {
        normalizedSetId: null,
        normalizedSetApplied: false,
        normalizedMediaCount: 0,
        originalSafeFallbackCount: 0,
        missingNormalizedCount: 0,
        originalNotNormalizedCount: 0,
        concatRiskCount: 0,
      },
    };
  }

  const byMediaId = new Map(
    normalizedSet.diff
      .filter(item => item.mediaFileId)
      .map(item => [item.mediaFileId as string, item])
  );
  const byOriginalPath = new Map(normalizedSet.diff.map(item => [path.resolve(item.originalPath), item]));
  let normalizedMediaCount = 0;
  let originalSafeFallbackCount = 0;
  let missingNormalizedCount = 0;
  let originalNotNormalizedCount = 0;

  const nextItems = items.map(item => {
    if (!item.absolutePath || item.validationStatus !== 'ready') return item;
    const match = findNormalizedMatch(item, byMediaId, byOriginalPath);
    if (!match) {
      originalNotNormalizedCount++;
      errors.push({
        code: 'NORMALIZED_MAPPING_MISSING',
        itemId: item.id,
        message: `Playlist item "${item.title}" has no entry in normalized set ${normalizedSet.id}.`,
      });
      return item;
    }
    if (match.normalizedExists) {
      normalizedMediaCount++;
      return {
        ...item,
        absolutePath: match.normalizedPath,
        relativePath: path.relative(normalizedSet.outputRoot, match.normalizedPath),
      };
    }
    if (match.originalSafeFallback) {
      originalSafeFallbackCount++;
      warnings.push({
        code: 'NORMALIZED_ORIGINAL_SAFE_FALLBACK',
        itemId: item.id,
        message: `Playlist item "${item.title}" is already broadcast-safe and remains on its original path.`,
      });
      return item;
    }

    missingNormalizedCount++;
    errors.push({
      code: 'NORMALIZED_FILE_MISSING',
      itemId: item.id,
      message: `Playlist item "${item.title}" expected normalized file ${match.normalizedPath}, but it is missing.`,
    });
    return item;
  });

  const concatRiskCount = missingNormalizedCount + originalNotNormalizedCount;
  return {
    items: nextItems,
    summary: {
      normalizedSetId: normalizedSet.id,
      normalizedSetApplied: true,
      normalizedMediaCount,
      originalSafeFallbackCount,
      missingNormalizedCount,
      originalNotNormalizedCount,
      concatRiskCount,
    },
  };
}

function findNormalizedMatch(
  item: MaterializedPlaylistItem,
  byMediaId: Map<string, NormalizedSetDiffItem>,
  byOriginalPath: Map<string, NormalizedSetDiffItem>
): NormalizedSetDiffItem | undefined {
  if (item.mediaFileId) {
    const byId = byMediaId.get(item.mediaFileId);
    if (byId) return byId;
  }
  return item.absolutePath ? byOriginalPath.get(path.resolve(item.absolutePath)) : undefined;
}

function buildPlaylistSnapshot(
  schedule: PublishedScheduleDetail,
  runId: string,
  generatedAt: string,
  items: MaterializedPlaylistItem[],
  mediaExpansionAvailable: boolean,
  ffconcatPath: string | null
): {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  timezone: string;
  generatedAt: string;
  dryRun: true;
  mediaExpansionAvailable: boolean;
  ffconcatPath: string | null;
  days: Array<{ date: string; itemCount: number }>;
  items: MaterializedPlaylistItem[];
} {
  return {
    runId,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    timezone: schedule.timezone,
    generatedAt,
    dryRun: true,
    mediaExpansionAvailable,
    ffconcatPath,
    days: schedule.schedulePreview.days.map(day => ({
      date: day.date,
      itemCount: items.filter(item => item.date === day.date).length,
    })),
    items,
  };
}

function buildSummary(
  schedule: PublishedScheduleDetail,
  runId: string,
  outputPath: string,
  items: MaterializedPlaylistItem[],
  warnings: PlaylistMaterializationWarning[],
  errors: PlaylistMaterializationError[],
  expansionSummary: FileExpansionSummary,
  ffconcatPath: string | null,
  normalizedSummary: NormalizedApplicationSummary
): PlaylistMaterializationSummary {
  const scheduledItems = items.filter(item => item.type === 'program');
  const gapItems = items.filter(item => item.type === 'gap_filler');
  const testPlayoutEligible = expansionSummary.mediaExpansionAvailable && ffconcatPath !== null;
  return {
    runId,
    mode: 'dry_run',
    status: errors.length === 0 ? 'completed' : 'failed',
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    dateRange: {
      start: schedule.scheduleStartDate,
      end: schedule.scheduleEndDate,
    },
    timezone: schedule.timezone,
    sourceExcelFilename: schedule.sourceExcelFilename,
    sourceExcelSha256: schedule.sourceExcelSha256,
    dayCount: schedule.schedulePreview.days.length,
    itemCount: items.length,
    scheduledItemCount: scheduledItems.length,
    gapFillerItemCount: gapItems.length,
    totalScheduledMinutes: sumMinutes(scheduledItems),
    totalGapMinutes: sumMinutes(gapItems),
    mediaExpansionAvailable: expansionSummary.mediaExpansionAvailable,
    missingMediaFileCount: expansionSummary.missingMediaFileCount,
    unknownDurationCount: expansionSummary.unknownDurationCount,
    normalizedSetId: normalizedSummary.normalizedSetId,
    normalizedSetApplied: normalizedSummary.normalizedSetApplied,
    normalizedMediaCount: normalizedSummary.normalizedMediaCount,
    originalSafeFallbackCount: normalizedSummary.originalSafeFallbackCount,
    missingNormalizedCount: normalizedSummary.missingNormalizedCount,
    originalNotNormalizedCount: normalizedSummary.originalNotNormalizedCount,
    concatRiskCount: normalizedSummary.concatRiskCount,
    overlapCount: expansionSummary.overlapCount,
    negativeGapCount: expansionSummary.negativeGapCount,
    unfilledGapCount: expansionSummary.unfilledGapCount,
    testPlayoutEligible,
    ffconcatPath,
    outputPath,
    safety: {
      publish: false,
      activate: false,
      playlistArtifactsUsedForPlayout: false,
      cursorMutation: false,
      ffmpeg: false,
      ffprobe: false,
      playout: false,
      broadcast: false,
      mediaModification: false,
    },
  };
}

function renderMarkdownReport(
  summary: PlaylistMaterializationSummary,
  warnings: PlaylistMaterializationWarning[],
  errors: PlaylistMaterializationError[]
): string {
  const warningLines = warnings.length > 0
    ? warnings.map(warning => `- ${warning.code}: ${warning.message}`).join('\n')
    : '- none';
  const errorLines = errors.length > 0
    ? errors.map(error => `- ${error.code}: ${error.message}`).join('\n')
    : '- none';
  return `# Playlist Materialization Dry-Run Report

## Summary

- Run ID: ${summary.runId}
- Schedule ID: ${summary.scheduleId}
- Schedule name: ${summary.scheduleName}
- Date range: ${summary.dateRange.start} to ${summary.dateRange.end}
- Timezone: ${summary.timezone}
- Output path: ${summary.outputPath}
- Items: ${summary.itemCount}
- Scheduled items: ${summary.scheduledItemCount}
- Gap filler items: ${summary.gapFillerItemCount}
- Total scheduled minutes: ${summary.totalScheduledMinutes}
- Total gap minutes: ${summary.totalGapMinutes}
- Media expansion available: ${summary.mediaExpansionAvailable}
- Missing media files: ${summary.missingMediaFileCount}
- Unknown durations: ${summary.unknownDurationCount}
- Normalized set ID: ${summary.normalizedSetId ?? 'none'}
- Normalized set applied: ${summary.normalizedSetApplied}
- Normalized media paths: ${summary.normalizedMediaCount}
- Original safe fallbacks: ${summary.originalSafeFallbackCount}
- Missing normalized files: ${summary.missingNormalizedCount}
- Original not normalized: ${summary.originalNotNormalizedCount}
- Concat risk: ${summary.concatRiskCount}
- Timeline overlaps: ${summary.overlapCount}
- Unfilled gaps: ${summary.unfilledGapCount}
- Test playout eligible: ${summary.testPlayoutEligible}
- FFconcat path: ${summary.ffconcatPath ?? 'none'}
- Status: ${summary.status}

## Safety

- publish: false
- activate: false
- playlist artifacts used for playout: false
- cursor mutation: false
- ffmpeg: false
- ffprobe: false
- playout: false
- broadcast: false
- media modification: false

## Warnings

${warningLines}

## Errors

${errorLines}
`;
}

function rowToRun(row: PlaylistMaterializationRunRow): PlaylistMaterializationRunDetail {
  return {
    id: row.id,
    publishedScheduleId: row.published_schedule_id,
    mode: row.mode,
    status: row.status,
    outputPath: row.output_path,
    summary: JSON.parse(row.summary_json) as PlaylistMaterializationSummary,
    warnings: JSON.parse(row.warnings_json) as PlaylistMaterializationWarning[],
    errors: JSON.parse(row.errors_json) as PlaylistMaterializationError[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function getProjectRoot(): string {
  return path.resolve(process.env['PLAYLIST_MATERIALIZATION_PROJECT_ROOT'] ?? path.resolve(__dirname, '../../..'));
}

function writeJsonWithin(root: string, filePath: string, value: unknown): void {
  writeTextWithin(root, filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextWithin(root: string, filePath: string, value: string): void {
  if (!isPathInside(filePath, root)) {
    throw new DraftValidationError('Refusing to write playlist artifact outside generated/playlists', 'UNSAFE_OUTPUT_PATH');
  }
  fs.writeFileSync(filePath, value, 'utf8');
}

function cleanupRunDir(root: string, runDir: string): void {
  if (!isPathInside(runDir, root)) {
    return;
  }
  fs.rmSync(runDir, { recursive: true, force: true });
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function sumMinutes(items: MaterializedPlaylistItem[]): number {
  return items.reduce((total, item) => total + item.durationMinutes, 0);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit)) return 50;
  return Math.min(Math.max(limit, 1), 100);
}
