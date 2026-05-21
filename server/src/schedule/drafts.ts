import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import { parseTimeToMinutes, type ExcelImportPreviewResult } from './excelPreview';

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

export type DraftValidationStatus = 'draft_valid' | 'draft_invalid';

export interface DraftValidationIssue {
  severity: 'error';
  code: string;
  message: string;
  field?: string;
  row?: number;
}

export interface SchedulerDraftListItem {
  id: string;
  name: string;
  status: 'draft';
  isActive: false;
  validationStatus: DraftValidationStatus;
  validationErrors: DraftValidationIssue[];
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

export interface PublishSchedulerDraftInput {
  draftId: string;
  publishedBy?: string | null;
}

export interface PublishedScheduleListItem {
  id: string;
  sourceDraftId: string;
  name: string;
  status: 'published';
  isActive: false;
  validationStatus: 'draft_valid';
  validationErrors: DraftValidationIssue[];
  scheduleStartDate: string;
  scheduleEndDate: string;
  timezone: string;
  sourceExcelFilename: string;
  sourceExcelSha256: string;
  validationSummary: ExcelImportPreviewResult['summary'];
  programCount: number;
  slotCount: number;
  publishedBy: string | null;
  publishedAt: string;
  createdAt: string;
}

export interface PublishedScheduleDetail extends PublishedScheduleListItem {
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
  validation_status: DraftValidationStatus;
  validation_errors_json: string;
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

interface PublishedScheduleRow {
  id: string;
  source_draft_id: string;
  name: string;
  status: 'published';
  is_active: number;
  schedule_start_date: string;
  schedule_end_date: string;
  timezone: string;
  source_excel_filename: string;
  source_excel_sha256: string;
  validation_status: 'draft_valid';
  validation_errors_json: string;
  validation_summary_json: string;
  settings_json: string;
  programs_json: string;
  slots_json: string;
  folder_matches_json: string;
  issues_json: string;
  schedule_preview_json: string;
  published_by: string | null;
  published_at: string;
  created_at: string;
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
  const db = getDb();
  const id = uuidv4();
  const preview = input.preview;
  const sourceExcel = normalizeSourceExcel(input.sourceExcel);
  const validation = validateDraftInput(input, sourceExcel);
  const name = normalizeDraftName(input.name, preview);
  const row = {
    id,
    name,
    schedule_start_date: preview.settings.schedule_start_date,
    schedule_end_date: preview.settings.schedule_end_date,
    timezone: preview.settings.timezone,
    source_excel_filename: sourceExcel.filename,
    source_excel_sha256: sourceExcel.sha256.toLowerCase(),
    validation_status: validation.status,
    validation_errors_json: JSON.stringify(validation.errors),
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
      source_excel_filename, source_excel_sha256, validation_status,
      validation_errors_json, validation_summary_json, settings_json,
      programs_json, slots_json, folder_matches_json,
      issues_json, schedule_preview_json, created_by
    )
    VALUES (
      @id, @name, @schedule_start_date, @schedule_end_date, @timezone,
      @source_excel_filename, @source_excel_sha256, @validation_status,
      @validation_errors_json, @validation_summary_json, @settings_json,
      @programs_json, @slots_json, @folder_matches_json,
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

export function publishSchedulerDraft(input: PublishSchedulerDraftInput): PublishedScheduleDetail {
  const db = getDb();
  const draftId = cleanString(input.draftId);
  if (!draftId) {
    throw new DraftValidationError('Draft schedule id is required', 'DRAFT_ID_REQUIRED');
  }

  const draft = getSchedulerDraft(draftId);
  if (!draft) {
    throw new DraftValidationError('Draft schedule not found', 'DRAFT_NOT_FOUND');
  }

  const existing = db.prepare('SELECT id FROM scheduler_published_schedules WHERE source_draft_id=?').get(draftId) as
    | { id: string }
    | undefined;
  if (existing) {
    throw new DraftValidationError('Draft schedule has already been published', 'DRAFT_ALREADY_PUBLISHED');
  }

  assertDraftCanPublish(draft);

  const id = uuidv4();
  const publishedAt = new Date().toISOString();
  const row = {
    id,
    source_draft_id: draft.id,
    name: draft.name,
    schedule_start_date: draft.scheduleStartDate,
    schedule_end_date: draft.scheduleEndDate,
    timezone: draft.timezone,
    source_excel_filename: draft.sourceExcelFilename,
    source_excel_sha256: draft.sourceExcelSha256,
    validation_status: draft.validationStatus,
    validation_errors_json: JSON.stringify(draft.validationErrors),
    validation_summary_json: JSON.stringify(draft.validationSummary),
    settings_json: JSON.stringify(draft.settings),
    programs_json: JSON.stringify(draft.programs),
    slots_json: JSON.stringify(draft.slots),
    folder_matches_json: JSON.stringify(draft.folderMatches),
    issues_json: JSON.stringify(draft.issues),
    schedule_preview_json: JSON.stringify(draft.schedulePreview),
    published_by: input.publishedBy ?? null,
    published_at: publishedAt,
  };

  const insertPublished = db.transaction(() => {
    db.prepare(`
      INSERT INTO scheduler_published_schedules (
        id, source_draft_id, name, schedule_start_date, schedule_end_date,
        timezone, source_excel_filename, source_excel_sha256, validation_status,
        validation_errors_json, validation_summary_json, settings_json,
        programs_json, slots_json, folder_matches_json, issues_json,
        schedule_preview_json, published_by, published_at
      )
      VALUES (
        @id, @source_draft_id, @name, @schedule_start_date, @schedule_end_date,
        @timezone, @source_excel_filename, @source_excel_sha256, @validation_status,
        @validation_errors_json, @validation_summary_json, @settings_json,
        @programs_json, @slots_json, @folder_matches_json, @issues_json,
        @schedule_preview_json, @published_by, @published_at
      )
    `).run(row);

    db.prepare(`
      INSERT INTO audit_logs (id, action, entity_type, entity_id, detail)
      VALUES (@id, @action, @entity_type, @entity_id, @detail)
    `).run({
      id: uuidv4(),
      action: 'scheduler_foundation.publish_schedule',
      entity_type: 'scheduler_published_schedule',
      entity_id: id,
      detail: JSON.stringify({
        sourceDraftId: draft.id,
        publishedBy: input.publishedBy ?? null,
        validationStatus: draft.validationStatus,
        validationSummary: draft.validationSummary,
        willActivateSchedule: false,
        willUpdateCursors: false,
        willMaterializePlaylist: false,
      }),
    });
  });

  insertPublished();

  const published = getPublishedSchedule(id);
  if (!published) {
    throw new Error('Published schedule was saved but could not be read back');
  }
  return published;
}

export function listPublishedSchedules(limit = 50): PublishedScheduleListItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM scheduler_published_schedules
    ORDER BY published_at DESC
    LIMIT ?
  `).all(clampLimit(limit)) as PublishedScheduleRow[];

  return rows.map(rowToPublishedListItem);
}

export function getPublishedSchedule(id: string): PublishedScheduleDetail | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduler_published_schedules WHERE id=?').get(id) as
    | PublishedScheduleRow
    | undefined;
  return row ? rowToPublishedDetail(row) : null;
}

function assertDraftCanPublish(draft: SchedulerDraftDetail): void {
  if (draft.status !== 'draft') {
    throw new DraftValidationError('Only draft schedules can be published', 'DRAFT_STATUS_REQUIRED');
  }
  if (draft.isActive !== false) {
    throw new DraftValidationError('Active schedules cannot be published from the draft workflow', 'DRAFT_MUST_BE_INACTIVE');
  }
  if (draft.validationStatus !== 'draft_valid') {
    throw new DraftValidationError('Only valid drafts can be published', 'DRAFT_NOT_PUBLISHABLE');
  }
  if (draft.validationErrors.length > 0) {
    throw new DraftValidationError('Draft validation errors must be resolved before publishing', 'DRAFT_VALIDATION_ERRORS_PRESENT');
  }
  if (draft.validationSummary.errors !== 0) {
    throw new DraftValidationError('Draft preview errors must be zero before publishing', 'DRAFT_PREVIEW_ERRORS_PRESENT');
  }
  if (typeof draft.validationSummary.conflicts === 'number' && draft.validationSummary.conflicts > 0) {
    throw new DraftValidationError('Draft schedule conflicts must be zero before publishing', 'DRAFT_CONFLICTS_PRESENT');
  }
  if (!parseDateOnly(draft.scheduleStartDate) || !parseDateOnly(draft.scheduleEndDate)) {
    throw new DraftValidationError('Draft schedule date range is invalid', 'DRAFT_DATE_RANGE_INVALID');
  }
  const start = parseDateOnly(draft.scheduleStartDate);
  const end = parseDateOnly(draft.scheduleEndDate);
  if (!start || !end || end.getTime() < start.getTime()) {
    throw new DraftValidationError('Draft schedule date range is invalid', 'DRAFT_DATE_RANGE_INVALID');
  }
  if (!isValidTimezone(draft.timezone)) {
    throw new DraftValidationError('Draft timezone is invalid', 'DRAFT_INVALID_TIMEZONE');
  }
  if (!/^[a-f0-9]{64}$/i.test(draft.sourceExcelSha256)) {
    throw new DraftValidationError('Draft source Excel SHA-256 hash is invalid', 'SOURCE_EXCEL_HASH_REQUIRED');
  }
  if (
    draft.willActivateSchedule !== false ||
    draft.willUpdateCursors !== false ||
    draft.willMaterializePlaylist !== false
  ) {
    throw new DraftValidationError('Unsafe draft cannot be published', 'UNSAFE_DRAFT_PAYLOAD');
  }
}

function validateDraftInput(
  input: SaveSchedulerDraftInput,
  sourceExcel: SourceExcelMetadata
): { status: DraftValidationStatus; errors: DraftValidationIssue[] } {
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
  if (!isPlainObject(preview.settings)) {
    throw new DraftValidationError('Preview settings payload is required', 'PREVIEW_SETTINGS_REQUIRED');
  }
  if (!preview.settings.schedule_start_date || !preview.settings.schedule_end_date) {
    throw new DraftValidationError('Preview must include a valid schedule date range', 'DATE_RANGE_REQUIRED');
  }
  if (!isPlainObject(preview.summary)) {
    throw new DraftValidationError('Preview summary payload is required', 'PREVIEW_SUMMARY_REQUIRED');
  }
  if (!Array.isArray(preview.programs) || preview.programs.length === 0) {
    throw new DraftValidationError('Preview must include at least one program', 'PROGRAMS_REQUIRED');
  }
  if (!preview.programs.every(isPlainObject)) {
    throw new DraftValidationError('Preview programs must be object rows', 'PROGRAM_ROWS_INVALID');
  }
  if (!Array.isArray(preview.slots) || preview.slots.length === 0) {
    throw new DraftValidationError('Preview must include at least one slot', 'SLOTS_REQUIRED');
  }
  if (!preview.slots.every(isPlainObject)) {
    throw new DraftValidationError('Preview slots must be object rows', 'SLOT_ROWS_INVALID');
  }
  if (!Array.isArray(preview.folderMatches) || !preview.folderMatches.every(isPlainObject)) {
    throw new DraftValidationError('Preview folder matches must be object rows', 'FOLDER_MATCH_ROWS_INVALID');
  }
  if (!Array.isArray(preview.issues) || !preview.issues.every(isPlainObject)) {
    throw new DraftValidationError('Preview issues must be object rows', 'ISSUE_ROWS_INVALID');
  }
  if (!isPlainObject(preview.schedulePreview) || !Array.isArray(preview.schedulePreview.days)) {
    throw new DraftValidationError('Preview schedule days payload is required', 'SCHEDULE_PREVIEW_REQUIRED');
  }
  if (!preview.schedulePreview.days.every(isPlainObject)) {
    throw new DraftValidationError('Preview schedule day rows must be objects', 'SCHEDULE_PREVIEW_DAYS_INVALID');
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

  const errors = validateDraftSemantics(preview, sourceExcel);
  return {
    status: errors.length > 0 ? 'draft_invalid' : 'draft_valid',
    errors,
  };
}

const DAY_ORDER = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const DAY_SET = new Set(DAY_ORDER);
const MINUTES_PER_DAY = 24 * 60;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface ExpandedDraftInterval {
  day: string;
  start: number;
  end: number;
  row?: number;
  programKey: string;
}

function validateDraftSemantics(
  preview: ExcelImportPreviewResult,
  sourceExcel: SourceExcelMetadata
): DraftValidationIssue[] {
  const errors: DraftValidationIssue[] = [];
  validateSourceExcelConsistency(preview, sourceExcel, errors);
  validateSummary(preview, errors);

  const programKeys = collectProgramKeys(preview, errors);
  validateDateRange(preview, errors);
  validateTimezone(preview, errors);
  validateSchedulePreview(preview, errors);
  validateSlots(preview, programKeys, errors);
  validateFolderMatches(preview, programKeys, errors);

  return errors;
}

function validateSourceExcelConsistency(
  preview: ExcelImportPreviewResult,
  sourceExcel: SourceExcelMetadata,
  errors: DraftValidationIssue[]
): void {
  const embeddedSource = (preview as unknown as {
    sourceExcel?: { sha256?: unknown };
    source_excel_sha256?: unknown;
  });
  const embeddedHash = cleanString(embeddedSource.sourceExcel?.sha256 ?? embeddedSource.source_excel_sha256).toLowerCase();
  if (embeddedHash && embeddedHash !== sourceExcel.sha256.toLowerCase()) {
    pushValidationError(errors, {
      code: 'DRAFT_SOURCE_HASH_MISMATCH',
      field: 'sourceExcel.sha256',
      message: 'Source Excel SHA-256 does not match the hash embedded in the preview payload.',
    });
  }
}

function validateSummary(preview: ExcelImportPreviewResult, errors: DraftValidationIssue[]): void {
  const requiredSummaryNumbers = ['errors', 'warnings', 'programCount', 'slotCount'] as const;
  for (const field of requiredSummaryNumbers) {
    if (!isNonNegativeNumber(preview.summary[field])) {
      pushValidationError(errors, {
        code: 'DRAFT_SUMMARY_FIELD_INVALID',
        field: `summary.${field}`,
        message: `Preview summary field "${field}" must be a non-negative number.`,
      });
    }
  }

  if (isNonNegativeNumber(preview.summary.errors) && preview.summary.errors > 0) {
    pushValidationError(errors, {
      code: 'PREVIEW_HAS_ERRORS',
      field: 'summary.errors',
      message: 'Preview contains validation errors and is stored as an invalid inactive draft.',
    });
  }
  if (isNonNegativeNumber(preview.summary.programCount) && preview.summary.programCount !== preview.programs.length) {
    pushValidationError(errors, {
      code: 'DRAFT_PROGRAM_COUNT_MISMATCH',
      field: 'summary.programCount',
      message: `Preview summary reports ${preview.summary.programCount} programs but payload contains ${preview.programs.length}.`,
    });
  }
  if (isNonNegativeNumber(preview.summary.slotCount) && preview.summary.slotCount !== preview.slots.length) {
    pushValidationError(errors, {
      code: 'DRAFT_SLOT_COUNT_MISMATCH',
      field: 'summary.slotCount',
      message: `Preview summary reports ${preview.summary.slotCount} slots but payload contains ${preview.slots.length}.`,
    });
  }
}

function collectProgramKeys(preview: ExcelImportPreviewResult, errors: DraftValidationIssue[]): Set<string> {
  const programKeys = new Set<string>();
  for (const program of preview.programs) {
    const programKey = cleanString(program.program_key);
    if (!programKey) {
      pushValidationError(errors, {
        code: 'DRAFT_EMPTY_PROGRAM_KEY',
        field: 'programs.program_key',
        row: numberOrUndefined(program.row),
        message: 'Program rows must include a non-empty program_key.',
      });
      continue;
    }
    if (programKeys.has(programKey)) {
      pushValidationError(errors, {
        code: 'DRAFT_DUPLICATE_PROGRAM_KEY',
        field: 'programs.program_key',
        row: numberOrUndefined(program.row),
        message: `Duplicate program_key "${programKey}" found in draft payload.`,
      });
    }
    programKeys.add(programKey);
  }

  const acceptedProgramKeys = (preview as unknown as { acceptedProgramKeys?: unknown }).acceptedProgramKeys;
  if (!Array.isArray(acceptedProgramKeys) || !acceptedProgramKeys.every(value => typeof value === 'string')) {
    pushValidationError(errors, {
      code: 'DRAFT_ACCEPTED_PROGRAM_KEYS_INVALID',
      field: 'acceptedProgramKeys',
      message: 'Preview must include acceptedProgramKeys as an array of strings.',
    });
  } else {
    for (const programKey of acceptedProgramKeys) {
      if (!programKeys.has(programKey)) {
        pushValidationError(errors, {
          code: 'DRAFT_ACCEPTED_PROGRAM_KEY_UNKNOWN',
          field: 'acceptedProgramKeys',
          message: `acceptedProgramKeys contains unknown program_key "${programKey}".`,
        });
      }
    }
  }

  return programKeys;
}

function validateDateRange(preview: ExcelImportPreviewResult, errors: DraftValidationIssue[]): void {
  const start = parseDateOnly(preview.settings.schedule_start_date);
  const end = parseDateOnly(preview.settings.schedule_end_date);
  if (!start || !end || end.getTime() < start.getTime()) {
    pushValidationError(errors, {
      code: 'DRAFT_DATE_RANGE_INVALID',
      field: 'settings.schedule_start_date',
      message: 'Draft schedule date range must use YYYY-MM-DD dates and end on or after the start date.',
    });
    return;
  }

  const expectedDays = diffDaysInclusive(start, end);
  if (isNonNegativeNumber(preview.settings.rangeDays) && preview.settings.rangeDays !== expectedDays) {
    pushValidationError(errors, {
      code: 'DRAFT_DATE_RANGE_DAYS_MISMATCH',
      field: 'settings.rangeDays',
      message: `settings.rangeDays is ${preview.settings.rangeDays}, expected ${expectedDays}.`,
    });
  }

  for (const slot of preview.slots) {
    const fromText = cleanString(slot.effective_from) || preview.settings.schedule_start_date;
    const toText = cleanString(slot.effective_to) || preview.settings.schedule_end_date;
    const from = parseDateOnly(fromText);
    const to = parseDateOnly(toText);
    if (!from || !to || to.getTime() < from.getTime()) {
      pushValidationError(errors, {
        code: 'DRAFT_SLOT_EFFECTIVE_RANGE_INVALID',
        field: 'slots.effective_from',
        row: numberOrUndefined(slot.row),
        message: 'Slot effective date range must use YYYY-MM-DD dates and end on or after the start date.',
      });
      continue;
    }
    if (from.getTime() < start.getTime() || to.getTime() > end.getTime()) {
      pushValidationError(errors, {
        code: 'DRAFT_SLOT_OUTSIDE_DATE_RANGE',
        field: 'slots.effective_from',
        row: numberOrUndefined(slot.row),
        message: `Slot effective range ${fromText} to ${toText} is outside the draft range ${preview.settings.schedule_start_date} to ${preview.settings.schedule_end_date}.`,
      });
    }
  }
}

function validateTimezone(preview: ExcelImportPreviewResult, errors: DraftValidationIssue[]): void {
  const timezone = cleanString(preview.settings.timezone);
  if (!timezone || !isValidTimezone(timezone)) {
    pushValidationError(errors, {
      code: 'DRAFT_INVALID_TIMEZONE',
      field: 'settings.timezone',
      message: `Timezone "${timezone || '(empty)'}" is not a valid IANA timezone.`,
    });
  }
  if (cleanString(preview.schedulePreview.timezone) && preview.schedulePreview.timezone !== timezone) {
    pushValidationError(errors, {
      code: 'DRAFT_PREVIEW_TIMEZONE_MISMATCH',
      field: 'schedulePreview.timezone',
      message: 'Schedule preview timezone must match settings.timezone.',
    });
  }
}

function validateSchedulePreview(preview: ExcelImportPreviewResult, errors: DraftValidationIssue[]): void {
  const start = parseDateOnly(preview.settings.schedule_start_date);
  const end = parseDateOnly(preview.settings.schedule_end_date);
  if (!start || !end || end.getTime() < start.getTime()) return;

  const days = preview.schedulePreview.days;
  if (days.length === 0) {
    pushValidationError(errors, {
      code: 'DRAFT_SCHEDULE_PREVIEW_EMPTY',
      field: 'schedulePreview.days',
      message: 'Schedule preview must include at least one preview day.',
    });
    return;
  }

  const firstDate = cleanString(days[0]?.date);
  if (firstDate !== preview.settings.schedule_start_date) {
    pushValidationError(errors, {
      code: 'DRAFT_SCHEDULE_PREVIEW_START_MISMATCH',
      field: 'schedulePreview.days',
      message: `Schedule preview starts at ${firstDate || '(empty)'}, expected ${preview.settings.schedule_start_date}.`,
    });
  }

  if (!preview.schedulePreview.truncated) {
    const lastDate = cleanString(days[days.length - 1]?.date);
    const expectedDays = diffDaysInclusive(start, end);
    if (lastDate !== preview.settings.schedule_end_date) {
      pushValidationError(errors, {
        code: 'DRAFT_SCHEDULE_PREVIEW_END_MISMATCH',
        field: 'schedulePreview.days',
        message: `Schedule preview ends at ${lastDate || '(empty)'}, expected ${preview.settings.schedule_end_date}.`,
      });
    }
    if (days.length !== expectedDays) {
      pushValidationError(errors, {
        code: 'DRAFT_SCHEDULE_PREVIEW_DAYS_MISMATCH',
        field: 'schedulePreview.days',
        message: `Schedule preview has ${days.length} days, expected ${expectedDays}.`,
      });
    }
  }

  for (const day of days) {
    if (!parseDateOnly(cleanString(day.date))) {
      pushValidationError(errors, {
        code: 'DRAFT_SCHEDULE_PREVIEW_DAY_INVALID',
        field: 'schedulePreview.days.date',
        message: 'Schedule preview days must contain YYYY-MM-DD dates.',
      });
    }
    if (!DAY_SET.has(cleanString(day.day))) {
      pushValidationError(errors, {
        code: 'DRAFT_SCHEDULE_PREVIEW_DAY_KEY_INVALID',
        field: 'schedulePreview.days.day',
        message: `Schedule preview day key "${cleanString(day.day)}" is not valid.`,
      });
    }
  }
}

function validateSlots(
  preview: ExcelImportPreviewResult,
  programKeys: Set<string>,
  errors: DraftValidationIssue[]
): void {
  const intervalsByDay = new Map<string, ExpandedDraftInterval[]>();

  for (const slot of preview.slots) {
    const programKey = cleanString(slot.program_key);
    const row = numberOrUndefined(slot.row);
    if (!programKey) {
      pushValidationError(errors, {
        code: 'DRAFT_EMPTY_SLOT_PROGRAM_REFERENCE',
        field: 'slots.program_key',
        row,
        message: 'Slot rows must reference a non-empty program_key.',
      });
    } else if (!programKeys.has(programKey)) {
      pushValidationError(errors, {
        code: 'DRAFT_SLOT_PROGRAM_NOT_FOUND',
        field: 'slots.program_key',
        row,
        message: `Slot references unknown program_key "${programKey}".`,
      });
    }

    if (!Array.isArray(slot.days) || slot.days.length === 0) {
      pushValidationError(errors, {
        code: 'DRAFT_SLOT_DAYS_REQUIRED',
        field: 'slots.days',
        row,
        message: 'Slot rows must include at least one valid day.',
      });
      continue;
    }

    const slotDays = slot.days.map(day => cleanString(day)).filter(Boolean);
    const invalidDays = slotDays.filter(day => !DAY_SET.has(day));
    if (invalidDays.length > 0) {
      pushValidationError(errors, {
        code: 'DRAFT_SLOT_DAY_INVALID',
        field: 'slots.days',
        row,
        message: `Slot contains invalid day key(s): ${invalidDays.join(', ')}.`,
      });
      continue;
    }

    const start = slotStartMinutes(slot);
    const end = slotComputedEndMinutes(slot, start);
    if (start === null || end === null || end <= start) {
      pushValidationError(errors, {
        code: 'DRAFT_SLOT_TIME_INVALID',
        field: 'slots.start_time',
        row,
        message: 'Slot start/end time or duration is invalid.',
      });
      continue;
    }

    for (const day of slotDays) {
      const dayIntervals = intervalsByDay.get(day) ?? [];
      dayIntervals.push({
        day,
        start,
        end: Math.min(end, MINUTES_PER_DAY),
        row,
        programKey,
      });
      intervalsByDay.set(day, dayIntervals);

      if (end > MINUTES_PER_DAY) {
        const overflowDay = nextDay(day);
        const overflowIntervals = intervalsByDay.get(overflowDay) ?? [];
        overflowIntervals.push({
          day: overflowDay,
          start: 0,
          end: end - MINUTES_PER_DAY,
          row,
          programKey,
        });
        intervalsByDay.set(overflowDay, overflowIntervals);
      }
    }
  }

  for (const [day, intervals] of intervalsByDay) {
    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 0; index < intervals.length - 1; index++) {
      const current = intervals[index]!;
      const next = intervals[index + 1]!;
      if (current.end > next.start) {
        pushValidationError(errors, {
          code: 'DRAFT_SLOT_OVERLAP',
          field: 'slots.start_time',
          row: next.row,
          message: `Slot for "${next.programKey}" overlaps "${current.programKey}" on ${day}.`,
        });
      }
    }
  }
}

function validateFolderMatches(
  preview: ExcelImportPreviewResult,
  programKeys: Set<string>,
  errors: DraftValidationIssue[]
): void {
  const knownFolderIds = getKnownFolderIds();
  if (knownFolderIds === null) return;

  for (const match of preview.folderMatches) {
    const programKey = cleanString(match.program_key);
    if (programKey && !programKeys.has(programKey)) {
      pushValidationError(errors, {
        code: 'DRAFT_FOLDER_MATCH_PROGRAM_NOT_FOUND',
        field: 'folderMatches.program_key',
        row: numberOrUndefined(match.row),
        message: `Folder match references unknown program_key "${programKey}".`,
      });
    }

    if (match.status !== 'matched') continue;
    const matchedFolderId = cleanString(match.matched_folder_id);
    if (!matchedFolderId) {
      pushValidationError(errors, {
        code: 'DRAFT_FOLDER_MATCH_MISSING_ID',
        field: 'folderMatches.matched_folder_id',
        row: numberOrUndefined(match.row),
        message: 'Matched folder rows must include matched_folder_id.',
      });
      continue;
    }
    if (!knownFolderIds.has(matchedFolderId)) {
      pushValidationError(errors, {
        code: 'DRAFT_FOLDER_MATCH_NOT_INDEXED',
        field: 'folderMatches.matched_folder_id',
        row: numberOrUndefined(match.row),
        message: `Matched folder id "${matchedFolderId}" is not present in the media registry.`,
      });
    }
  }
}

function getKnownFolderIds(): Set<string> | null {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM media_folders').get() as { cnt: number }).cnt;
  if (count === 0) return null;
  const rows = db.prepare('SELECT id FROM media_folders').all() as Array<{ id: string }>;
  return new Set(rows.map(row => row.id));
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
    sha256: sha256.toLowerCase(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pushValidationError(
  errors: DraftValidationIssue[],
  issue: Omit<DraftValidationIssue, 'severity'>
): void {
  errors.push({
    severity: 'error',
    ...issue,
  });
}

function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function diffDaysInclusive(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date('2026-01-01T00:00:00.000Z'));
    return true;
  } catch {
    return false;
  }
}

function slotStartMinutes(slot: ExcelImportPreviewResult['slots'][number]): number | null {
  if (typeof slot.start_minutes === 'number' && Number.isFinite(slot.start_minutes)) return slot.start_minutes;
  return parseTimeToMinutes(slot.start_time);
}

function slotComputedEndMinutes(
  slot: ExcelImportPreviewResult['slots'][number],
  start: number | null
): number | null {
  if (typeof slot.computed_end_minutes === 'number' && Number.isFinite(slot.computed_end_minutes)) {
    return slot.computed_end_minutes;
  }
  if (start === null) return null;

  if (typeof slot.end_minutes === 'number' && Number.isFinite(slot.end_minutes)) {
    return slot.end_minutes <= start ? slot.end_minutes + MINUTES_PER_DAY : slot.end_minutes;
  }

  const parsedEnd = parseTimeToMinutes(slot.end_time);
  if (parsedEnd !== null) {
    return parsedEnd <= start ? parsedEnd + MINUTES_PER_DAY : parsedEnd;
  }

  if (typeof slot.duration_minutes === 'number' && Number.isFinite(slot.duration_minutes) && slot.duration_minutes > 0) {
    return start + slot.duration_minutes;
  }

  return null;
}

function nextDay(day: string): string {
  const index = DAY_ORDER.indexOf(day);
  return DAY_ORDER[(index + 1) % DAY_ORDER.length] ?? DAY_ORDER[0]!;
}

function rowToListItem(row: DraftRow): SchedulerDraftListItem {
  const validationSummary = parseJson<ExcelImportPreviewResult['summary']>(row.validation_summary_json);
  const validationErrors = parseJson<DraftValidationIssue[]>(row.validation_errors_json);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    isActive: false,
    validationStatus: row.validation_status,
    validationErrors,
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

function rowToPublishedListItem(row: PublishedScheduleRow): PublishedScheduleListItem {
  const validationSummary = parseJson<ExcelImportPreviewResult['summary']>(row.validation_summary_json);
  const validationErrors = parseJson<DraftValidationIssue[]>(row.validation_errors_json);
  return {
    id: row.id,
    sourceDraftId: row.source_draft_id,
    name: row.name,
    status: row.status,
    isActive: false,
    validationStatus: row.validation_status,
    validationErrors,
    scheduleStartDate: row.schedule_start_date,
    scheduleEndDate: row.schedule_end_date,
    timezone: row.timezone,
    sourceExcelFilename: row.source_excel_filename,
    sourceExcelSha256: row.source_excel_sha256,
    validationSummary,
    programCount: validationSummary.programCount,
    slotCount: validationSummary.slotCount,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

function rowToPublishedDetail(row: PublishedScheduleRow): PublishedScheduleDetail {
  return {
    ...rowToPublishedListItem(row),
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
