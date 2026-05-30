import { parse as csvParse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { normalizeArabicForMatch } from '../media/safeNaming';
import { DEFAULT_MEDIA_ROOTS, normalizeRootRelativePath, SafeRootError } from '../media/safeRoots';

export const SUPPORTED_PLAY_MODES = ['sequential', 'shuffle', 'newest', 'round_robin'] as const;
export const SUPPORTED_SLOT_MODES = ['fit', 'playlist', 'file_count', 'kids_round_robin'] as const;
export const SUPPORTED_REPEAT_POLICIES = ['same_day_same_episode', 'advance_each_airing'] as const;

export type ExcelPreviewSeverity = 'error' | 'warning' | 'info';
export type ExcelSheetName = 'Settings' | 'Programs' | 'Slots' | 'Overrides';
export type PreviewRowStatus = 'ok' | 'warning' | 'error';
export type FolderMatchStatus = 'matched' | 'needs_review' | 'folder_missing' | 'rejected' | 'error';

export interface ExcelPreviewIssue {
  severity: ExcelPreviewSeverity;
  code: string;
  sheet: ExcelSheetName;
  row?: number;
  field?: string;
  message: string;
}

export interface ExcelPreviewInput {
  settings?: Record<string, unknown>[];
  programs: Record<string, unknown>[];
  slots: Record<string, unknown>[];
  overrides?: Record<string, unknown>[];
}

export interface FolderMatchCandidate {
  folder_id: string;
  root_key: string;
  original_relative_path: string;
  display_name_ar: string;
  normalized_name: string;
  safe_slug: string;
  file_count: number;
  episode_count?: number;
}

export interface ExcelPreviewOptions {
  appTimezone?: string;
  folderCandidates?: FolderMatchCandidate[];
  maxPreviewDays?: number;
}

export interface SettingsPreview {
  row: number | null;
  status: PreviewRowStatus;
  timezone: string;
  timezoneSource: 'sheet' | 'default';
  schedule_start_date: string;
  schedule_end_date: string;
  default_duration_policy: string;
  default_repeat_policy: string;
  default_gap_policy: string;
  rangeDays: number | null;
  issues: ExcelPreviewIssue[];
}

export interface ProgramPreviewRow {
  row: number;
  status: PreviewRowStatus;
  program_key: string;
  program_name: string;
  hide_logo: boolean;
  folder_hint: string;
  normalized_folder_hint: string | null;
  folder_root: string;
  play_mode: string;
  slot_mode: string;
  file_count: number | null;
  repeat_policy: string;
  enabled: boolean | null;
  notes: string;
  issues: ExcelPreviewIssue[];
}

export interface SlotPreviewRow {
  row: number;
  status: PreviewRowStatus;
  program_key: string;
  days: string[];
  raw_days: string;
  start_time: string;
  end_time: string;
  duration_minutes: number | null;
  effective_from: string;
  effective_to: string;
  priority: number | null;
  notes: string;
  start_minutes: number | null;
  end_minutes: number | null;
  computed_end_minutes: number | null;
  crosses_midnight: boolean;
  issues: ExcelPreviewIssue[];
}

export interface FolderMatchSuggestion {
  folder_id: string;
  root_key: string;
  original_relative_path: string;
  display_name_ar: string;
  confidence: number;
  reason: string;
}

export interface FolderMatchPreview {
  row: number;
  program_key: string;
  folder_root: string;
  folder_hint: string;
  status: FolderMatchStatus;
  status_ar: string;
  confidence: number;
  matched_folder_id: string | null;
  matched_relative_path: string | null;
  suggestions: FolderMatchSuggestion[];
  message: string;
}

export interface SchedulePreviewRow {
  type: 'slot' | 'gap';
  row: number | null;
  program_key: string | null;
  title: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
}

export interface SchedulePreviewDay {
  date: string;
  day: string;
  rows: SchedulePreviewRow[];
}

export interface ExcelImportPreviewResult {
  mode: 'preview';
  willActivateSchedule: false;
  willUpdateCursors: false;
  willMaterializePlaylist: false;
  productionSafety: {
    previewOnly: true;
    cursorUpdates: false;
    playlistMaterialization: false;
    ffmpeg: false;
    scheduleActivation: false;
  };
  settings: SettingsPreview;
  programs: ProgramPreviewRow[];
  slots: SlotPreviewRow[];
  folderMatches: FolderMatchPreview[];
  schedulePreview: {
    timezone: string;
    gapPattern: string;
    truncated: boolean;
    days: SchedulePreviewDay[];
  };
  summary: {
    settingsRows: number;
    programRows: number;
    slotRows: number;
    programCount: number;
    matchedPrograms: number;
    needsReviewPrograms: number;
    missingFolders: number;
    rejectedFolders: number;
    slotCount: number;
    conflicts: number;
    warnings: number;
    errors: number;
    crossingMidnight: number;
    fileStatus: 'صالح للمعاينة' | 'يحتاج مراجعة' | 'يحتوي على أخطاء' | 'غير صالح';
  };
  issues: ExcelPreviewIssue[];
  acceptedProgramKeys: string[];
}

interface ExpandedInterval {
  row: number;
  day: string;
  start: number;
  end: number;
  programKey: string;
}

const DEFAULT_TIMEZONE = 'Europe/Istanbul';
const GAP_PATTERN = 'main, seasonal, general, general, general';
const DAY_ORDER = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const DAY_LABELS: Record<string, string> = {
  sat: 'السبت',
  sun: 'الأحد',
  mon: 'الاثنين',
  tue: 'الثلاثاء',
  wed: 'الأربعاء',
  thu: 'الخميس',
  fri: 'الجمعة',
};
const DAY_ALIASES = new Map<string, string>([
  ['sat', 'sat'], ['saturday', 'sat'], ['السبت', 'sat'],
  ['sun', 'sun'], ['sunday', 'sun'], ['الأحد', 'sun'], ['الاحد', 'sun'],
  ['mon', 'mon'], ['monday', 'mon'], ['الإثنين', 'mon'], ['الاثنين', 'mon'], ['اتنين', 'mon'],
  ['tue', 'tue'], ['tuesday', 'tue'], ['الثلاثاء', 'tue'],
  ['wed', 'wed'], ['wednesday', 'wed'], ['الأربعاء', 'wed'], ['الاربعاء', 'wed'],
  ['thu', 'thu'], ['thursday', 'thu'], ['الخميس', 'thu'],
  ['fri', 'fri'], ['friday', 'fri'], ['الجمعة', 'fri'],
]);

export function previewExcelImport(
  input: ExcelPreviewInput,
  options: ExcelPreviewOptions = {}
): ExcelImportPreviewResult {
  const issues: ExcelPreviewIssue[] = [];
  const settings = validateSettings(input.settings ?? [], issues, options.appTimezone ?? DEFAULT_TIMEZONE);
  const programs = validatePrograms(input.programs, issues);
  const validProgramKeys = new Set(programs
    .filter(program => program.program_key && !program.issues.some(issue => issue.severity === 'error'))
    .map(program => program.program_key));
  const slots = validateSlots(input.slots, validProgramKeys, issues);

  syncRowIssueLists(programs, slots, settings, issues);
  detectOverlapsAndGaps(slots, issues);
  syncRowIssueLists(programs, slots, settings, issues);

  const folderMatches = buildFolderMatches(programs, options.folderCandidates ?? [], issues);
  syncRowIssueLists(programs, slots, settings, issues);

  const schedulePreview = buildSchedulePreview(
    slots.filter(slot => !slot.issues.some(issue => issue.severity === 'error')),
    programs,
    settings,
    options.maxPreviewDays ?? 31
  );

  const errors = issues.filter(issue => issue.severity === 'error').length;
  const warnings = issues.filter(issue => issue.severity === 'warning').length;
  const conflicts = issues.filter(issue => issue.code === 'OVERLAPPING_SLOTS').length;
  const crossingMidnight = issues.filter(issue => issue.code === 'CROSSING_MIDNIGHT').length;
  const matchedPrograms = folderMatches.filter(match => match.status === 'matched').length;
  const needsReviewPrograms = folderMatches.filter(match => match.status === 'needs_review').length;
  const missingFolders = folderMatches.filter(match => match.status === 'folder_missing').length;
  const rejectedFolders = folderMatches.filter(match => match.status === 'rejected' || match.status === 'error').length;

  return {
    mode: 'preview',
    willActivateSchedule: false,
    willUpdateCursors: false,
    willMaterializePlaylist: false,
    productionSafety: {
      previewOnly: true,
      cursorUpdates: false,
      playlistMaterialization: false,
      ffmpeg: false,
      scheduleActivation: false,
    },
    settings,
    programs,
    slots,
    folderMatches,
    schedulePreview,
    summary: {
      settingsRows: input.settings?.length ?? 0,
      programRows: input.programs.length,
      slotRows: input.slots.length,
      programCount: programs.length,
      matchedPrograms,
      needsReviewPrograms,
      missingFolders,
      rejectedFolders,
      slotCount: slots.length,
      conflicts,
      warnings,
      errors,
      crossingMidnight,
      fileStatus: getFileStatus(errors, warnings, needsReviewPrograms, missingFolders, rejectedFolders),
    },
    issues,
    acceptedProgramKeys: Array.from(validProgramKeys),
  };
}

export function previewExcelImportFromXlsx(
  buffer: Buffer,
  options: ExcelPreviewOptions = {}
): ExcelImportPreviewResult {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return previewExcelImport({
    settings: readSheet(workbook, 'Settings'),
    programs: readSheet(workbook, 'Programs'),
    slots: readSheet(workbook, 'Slots'),
    overrides: readSheet(workbook, 'Overrides'),
  }, options);
}

export function previewProgramsCsvAndSlotsCsv(programsCsv: string, slotsCsv: string): ExcelImportPreviewResult {
  return previewExcelImport({
    programs: parseCsv(programsCsv),
    slots: parseCsv(slotsCsv),
  });
}

export function parseTimeToMinutes(value: unknown): number | null {
  const text = asString(value);
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (!match) return null;
  const hoursText = match[1];
  const minutesText = match[2];
  if (hoursText === undefined || minutesText === undefined) return null;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function parseDays(value: unknown): { days: string[]; invalidTokens: string[] } {
  const text = asString(value).toLocaleLowerCase('ar');
  if (!text) return { days: [], invalidTokens: [] };
  if (['all', 'daily', 'everyday', 'كل يوم', 'يومي'].includes(text)) {
    return { days: [...DAY_ORDER], invalidTokens: [] };
  }

  const tokens = text.split(/[;,|،\s]+/).map(token => token.trim()).filter(Boolean);
  const days: string[] = [];
  const invalidTokens: string[] = [];
  for (const token of tokens) {
    const day = DAY_ALIASES.get(token);
    if (!day) {
      invalidTokens.push(token);
      continue;
    }
    if (!days.includes(day)) days.push(day);
  }
  return { days, invalidTokens };
}

function validateSettings(
  rows: Record<string, unknown>[],
  issues: ExcelPreviewIssue[],
  appTimezone: string
): SettingsPreview {
  const row = rows[0];
  const rowNumber = row ? 2 : undefined;
  const timezone = asString(row?.['timezone']) || appTimezone;
  const startDate = asString(row?.['schedule_start_date']);
  const endDate = asString(row?.['schedule_end_date']);
  const preview: SettingsPreview = {
    row: rowNumber ?? null,
    status: 'ok',
    timezone,
    timezoneSource: asString(row?.['timezone']) ? 'sheet' : 'default',
    schedule_start_date: startDate,
    schedule_end_date: endDate,
    default_duration_policy: asString(row?.['default_duration_policy']) || 'fit',
    default_repeat_policy: asString(row?.['default_repeat_policy']) || 'same_day_same_episode',
    default_gap_policy: asString(row?.['default_gap_policy']) || 'professional_gap_filler',
    rangeDays: null,
    issues: [],
  };

  if (!row) {
    addIssue(issues, 'warning', 'SETTINGS_SHEET_MISSING', 'Settings', undefined, undefined, 'لم يتم العثور على Sheet Settings. سيتم استخدام إعدادات افتراضية للمعاينة.');
    return preview;
  }
  if (!asString(row['timezone'])) {
    addIssue(issues, 'warning', 'TIMEZONE_DEFAULTED', 'Settings', rowNumber, 'timezone', `لم يتم تحديد timezone. سيتم استخدام ${appTimezone} للمعاينة.`);
  }

  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start) {
    addIssue(issues, 'error', 'INVALID_SCHEDULE_START_DATE', 'Settings', rowNumber, 'schedule_start_date', 'تاريخ بداية الجدول يجب أن يكون بصيغة YYYY-MM-DD.');
  }
  if (!end) {
    addIssue(issues, 'error', 'INVALID_SCHEDULE_END_DATE', 'Settings', rowNumber, 'schedule_end_date', 'تاريخ نهاية الجدول يجب أن يكون بصيغة YYYY-MM-DD.');
  }
  if (start && end) {
    const rangeDays = daysBetween(start, end) + 1;
    preview.rangeDays = rangeDays;
    if (end.getTime() < start.getTime()) {
      addIssue(issues, 'error', 'SCHEDULE_END_BEFORE_START', 'Settings', rowNumber, 'schedule_end_date', 'تاريخ نهاية الجدول يجب أن يكون بعد تاريخ البداية.');
    } else if (rangeDays > 31) {
      addIssue(issues, 'warning', 'SCHEDULE_RANGE_LONG', 'Settings', rowNumber, 'schedule_end_date', 'مدة الجدول أطول من 31 يومًا. سيتم عرض معاينة أولية فقط.');
    }
  }

  return preview;
}

function validatePrograms(rows: Record<string, unknown>[], issues: ExcelPreviewIssue[]): ProgramPreviewRow[] {
  const rootKeys = new Set(DEFAULT_MEDIA_ROOTS.map(root => root.root_key));
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = asString(row['program_key']);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const programKey = asString(row['program_key']);
    const programName = asString(row['program_name']);
    const folderHint = asString(row['folder_hint']);
    const folderRoot = asString(row['folder_root']) || 'original-ar';
    const playMode = asString(row['play_mode']) || 'sequential';
    const slotMode = asString(row['slot_mode']) || 'fit';
    const fileCountText = asString(row['file_count']);
    const repeatPolicy = asString(row['repeat_policy']) || 'same_day_same_episode';
    const enabledText = asString(row['enabled']);
    const enabled = enabledText ? parseEnabled(enabledText) : true;
    const hideLogoText = asString(row['hide_logo'] ?? row['hide_logo_during_program']);
    const hideLogo = hideLogoText ? parseEnabled(hideLogoText) : false;
    let normalizedFolderHint: string | null = null;

    if (!programKey) {
      addIssue(issues, 'error', 'MISSING_PROGRAM_KEY', 'Programs', rowNumber, 'program_key', 'مفتاح البرنامج program_key مطلوب.');
    } else if ((counts.get(programKey) ?? 0) > 1) {
      addIssue(issues, 'error', 'DUPLICATE_PROGRAM_KEY', 'Programs', rowNumber, 'program_key', `مفتاح البرنامج "${programKey}" مكرر. يجب أن يكون فريدًا.`);
    }
    if (!programName) {
      addIssue(issues, 'error', 'MISSING_PROGRAM_NAME', 'Programs', rowNumber, 'program_name', 'اسم البرنامج مطلوب.');
    }
    if (!folderHint) {
      addIssue(issues, 'error', 'MISSING_FOLDER_HINT', 'Programs', rowNumber, 'folder_hint', 'folder_hint مطلوب ويجب أن يكون مسارًا نسبيًا داخل root مسموح.');
    } else {
      try {
        normalizedFolderHint = normalizeRootRelativePath(folderHint);
      } catch (err) {
        const code = err instanceof SafeRootError ? err.code : 'INVALID_FOLDER_HINT';
        addIssue(issues, 'error', code, 'Programs', rowNumber, 'folder_hint', 'لا تستخدم مسارًا كاملًا من Excel. استخدم folder_root مع folder_hint نسبي فقط.');
      }
    }
    if (!rootKeys.has(folderRoot)) {
      addIssue(issues, 'error', 'UNSUPPORTED_FOLDER_ROOT', 'Programs', rowNumber, 'folder_root', `folder_root غير مدعوم. القيم المسموحة: ${Array.from(rootKeys).join(', ')}`);
    }
    if (!isSupported(playMode, SUPPORTED_PLAY_MODES)) {
      addIssue(issues, 'error', 'UNSUPPORTED_PLAY_MODE', 'Programs', rowNumber, 'play_mode', `وضع التشغيل غير مدعوم. القيم المسموحة: ${SUPPORTED_PLAY_MODES.join(', ')}`);
    }
    if (!isSupported(slotMode, SUPPORTED_SLOT_MODES)) {
      addIssue(issues, 'error', 'UNSUPPORTED_SLOT_MODE', 'Programs', rowNumber, 'slot_mode', `نوع الفترة غير مدعوم. القيم المسموحة: ${SUPPORTED_SLOT_MODES.join(', ')}`);
    }
    if (slotMode === 'file_count' && parsePositiveInteger(fileCountText) === null) {
      addIssue(issues, 'error', 'MISSING_FILE_COUNT', 'Programs', rowNumber, 'file_count', 'file_count مطلوب عندما يكون slot_mode=file_count.');
    }
    if (repeatPolicy && !isSupported(repeatPolicy, SUPPORTED_REPEAT_POLICIES)) {
      addIssue(issues, 'error', 'INVALID_REPEAT_POLICY', 'Programs', rowNumber, 'repeat_policy', `repeat_policy غير صحيح. القيم المسموحة: ${SUPPORTED_REPEAT_POLICIES.join(', ')}`);
    }
    if (enabledText && enabled === null) {
      addIssue(issues, 'error', 'INVALID_ENABLED_VALUE', 'Programs', rowNumber, 'enabled', 'قيمة enabled يجب أن تكون true أو false.');
    }
    if (hideLogoText && hideLogo === null) {
      addIssue(issues, 'error', 'INVALID_HIDE_LOGO_VALUE', 'Programs', rowNumber, 'hide_logo', 'قيمة hide_logo يجب أن تكون true أو false.');
    }

    return {
      row: rowNumber,
      status: 'ok',
      program_key: programKey,
      program_name: programName,
      hide_logo: hideLogo === true,
      folder_hint: folderHint,
      normalized_folder_hint: normalizedFolderHint,
      folder_root: folderRoot,
      play_mode: playMode,
      slot_mode: slotMode,
      file_count: parsePositiveInteger(fileCountText),
      repeat_policy: repeatPolicy,
      enabled,
      notes: asString(row['notes']),
      issues: [],
    };
  });
}

