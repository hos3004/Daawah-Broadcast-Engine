import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import type { ExcelImportPreviewResult } from './excelPreview';

export interface SourceExcelMetadata {
  filename: string;
  sha256: string;
}

export interface SaveSchedulerDraftInput {
  name?: string;
  sourceExcel: SourceExcelMetadata;
  preview: ExcelImportPreviewResult;
  createdBy?: string | null;
}

export interface SchedulerDraftListItem {
  id: string;
  name: string;
  status: 'draft';
  isActive: false;
  scheduleStartDate: string;
  scheduleEndDate: string;
  timezone: string;
  sourceExcelFilename: string;
  sourceExcelSha256: string;
  validationSummary: ExcelImportPreviewResult['summary'];
  programCount: number;
  slotCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerDraftDetail extends SchedulerDraftListItem {
  settings: ExcelImportPreviewResult['settings'];
  programs: ExcelImportPreviewResult['programs'];
  slots: ExcelImportPreviewResult['slots'];
  folderMatches: ExcelImportPreviewResult['folderMatches'];
  issues: ExcelImportPreviewResult['issues'];
  schedulePreview: ExcelImportPreviewResult['schedulePreview'];
  productionSafety: ExcelImportPreviewResult['productionSafety'];
  willActivateSchedule: false;
  willUpdateCursors: false;
  willMaterializePlaylist: false;
}

interface DraftRow {
  id: string;
  name: string;
  status: 'draft';
  is_active: number;
  schedule_start_date: string;
  schedule_end_date: string;
  timezone: string;
  source_excel_filename: string;
  source_excel_sha256: string;
  validation_summary_json: string;
  settings_json: string;
  programs_json: string;
  slots_json: string;
  folder_matches_json: string;
  issues_json: string;
  schedule_preview_json: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export class DraftValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
  }
}

export function saveSchedulerDraft(input: SaveSchedulerDraftInput): SchedulerDraftDetail {
  validateDraftInput(input);

  const db = getDb();
  const id = uuidv4();
  const preview = input.preview;
  const name = normalizeDraftName(input.name, preview);
  const sourceExcel = normalizeSourceExcel(input.sourceExcel);
  const row = {
    id,
    name,
    schedule_start_date: preview.settings.schedule_start_date,
    schedule_end_date: preview.settings.schedule_end_date,
    timezone: preview.settings.timezone,
    source_excel_filename: sourceExcel.filename,
    source_excel_sha256: sourceExcel.sha256.toLowerCase(),
    validation_summary_json: JSON.stringify(preview.summary),
    settings_json: JSON.stringify(preview.settings),
    programs_json: JSON.stringify(preview.programs),
    slots_json: JSON.stringify(preview.slots),
    folder_matches_json: JSON.stringify(preview.folderMatches),
    issues_json: JSON.stringify(preview.issues),
    schedule_preview_json: JSON.stringify(preview.schedulePreview),
    created_by: input.createdBy ?? null,
  };

  db.prepare(`
    INSERT INTO scheduler_drafts (
      id, name, schedule_start_date, schedule_end_date, timezone,
      source_excel_filename, source_excel_sha256, validation_summary_json,
      settings_json, programs_json, slots_json, folder_matches_json,
      issues_json, schedule_preview_json, created_by
    )
    VALUES (
      @id, @name, @schedule_start_date, @schedule_end_date, @timezone,
      @source_excel_filename, @source_excel_sha256, @validation_summary_json,
      @settings_json, @programs_json, @slots_json, @folder_matches_json,
      @issues_json, @schedule_preview_json, @created_by
    )
  `).run(row);

  const saved = getSchedulerDraft(id);
  if (!saved) {
    throw new Error('Draft was saved but could not be read back');
  }
  return saved;
}