function validateSlots(
  rows: Record<string, unknown>[],
  programKeys: Set<string>,
  issues: ExcelPreviewIssue[]
): SlotPreviewRow[] {
  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const programKey = asString(row['program_key']);
    const parsedDays = parseDays(row['days']);
    const startText = asString(row['start_time']);
    const endText = asString(row['end_time']);
    const durationText = asString(row['duration_minutes']);
    const startMinutes = parseTimeToMinutes(startText);
    const endMinutes = endText ? parseTimeToMinutes(endText) : null;
    const durationMinutes = parsePositiveInteger(durationText);
    const computedEnd = computeEndMinutes(startMinutes, endMinutes, durationMinutes);
    const crossesMidnight = computedEnd !== null && startMinutes !== null && computedEnd > 24 * 60;

    if (!programKey || !programKeys.has(programKey)) {
      addIssue(issues, 'error', 'PROGRAM_KEY_NOT_FOUND', 'Slots', rowNumber, 'program_key', `program_key "${programKey}" غير موجود في Sheet Programs.`);
    }
    if (parsedDays.days.length === 0 || parsedDays.invalidTokens.length > 0) {
      addIssue(issues, 'error', 'INVALID_DAYS', 'Slots', rowNumber, 'days', `أيام العرض غير صحيحة: ${parsedDays.invalidTokens.join(', ') || 'فارغة'}. استخدم sat, sun, mon, tue, wed, thu, fri أو أسماء الأيام بالعربية.`);
    }
    if (startMinutes === null) {
      addIssue(issues, 'error', 'INVALID_START_TIME', 'Slots', rowNumber, 'start_time', 'وقت البداية يجب أن يكون بصيغة HH:MM.');
    }
    if (endText && endMinutes === null) {
      addIssue(issues, 'error', 'INVALID_END_TIME', 'Slots', rowNumber, 'end_time', 'وقت النهاية يجب أن يكون بصيغة HH:MM.');
    }
    if (!endText && durationMinutes === null) {
      addIssue(issues, 'error', 'MISSING_DURATION', 'Slots', rowNumber, 'duration_minutes', 'duration_minutes مطلوب إذا لم يتم تحديد end_time.');
    }
    if (durationText && durationMinutes === null) {
      addIssue(issues, 'error', 'INVALID_DURATION_MINUTES', 'Slots', rowNumber, 'duration_minutes', 'duration_minutes يجب أن يكون رقمًا صحيحًا أكبر من صفر.');
    }
    if (crossesMidnight) {
      addIssue(issues, 'warning', 'CROSSING_MIDNIGHT', 'Slots', rowNumber, 'end_time', `الفترة "${programKey}" تعبر منتصف الليل ويجب مراجعتها بوضوح.`);
    }

    return {
      row: rowNumber,
      status: 'ok',
      program_key: programKey,
      days: parsedDays.days,
      raw_days: asString(row['days']),
      start_time: startText,
      end_time: endText,
      duration_minutes: durationMinutes,
      effective_from: asString(row['effective_from']),
      effective_to: asString(row['effective_to']),
      priority: parsePositiveInteger(asString(row['priority'])),
      notes: asString(row['notes']),
      start_minutes: startMinutes,
      end_minutes: endMinutes,
      computed_end_minutes: computedEnd,
      crosses_midnight: crossesMidnight,
      issues: [],
    };
  });
}

function detectOverlapsAndGaps(slots: SlotPreviewRow[], issues: ExcelPreviewIssue[]): void {
  const intervalsByDay = new Map<string, ExpandedInterval[]>();
  for (const slot of slots) {
    if (slot.start_minutes === null || slot.computed_end_minutes === null || slot.issues.some(issue => issue.severity === 'error')) continue;
    for (const interval of expandSlot(slot)) {
      if (!intervalsByDay.has(interval.day)) intervalsByDay.set(interval.day, []);
      intervalsByDay.get(interval.day)!.push(interval);
    }
  }

  for (const [day, intervals] of intervalsByDay) {
    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 0; index < intervals.length - 1; index++) {
      const current = intervals[index]!;
      const next = intervals[index + 1]!;
      if (current.end > next.start) {
        if (current.start < next.start) {
          addIssue(
            issues,
            'warning',
            'SLOT_TRIMMED_TO_NEXT_HARD_START',
            'Slots',
            current.row,
            'duration_minutes',
            `سيتم قص نهاية صف ${current.row} يوم ${DAY_LABELS[day] ?? day} عند ${formatMinutes(next.start)} للحفاظ على بداية صف ${next.row} في موعدها.`
          );
          continue;
        }
        addIssue(
          issues,
          'error',
          'OVERLAPPING_SLOTS',
          'Slots',
          next.row,
          'start_time',
          `يوجد تداخل في المواعيد يوم ${DAY_LABELS[day] ?? day} بين ${formatMinutes(next.start)} و${formatMinutes(Math.min(current.end, next.end))}.`
        );
      } else if (next.start - current.end > 0) {
        addIssue(
          issues,
          'warning',
          'GAP_DETECTED',
          'Slots',
          next.row,
          'start_time',
          `يوجد فراغ ${next.start - current.end} دقيقة يوم ${DAY_LABELS[day] ?? day} قبل صف ${next.row}. سيتم التعامل معه لاحقًا بنمط Professional Gap Preview.`
        );
      }
    }
  }
}