export function listSchedulerDrafts(limit = 50): SchedulerDraftListItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM scheduler_drafts
    ORDER BY created_at DESC
    LIMIT ?
  `).all(clampLimit(limit)) as DraftRow[];

  return rows.map(rowToListItem);
}

export function getSchedulerDraft(id: string): SchedulerDraftDetail | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduler_drafts WHERE id=?').get(id) as DraftRow | undefined;
  return row ? rowToDetail(row) : null;
}

function validateDraftInput(input: SaveSchedulerDraftInput): void {
  if (!input || typeof input !== 'object') {
    throw new DraftValidationError('Draft payload is required', 'DRAFT_PAYLOAD_REQUIRED');
  }
  if (!input.preview || typeof input.preview !== 'object') {
    throw new DraftValidationError('Validated preview payload is required', 'PREVIEW_REQUIRED');
  }

  const preview = input.preview;
  if (preview.mode !== 'preview') {
    throw new DraftValidationError('Only Excel import preview results can be saved as drafts', 'PREVIEW_MODE_REQUIRED');
  }
  if (!preview.settings?.schedule_start_date || !preview.settings?.schedule_end_date) {
    throw new DraftValidationError('Preview must include a valid schedule date range', 'DATE_RANGE_REQUIRED');
  }
  if (!Array.isArray(preview.programs) || preview.programs.length === 0) {
    throw new DraftValidationError('Preview must include at least one program', 'PROGRAMS_REQUIRED');
  }
  if (!Array.isArray(preview.slots) || preview.slots.length === 0) {
    throw new DraftValidationError('Preview must include at least one slot', 'SLOTS_REQUIRED');
  }
  if ((preview.summary?.errors ?? 1) > 0) {
    throw new DraftValidationError('Draft save requires a preview with zero validation errors', 'PREVIEW_HAS_ERRORS');
  }
  if (
    preview.willActivateSchedule !== false ||
    preview.willUpdateCursors !== false ||
    preview.willMaterializePlaylist !== false ||
    preview.productionSafety?.previewOnly !== true ||
    preview.productionSafety?.cursorUpdates !== false ||
    preview.productionSafety?.playlistMaterialization !== false ||
    preview.productionSafety?.ffmpeg !== false ||
    preview.productionSafety?.scheduleActivation !== false
  ) {
    throw new DraftValidationError('Unsafe preview payload cannot be saved as a draft', 'UNSAFE_PREVIEW_PAYLOAD');
  }

  normalizeSourceExcel(input.sourceExcel);
}

function normalizeDraftName(name: string | undefined, preview: ExcelImportPreviewResult): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed.slice(0, 160);
  return `Draft schedule ${preview.settings.schedule_start_date} to ${preview.settings.schedule_end_date}`;
}

function normalizeSourceExcel(sourceExcel: SourceExcelMetadata): SourceExcelMetadata {
  const filename = sourceExcel?.filename ? String(sourceExcel.filename).split(/[\\/]/).pop()!.trim() : '';
  const sha256 = sourceExcel?.sha256 ? String(sourceExcel.sha256).trim() : '';
  if (!filename) {
    throw new DraftValidationError('Source Excel filename is required', 'SOURCE_EXCEL_FILENAME_REQUIRED');
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new DraftValidationError('Source Excel SHA-256 hash is required', 'SOURCE_EXCEL_HASH_REQUIRED');
  }
  return {
    filename: filename.slice(0, 255),
    sha256,
  };
}

function rowToListItem(row: DraftRow): SchedulerDraftListItem {
  const validationSummary = parseJson<ExcelImportPreviewResult['summary']>(row.validation_summary_json);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    isActive: false,
    scheduleStartDate: row.schedule_start_date,
    scheduleEndDate: row.schedule_end_date,
    timezone: row.timezone,
    sourceExcelFilename: row.source_excel_filename,
    sourceExcelSha256: row.source_excel_sha256,
    validationSummary,
    programCount: validationSummary.programCount,
    slotCount: validationSummary.slotCount,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDetail(row: DraftRow): SchedulerDraftDetail {
  return {
    ...rowToListItem(row),
    settings: parseJson(row.settings_json),
    programs: parseJson(row.programs_json),
    slots: parseJson(row.slots_json),
    folderMatches: parseJson(row.folder_matches_json),
    issues: parseJson(row.issues_json),
    schedulePreview: parseJson(row.schedule_preview_json),
    productionSafety: {
      previewOnly: true,
      cursorUpdates: false,
      playlistMaterialization: false,
      ffmpeg: false,
      scheduleActivation: false,
    },
    willActivateSchedule: false,
    willUpdateCursors: false,
    willMaterializePlaylist: false,
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit)) return 50;
  return Math.min(Math.max(limit, 1), 100);
}