function buildFolderMatches(
  programs: ProgramPreviewRow[],
  candidates: FolderMatchCandidate[],
  issues: ExcelPreviewIssue[]
): FolderMatchPreview[] {
  return programs.map(program => {
    const rowHasPathError = program.issues.some(issue =>
      ['ABSOLUTE_PATH_REJECTED', 'PATH_TRAVERSAL_REJECTED', 'INVALID_PATH', 'UNSUPPORTED_FOLDER_ROOT', 'MISSING_FOLDER_HINT'].includes(issue.code)
    );
    if (rowHasPathError) {
      return folderMatch(program, 'rejected', 0, [], 'تم رفض مسار المجلد. استخدم folder_root ومجلدًا نسبيًا فقط.');
    }

    const hint = program.normalized_folder_hint;
    if (!hint) {
      return folderMatch(program, 'error', 0, [], 'لا يمكن مطابقة المجلد بدون folder_hint صالح.');
    }

    const scored = candidates
      .filter(candidate => candidate.root_key === program.folder_root)
      .map(candidate => ({
        candidate,
        score: scoreFolderCandidate(hint, candidate),
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.candidate.original_relative_path.localeCompare(b.candidate.original_relative_path));

    const exact = scored.filter(item => item.score === 100);
    if (exact.length === 1) {
      if ((exact[0]!.candidate.file_count ?? 0) <= 0) {
        addIssue(issues, 'error', 'MATCHED_FOLDER_HAS_NO_READY_FILES', 'Programs', program.row, 'folder_hint', 'تم العثور على المجلد المطابق لكنه لا يحتوي على ملفات جاهزة للتشغيل.');
        return folderMatch(program, 'error', 100, [toSuggestion(exact[0]!, 'تطابق مباشر مع folder_hint')], 'تم العثور على المجلد المطابق لكنه لا يحتوي على ملفات جاهزة للتشغيل.');
      }
      return folderMatch(program, 'matched', 100, [toSuggestion(exact[0]!, 'تطابق مباشر مع folder_hint')], 'تم العثور على مجلد مطابق.');
    }
    if (exact.length > 1) {
      addIssue(issues, 'error', 'MULTIPLE_FOLDER_MATCHES', 'Programs', program.row, 'folder_hint', 'تم العثور على أكثر من مجلد مطابق ويحتاج البرنامج إلى مراجعة.');
      return folderMatch(program, 'needs_review', 75, exact.slice(0, 5).map(item => toSuggestion(item, 'أكثر من تطابق مباشر')), 'يوجد أكثر من مجلد مطابق. اختر المجلد الصحيح لاحقًا.');
    }

    const suggestions = scored.filter(item => item.score >= 50).slice(0, 5);
    if (suggestions.length > 1) {
      addIssue(issues, 'error', 'MULTIPLE_FOLDER_MATCHES', 'Programs', program.row, 'folder_hint', 'تم العثور على أكثر من اقتراح قريب ويحتاج البرنامج إلى مراجعة.');
      return folderMatch(program, 'needs_review', Math.min(79, suggestions[0]?.score ?? 50), suggestions.map(item => toSuggestion(item, 'اقتراح قريب')), 'يوجد أكثر من اقتراح قريب لهذا المجلد.');
    }
    if (suggestions.length === 1) {
      const confidence = suggestions[0]!.score;
      addIssue(issues, 'error', 'FUZZY_FOLDER_MATCH', 'Programs', program.row, 'folder_hint', 'تم العثور على اقتراح قريب للمجلد ويحتاج إلى مراجعة قبل التفعيل.');
      return folderMatch(program, 'needs_review', confidence, suggestions.map(item => toSuggestion(item, 'اقتراح قريب')), 'تم العثور على اقتراح قريب، لكنه ليس تطابقًا نهائيًا.');
    }

    addIssue(issues, 'error', 'FOLDER_MISSING', 'Programs', program.row, 'folder_hint', 'لم يتم العثور على مجلد مطابق لهذا البرنامج. يجب ربطه بمجلد ميديا قبل الاعتماد.');
    return folderMatch(program, 'folder_missing', 0, [], 'لم يتم العثور على مجلد مطابق لهذا البرنامج. يجب ربطه بمجلد ميديا قبل الاعتماد.');
  });
}

function buildSchedulePreview(
  slots: SlotPreviewRow[],
  programs: ProgramPreviewRow[],
  settings: SettingsPreview,
  maxPreviewDays: number
): ExcelImportPreviewResult['schedulePreview'] {
  const start = parseIsoDate(settings.schedule_start_date);
  const end = parseIsoDate(settings.schedule_end_date);
  if (!start || !end || end.getTime() < start.getTime()) {
    return { timezone: settings.timezone, gapPattern: GAP_PATTERN, truncated: false, days: [] };
  }

  const programNames = new Map(programs.map(program => [program.program_key, program.program_name]));
  const totalDays = daysBetween(start, end) + 1;
  const daysToRender = Math.min(totalDays, Math.max(1, maxPreviewDays));
  const days: SchedulePreviewDay[] = [];

  for (let offset = 0; offset < daysToRender; offset++) {
    const date = addDays(start, offset);
    const dateText = formatDate(date);
    const dayKey = dayKeyForDate(date);
    const previousDayKey = previousDay(dayKey);
    const rows: SchedulePreviewRow[] = [];

    for (const slot of slots) {
      if (slot.start_minutes === null || slot.computed_end_minutes === null) continue;
      if (slot.days.includes(dayKey)) {
        rows.push(slotToPreviewRow(slot, programNames, slot.start_minutes, Math.min(slot.computed_end_minutes, 24 * 60)));
      }
      if (slot.crosses_midnight && slot.days.includes(previousDayKey) && slot.computed_end_minutes > 24 * 60) {
        rows.push(slotToPreviewRow(slot, programNames, 0, slot.computed_end_minutes - 24 * 60));
      }
    }

    rows.sort((a, b) => parseTimeToMinutes(a.start_time)! - parseTimeToMinutes(b.start_time)!);
    days.push({
      date: dateText,
      day: dayKey,
      rows: insertGapRows(applyHardStartCaps(rows)),
    });
  }

  return {
    timezone: settings.timezone,
    gapPattern: GAP_PATTERN,
    truncated: totalDays > daysToRender,
    days,
  };
}

function applyHardStartCaps(rows: SchedulePreviewRow[]): SchedulePreviewRow[] {
  return rows.map((row, index) => {
    const start = parseTimeToMinutes(row.start_time);
    const end = parsePreviewMinutes(row.end_time);
    if (start === null || end === null) return row;

    const nextStart = rows
      .slice(index + 1)
      .map(nextRow => parseTimeToMinutes(nextRow.start_time))
      .find((value): value is number => value !== null && value > start);

    if (nextStart === undefined || end <= nextStart) return row;

    return {
      ...row,
      end_time: formatMinutes(nextStart),
      duration_minutes: Math.max(0, nextStart - start),
    };
  });
}

function syncRowIssueLists(
  programs: ProgramPreviewRow[],
  slots: SlotPreviewRow[],
  settings: SettingsPreview,
  issues: ExcelPreviewIssue[]
): void {
  settings.issues = issues.filter(issue => issue.sheet === 'Settings');
  settings.status = statusForIssues(settings.issues);
  for (const program of programs) {
    program.issues = issues.filter(issue => issue.sheet === 'Programs' && issue.row === program.row);
    program.status = statusForIssues(program.issues);
  }
  for (const slot of slots) {
    slot.issues = issues.filter(issue => issue.sheet === 'Slots' && issue.row === slot.row);
    slot.status = statusForIssues(slot.issues);
  }
}

function expandSlot(slot: SlotPreviewRow): ExpandedInterval[] {
  if (slot.start_minutes === null || slot.computed_end_minutes === null) return [];
  const intervals: ExpandedInterval[] = [];
  for (const day of slot.days) {
    const end = slot.computed_end_minutes;
    intervals.push({
      row: slot.row,
      day,
      start: slot.start_minutes,
      end: Math.min(end, 24 * 60),
      programKey: slot.program_key,
    });
    if (end > 24 * 60) {
      intervals.push({
        row: slot.row,
        day: nextDay(day),
        start: 0,
        end: end - 24 * 60,
        programKey: slot.program_key,
      });
    }
  }
  return intervals;
}

function scoreFolderCandidate(hint: string, candidate: FolderMatchCandidate): number {
  const normalizedHint = normalizeArabicForMatch(hint);
  const normalizedCandidatePath = normalizeArabicForMatch(candidate.original_relative_path);
  const normalizedCandidateName = normalizeArabicForMatch(candidate.display_name_ar);
  const normalizedCandidateSlug = normalizeArabicForMatch(candidate.safe_slug);

  if (hint === candidate.original_relative_path) return 100;
  if (normalizedHint === normalizedCandidatePath || normalizedHint === normalizedCandidateName || normalizedHint === normalizedCandidateSlug) return 100;
  if (normalizedCandidatePath.endsWith(normalizedHint)) return 92;
  if (normalizedCandidatePath.includes(normalizedHint) || normalizedHint.includes(normalizedCandidatePath)) return 88;
  if (normalizedCandidateName.includes(normalizedHint) || normalizedHint.includes(normalizedCandidateName)) return 84;

  const score = tokenOverlapScore(normalizedHint, `${normalizedCandidatePath} ${normalizedCandidateName}`);
  return score >= 0.5 ? Math.round(score * 100) : 0;
}

function tokenOverlapScore(a: string, b: string): number {
  const aTokens = new Set(a.split(/\s+/).filter(Boolean));
  const bTokens = new Set(b.split(/\s+/).filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }
  return overlap / aTokens.size;
}

function folderMatch(
  program: ProgramPreviewRow,
  status: FolderMatchStatus,
  confidence: number,
  suggestions: FolderMatchSuggestion[],
  message: string
): FolderMatchPreview {
  const firstSuggestion = suggestions[0];
  return {
    row: program.row,
    program_key: program.program_key,
    folder_root: program.folder_root,
    folder_hint: program.folder_hint,
    status,
    status_ar: folderStatusAr(status),
    confidence,
    matched_folder_id: status === 'matched' ? firstSuggestion?.folder_id ?? null : null,
    matched_relative_path: status === 'matched' ? firstSuggestion?.original_relative_path ?? null : null,
    suggestions,
    message,
  };
}

function toSuggestion(
  item: { candidate: FolderMatchCandidate; score: number },
  reason: string
): FolderMatchSuggestion {
  return {
    folder_id: item.candidate.folder_id,
    root_key: item.candidate.root_key,
    original_relative_path: item.candidate.original_relative_path,
    display_name_ar: item.candidate.display_name_ar,
    confidence: item.score,
    reason,
  };
}

function folderStatusAr(status: FolderMatchStatus): string {
  switch (status) {
    case 'matched': return 'مطابق';
    case 'needs_review': return 'يحتاج مراجعة';
    case 'folder_missing': return 'غير موجود';
    case 'rejected': return 'مرفوض';
    case 'error': return 'خطأ';
  }
}

function slotToPreviewRow(
  slot: SlotPreviewRow,
  programNames: Map<string, string>,
  start: number,
  end: number
): SchedulePreviewRow {
  return {
    type: 'slot',
    row: slot.row,
    program_key: slot.program_key,
    title: programNames.get(slot.program_key) || slot.program_key,
    start_time: formatMinutes(start),
    end_time: formatMinutes(end),
    duration_minutes: Math.max(0, end - start),
  };
}

function insertGapRows(rows: SchedulePreviewRow[]): SchedulePreviewRow[] {
  const output: SchedulePreviewRow[] = [];
  let cursor = 0;
  for (const row of rows) {
    const start = parseTimeToMinutes(row.start_time) ?? cursor;
    const end = parseTimeToMinutes(row.end_time) ?? start;
    const previewEnd = parsePreviewMinutes(row.end_time) ?? end;
    if (start > cursor) {
      output.push({
        type: 'gap',
        row: null,
        program_key: null,
        title: 'Professional Gap Preview',
        start_time: formatMinutes(cursor),
        end_time: formatMinutes(start),
        duration_minutes: start - cursor,
      });
    }
    output.push(row);
    cursor = Math.max(cursor, previewEnd);
  }
  if (cursor < 24 * 60) {
    output.push({
      type: 'gap',
      row: null,
      program_key: null,
      title: 'Professional Gap Preview',
      start_time: formatMinutes(cursor),
      end_time: '24:00',
      duration_minutes: 24 * 60 - cursor,
    });
  }
  return output;
}

function readSheet(workbook: XLSX.WorkBook, name: string): Record<string, unknown>[] {
  const sheet = workbook.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: false, defval: '' });
}

function parseCsv(content: string): Record<string, unknown>[] {
  return csvParse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, unknown>[];
}

function computeEndMinutes(start: number | null, end: number | null, duration: number | null): number | null {
  if (start === null) return null;
  if (end !== null) return end <= start ? end + 24 * 60 : end;
  if (duration !== null) return start + duration;
  return null;
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parsePositiveInteger(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseEnabled(value: string): boolean | null {
  const normalized = value.toLocaleLowerCase('ar');
  if (['true', '1', 'yes', 'y', 'enabled', 'on', 'نعم'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'disabled', 'off', 'لا'].includes(normalized)) return false;
  return null;
}

function isSupported<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}

function addIssue(
  issues: ExcelPreviewIssue[],
  severity: ExcelPreviewSeverity,
  code: string,
  sheet: ExcelPreviewIssue['sheet'],
  row: number | undefined,
  field: string | undefined,
  message: string
): void {
  issues.push({ severity, code, sheet, row, field, message });
}

function statusForIssues(issues: ExcelPreviewIssue[]): PreviewRowStatus {
  if (issues.some(issue => issue.severity === 'error')) return 'error';
  if (issues.some(issue => issue.severity === 'warning')) return 'warning';
  return 'ok';
}

function getFileStatus(
  errors: number,
  warnings: number,
  needsReview: number,
  missingFolders: number,
  rejectedFolders: number
): ExcelImportPreviewResult['summary']['fileStatus'] {
  if (errors > 0 || rejectedFolders > 0) return 'يحتوي على أخطاء';
  if (needsReview > 0 || missingFolders > 0 || warnings > 0) return 'يحتاج مراجعة';
  return 'صالح للمعاينة';
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || formatDate(date) !== value ? null : date;
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayKeyForDate(date: Date): string {
  const jsDay = date.getUTCDay();
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][jsDay] ?? 'sun';
}

function nextDay(day: string): string {
  const index = DAY_ORDER.indexOf(day);
  return DAY_ORDER[(index + 1) % DAY_ORDER.length] ?? DAY_ORDER[0]!;
}

function previousDay(day: string): string {
  const index = DAY_ORDER.indexOf(day);
  return DAY_ORDER[(index - 1 + DAY_ORDER.length) % DAY_ORDER.length] ?? DAY_ORDER[0]!;
}

function formatMinutes(minutes: number): string {
  if (minutes >= 24 * 60) return '24:00';
  const clamped = Math.max(0, minutes);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parsePreviewMinutes(value: string): number | null {
  if (value === '24:00') return 24 * 60;
  return parseTimeToMinutes(value);
}
