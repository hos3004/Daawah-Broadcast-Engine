import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  Eye,
  FolderSearch,
  ListChecks,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { broadcastApi, mediaApi, schedulerFoundationApi } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';

interface ExcelIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  sheet: string;
  row?: number;
  field?: string;
  message: string;
}

interface SettingsPreview {
  status: 'ok' | 'warning' | 'error';
  timezone: string;
  timezoneSource: 'sheet' | 'default';
  schedule_start_date: string;
  schedule_end_date: string;
  default_duration_policy: string;
  default_repeat_policy: string;
  default_gap_policy: string;
  rangeDays: number | null;
  issues: ExcelIssue[];
}

interface ProgramRow {
  row: number;
  status: 'ok' | 'warning' | 'error';
  program_key: string;
  program_name: string;
  hide_logo: boolean;
  folder_root: string;
  folder_hint: string;
  play_mode: string;
  slot_mode: string;
  file_count: number | null;
  repeat_policy: string;
  enabled: boolean | null;
  notes: string;
  issues: ExcelIssue[];
}

interface SlotRow {
  row: number;
  status: 'ok' | 'warning' | 'error';
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
  crosses_midnight: boolean;
  issues: ExcelIssue[];
}

interface FolderMatch {
  row: number;
  program_key: string;
  folder_root: string;
  folder_hint: string;
  status: 'matched' | 'needs_review' | 'folder_missing' | 'rejected' | 'error';
  status_ar: string;
  confidence: number;
  matched_folder_id?: string | null;
  matched_relative_path: string | null;
  suggestions: Array<{
    folder_id: string;
    root_key: string;
    original_relative_path: string;
    display_name_ar: string;
    confidence: number;
    reason: string;
  }>;
  message: string;
}

interface SchedulePreviewDay {
  date: string;
  day: string;
  rows: Array<{
    type: 'slot' | 'gap';
    row: number | null;
    program_key: string | null;
    title: string;
    start_time: string;
    end_time: string;
    duration_minutes: number;
  }>;
}

interface ExcelPreview {
  mode: 'preview';
  settings: SettingsPreview;
  programs: ProgramRow[];
  slots: SlotRow[];
  folderMatches: FolderMatch[];
  schedulePreview: {
    timezone: string;
    gapPattern: string;
    truncated: boolean;
    days: SchedulePreviewDay[];
  };
  summary: {
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
    fileStatus: string;
  };
  issues: ExcelIssue[];
  productionSafety: {
    previewOnly: true;
    cursorUpdates: false;
    playlistMaterialization: false;
    ffmpeg: false;
    scheduleActivation: false;
  };
  willActivateSchedule: false;
  willUpdateCursors: false;
  willMaterializePlaylist: false;
}

interface ProgramFolderOption {
  id: string;
  root_key: string;
  root_path?: string;
  original_relative_path: string;
  display_name_ar: string;
  safe_slug: string;
  active_file_count: number;
  active_total_duration_ms: number | null;
  active_longest_file_duration_ms: number | null;
  file_count: number;
  total_duration_ms: number | null;
  longest_file_duration_ms: number | null;
  status: string;
}

type WizardSlotMode = 'fit' | 'playlist' | 'file-count' | 'kids-round-robin';
type WizardPlayMode = 'sequential' | 'shuffle' | 'newest' | 'round_robin';
type WizardCycleRepeatCount = 1 | 2 | 3 | 4;

interface WizardProgramDraft {
  localId: string;
  name: string;
  folderId: string;
  folderRoot: string;
  folderHint: string;
  matchStatus: 'matched' | 'manual' | 'needs_review';
  matchConfidence: number;
  fileCount: number | null;
  longestDurationMs: number | null;
  slotMode: WizardSlotMode;
  playMode: WizardPlayMode;
  days: string[];
  startTime: string;
  repeatTime: string;
  secondRepeatTime: string;
  durationMinutes: number;
  fileCountLimit: number;
  hideLogo: boolean;
  notes: string;
}

interface KeyedWizardRow {
  row: WizardProgramDraft;
  key: string;
  rowIndex: number;
}

interface WizardPayloadSlot extends Record<string, unknown> {
  program_key: string;
  days: string;
  start_time: string;
  duration_minutes: number;
  effective_from: string;
  effective_to: string;
  priority: number;
  notes: string;
}

interface WizardAiring {
  keyedRow: KeyedWizardRow;
  time: string;
  timeIndex: number;
  cycleIndex: number;
  cycleRepeatCount: WizardCycleRepeatCount;
  day: string;
  startMinutes: number;
  durationMinutes: number;
}

interface ScanProgress {
  total: number;
  scanned: number;
  errors: number;
  currentFile: string;
  phase?: string;
}

interface WizardFolderScanTarget {
  rootId: string;
  path: string;
}

interface PreviewSource {
  filename: string;
  sha256: string;
}

interface DraftListItem {
  id: string;
  name: string;
  status: 'draft';
  isActive: false;
  validationStatus: 'draft_valid' | 'draft_invalid';
  scheduleStartDate: string;
  scheduleEndDate: string;
  timezone: string;
  sourceExcelFilename: string;
  sourceExcelSha256: string;
  programCount: number;
  slotCount: number;
  validationSummary: ExcelPreview['summary'];
  createdAt: string;
}

interface SchedulerDraftDetail extends DraftListItem {
  settings: SettingsPreview;
  programs: ProgramRow[];
  slots: SlotRow[];
  folderMatches: FolderMatch[];
  issues: ExcelIssue[];
  schedulePreview: ExcelPreview['schedulePreview'];
  productionSafety: ExcelPreview['productionSafety'];
  willActivateSchedule: false;
  willUpdateCursors: false;
  willMaterializePlaylist: false;
}

interface PublishedListItem {
  id: string;
  sourceDraftId: string;
  name: string;
  status: 'published';
  isActive: boolean;
  validationStatus: 'draft_valid';
  scheduleStartDate: string;
  scheduleEndDate: string;
  timezone: string;
  sourceExcelFilename: string;
  sourceExcelSha256: string;
  programCount: number;
  slotCount: number;
  validationSummary: ExcelPreview['summary'];
  publishedAt: string;
  publishedBy: string | null;
}

interface ActiveScheduleStatus {
  id: string;
  name: string;
  isActive: boolean;
  scheduleStartDate: string;
  scheduleEndDate: string;
  timezone: string;
  slotCount: number;
}

interface BroadcastStatus {
  status?: 'idle' | 'starting' | 'running' | 'stopping' | 'error' | 'emergency';
  lastError?: string | null;
}

interface MaterializationRun {
  id: string;
  publishedScheduleId: string;
  mode: 'dry_run';
  status: 'completed' | 'failed';
  outputPath: string;
  summary: {
    itemCount: number;
    scheduledItemCount: number;
    gapFillerItemCount: number;
    totalScheduledMinutes: number;
    totalGapMinutes: number;
    mediaExpansionAvailable: boolean;
    normalizedSetId: string | null;
    normalizedSetApplied: boolean;
    normalizedMediaCount: number;
    originalSafeFallbackCount: number;
    missingNormalizedCount: number;
    originalNotNormalizedCount: number;
    missingMediaFileCount?: number;
    testPlayoutEligible?: boolean;
    concatRiskCount: number;
    safety: {
      cursorMutation: false;
      ffmpeg: false;
      ffprobe: false;
      playout: false;
      broadcast: false;
      mediaModification: false;
    };
  };
  warnings: Array<{ code: string; message: string }>;
  errors: Array<{ code: string; message: string }>;
  createdAt: string;
}

interface CurrentScheduleItem {
  id: string;
  date: string;
  type: 'program' | 'gap_filler' | string;
  source?: string;
  sourceRole?: string;
  programKey: string | null;
  title: string;
  startTime: string;
  endTime: string;
  timelineStartSeconds?: number;
  timelineEndSeconds?: number;
  durationMinutes?: number;
  durationSeconds?: number;
  absolutePath: string | null;
  relativePath: string | null;
  validationStatus?: 'ready' | 'missing_media' | 'unknown_duration' | string;
}

interface CurrentBroadcastSchedule {
  source: 'running-broadcast' | 'active-schedule-latest' | 'none';
  activeScheduleId: string | null;
  broadcast: BroadcastStatus & {
    runId?: string | null;
    pid?: number | null;
    startedAt?: string | null;
    currentItem?: unknown;
    nextItem?: unknown;
    playlistArtifactRunId?: string | null;
    restartCount?: number;
    isEmergency?: boolean;
  };
  run: MaterializationRun | null;
  playlist: {
    runId: string;
    scheduleId: string;
    scheduleName: string;
    timezone: string;
    generatedAt: string;
    items: CurrentScheduleItem[];
    days: Array<{ date: string; itemCount: number }>;
  } | null;
  mismatch: boolean;
  message?: string;
}

const dayLabels: Record<string, string> = {
  sat: 'السبت',
  sun: 'الأحد',
  mon: 'الاثنين',
  tue: 'الثلاثاء',
  wed: 'الأربعاء',
  thu: 'الخميس',
  fri: 'الجمعة',
};

const dayKeys = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

const slotModeLabels: Record<WizardSlotMode, string> = {
  fit: 'fit',
  playlist: 'playlist',
  'file-count': 'file-count',
  'kids-round-robin': 'kids 1h round-robin',
};

const MAX_REASONABLE_WIZARD_SLOT_MINUTES = 6 * 60;
const WIZARD_FULL_DAY_MINUTES = 24 * 60;
const WIZARD_QUARTER_HOUR_MINUTES = 15;

export default function SchedulerFoundationPage() {
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null);
  const [preview, setPreview] = useState<ExcelPreview | null>(null);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [deletingDraftId, setDeletingDraftId] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftActionMessage, setDraftActionMessage] = useState('');
  const [draftActionError, setDraftActionError] = useState('');
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedSchedules, setPublishedSchedules] = useState<PublishedListItem[]>([]);
  const [activeSchedule, setActiveSchedule] = useState<ActiveScheduleStatus | null>(null);
  const [materializationRuns, setMaterializationRuns] = useState<MaterializationRun[]>([]);
  const [materializationLoading, setMaterializationLoading] = useState(false);
  const [startingPublishedScheduleId, setStartingPublishedScheduleId] = useState<string | null>(null);
  const [broadcastStatus, setBroadcastStatus] = useState<BroadcastStatus | null>(null);
  const [stoppingBroadcast, setStoppingBroadcast] = useState(false);
  const [quickBroadcastMessage, setQuickBroadcastMessage] = useState('');
  const [quickBroadcastError, setQuickBroadcastError] = useState('');
  const [currentSchedule, setCurrentSchedule] = useState<CurrentBroadcastSchedule | null>(null);
  const [currentScheduleLoading, setCurrentScheduleLoading] = useState(false);
  const [currentScheduleError, setCurrentScheduleError] = useState('');
  const [showScheduleFillers, setShowScheduleFillers] = useState(false);
  const [approvedSchedule, setApprovedSchedule] = useState<PublishedListItem | null>(null);
  const [approvingSchedule, setApprovingSchedule] = useState(false);
  const [workflowMessage, setWorkflowMessage] = useState('');
  const [workflowError, setWorkflowError] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardStartDate, setWizardStartDate] = useState(() => todayDateInputValue());
  const [wizardEndDate, setWizardEndDate] = useState(() => todayDateInputValue());
  const [wizardCycleRepeatCount, setWizardCycleRepeatCount] = useState<WizardCycleRepeatCount>(1);
  const [wizardProgramText, setWizardProgramText] = useState('');
  const [wizardRows, setWizardRows] = useState<WizardProgramDraft[]>([]);
  const [wizardEditingDraftId, setWizardEditingDraftId] = useState<string | null>(null);
  const [wizardFolders, setWizardFolders] = useState<ProgramFolderOption[]>([]);
  const [wizardLoadingFolders, setWizardLoadingFolders] = useState(false);
  const [wizardBuilding, setWizardBuilding] = useState(false);
  const [wizardError, setWizardError] = useState('');
  const [wizardScanningFolders, setWizardScanningFolders] = useState(false);
  const [wizardScanProgress, setWizardScanProgress] = useState<ScanProgress | null>(null);
  const wizardScanningFoldersRef = useRef(false);

  const approvalBlockers = useMemo(() => preview ? scheduleApprovalBlockers(preview) : [], [preview]);
  const canApproveSchedule = Boolean(previewSource && preview && approvalBlockers.length === 0 && !approvedSchedule);
  const publishedDraftIds = useMemo(() => new Set(publishedSchedules.map(schedule => schedule.sourceDraftId)), [publishedSchedules]);
  const preparedDrafts = useMemo(() => drafts.filter(draft => !publishedDraftIds.has(draft.id)), [drafts, publishedDraftIds]);
  const currentScheduleItems = useMemo(() => {
    const items = currentSchedule?.playlist?.items ?? [];
    return showScheduleFillers ? items : items.filter(item => !isScheduleFillerItem(item));
  }, [currentSchedule, showScheduleFillers]);
  const currentScheduleCounts = useMemo(() => {
    const items = currentSchedule?.playlist?.items ?? [];
    return {
      total: items.length,
      programs: items.filter(item => !isScheduleFillerItem(item)).length,
      fillers: items.filter(isScheduleFillerItem).length,
    };
  }, [currentSchedule]);

  useEffect(() => {
    void loadActiveSchedule();
    void loadDrafts();
    void loadPublishedSchedules();
    void loadMaterializationRuns();
    void loadBroadcastStatus();
    void loadCurrentBroadcastSchedule();
  }, []);

  const loadWizardFolders = async (force = false): Promise<ProgramFolderOption[]> => {
    if (!force && wizardFolders.length > 0) return wizardFolders;
    setWizardLoadingFolders(true);
    setWizardError('');
    try {
      const response = await mediaApi.programFolders();
      const body = response.data as { folders: ProgramFolderOption[] };
      setWizardFolders(body.folders);
      return body.folders;
    } catch {
      setWizardError('تعذر تحميل قائمة البرامج من مكتبة الوسائط.');
      return [];
    } finally {
      setWizardLoadingFolders(false);
    }
  };

  const syncWizardRowsWithFolders = useCallback((folders: ProgramFolderOption[]) => {
    setWizardRows(rows => rows.map(row => {
      if (!row.folderId) return row;
      const folder = folders.find(item => item.id === row.folderId);
      if (!folder) return row;

      const longestDurationMs = folder.active_longest_file_duration_ms ?? folder.longest_file_duration_ms ?? null;
      const fileCount = folder.active_file_count ?? folder.file_count ?? null;
      const wasMissingDuration = !row.longestDurationMs || row.longestDurationMs <= 0;
      const isKids = row.slotMode === 'kids-round-robin' || isKidsWizardProgram(row.name, folder);
      const roundedDuration = roundDurationMsToMinutes(longestDurationMs);

      return {
        ...row,
        folderRoot: folder.root_key,
        folderHint: folder.original_relative_path,
        fileCount,
        longestDurationMs,
        durationMinutes: isKids ? 60 : wasMissingDuration && roundedDuration ? roundedDuration : row.durationMinutes,
        slotMode: isKids ? 'kids-round-robin' : row.slotMode,
        playMode: isKids ? 'sequential' : row.playMode,
      };
    }));
  }, []);

  const refreshWizardFoldersForRows = useCallback(async () => {
    const folders = await loadWizardFolders(true);
    syncWizardRowsWithFolders(folders);
  }, [loadWizardFolders, syncWizardRowsWithFolders]);

  const handleWizardScanWs = useCallback((msg: { type: string; data?: unknown }) => {
    if (!wizardScanningFoldersRef.current) return;
    if (msg.type === 'scan_progress') {
      setWizardScanProgress(msg.data as ScanProgress);
    }
    if (msg.type === 'scan_complete' || msg.type === 'scan_error') {
      wizardScanningFoldersRef.current = false;
      setWizardScanningFolders(false);
      setWizardScanProgress(null);
      void refreshWizardFoldersForRows();
      if (msg.type === 'scan_complete') {
        setWorkflowMessage('اكتمل فحص المجلدات المحددة وتم تحديث بيانات أطول الملفات في الويزرد.');
      } else {
        setWorkflowError('تعذر إكمال فحص المجلدات المحددة. راجع سجل الفحص ثم حاول مرة أخرى.');
      }
    }
  }, [refreshWizardFoldersForRows]);

  useWebSocket(handleWizardScanWs);

  const openScheduleWizard = () => {
    const today = todayDateInputValue();
    setWizardEditingDraftId(null);
    setWizardStartDate(today);
    setWizardEndDate(today);
    setWizardCycleRepeatCount(1);
    setWizardProgramText('');
    setWizardRows([]);
    setPreview(null);
    setPreviewSource(null);
    setApprovedSchedule(null);
    wizardScanningFoldersRef.current = false;
    setWizardScanningFolders(false);
    setWizardScanProgress(null);
    setWizardOpen(true);
    setWizardError('');
    setWizardStep(1);
    void loadWizardFolders();
  };

  const parseWizardPrograms = async () => {
    const folders = await loadWizardFolders();
    const rows = createWizardRowsFromText(wizardProgramText, folders);
    if (rows.length === 0) {
      setWizardError('اكتب أسماء البرامج، كل برنامج في سطر مستقل.');
      return;
    }

    setWizardRows(rows);
    setWizardError('');
    void startWizardAutoScanForMissingDurations(rows);
    setWizardStep(3);
  };

  const addWizardRow = () => {
    setWizardRows(rows => [...rows, createWizardRow({
      name: `برنامج ${rows.length + 1}`,
      startTime: '08:00',
      durationMinutes: 30,
    }, wizardFolders, rows.length)]);
    setWizardStep(3);
  };

  const updateWizardRow = (localId: string, patch: Partial<WizardProgramDraft>) => {
    setWizardRows(rows => rows.map(row => {
      if (row.localId !== localId) return row;
      const next = { ...row, ...patch };
      if (next.slotMode === 'kids-round-robin') {
        next.durationMinutes = 60;
        next.playMode = 'sequential';
      }
      return next;
    }));
  };

  const removeWizardRow = (localId: string) => {
    setWizardRows(rows => rows.filter(row => row.localId !== localId));
  };

  const applyWizardFolder = (localId: string, folderId: string) => {
    const folder = wizardFolders.find(item => item.id === folderId);
    if (!folder) {
      updateWizardRow(localId, {
        folderId: '',
        folderRoot: '',
        folderHint: '',
        fileCount: null,
        longestDurationMs: null,
        matchStatus: 'needs_review',
        matchConfidence: 0,
      });
      return;
    }

    const currentRow = wizardRows.find(row => row.localId === localId);
    const isKids = currentRow?.slotMode === 'kids-round-robin' || isKidsWizardProgram(currentRow?.name ?? '', folder);

    updateWizardRow(localId, {
      folderId: folder.id,
      folderRoot: folder.root_key,
      folderHint: folder.original_relative_path,
      fileCount: folder.active_file_count ?? folder.file_count ?? null,
      longestDurationMs: folder.active_longest_file_duration_ms ?? folder.longest_file_duration_ms ?? null,
      durationMinutes: isKids ? 60 : roundDurationMsToMinutes(folder.active_longest_file_duration_ms ?? folder.longest_file_duration_ms) || 30,
      slotMode: isKids ? 'kids-round-robin' : currentRow?.slotMode ?? 'fit',
      playMode: isKids ? 'sequential' : currentRow?.playMode ?? 'sequential',
      matchStatus: 'manual',
      matchConfidence: 100,
    });
  };

  const scanWizardFolders = async (localId?: string) => {
    const sourceRows = localId
      ? wizardRows.filter(row => row.localId === localId)
      : wizardRows.filter(shouldScanWizardFolder);
    const targets = wizardFolderScanTargets(sourceRows);

    if (targets.length === 0) {
      setWizardError(localId ? 'اختر مجلد البرنامج قبل تشغيل الفهرسة.' : 'لا توجد مجلدات مختارة تحتاج إلى فهرسة الآن.');
      return;
    }

    wizardScanningFoldersRef.current = true;
    setWizardScanningFolders(true);
    setWizardScanProgress(null);
    setWizardError('');
    setWorkflowError('');

    try {
      await mediaApi.scanBrowserFolders(targets);
      setWorkflowMessage(targets.length === 1
        ? `بدأ فحص مجلد "${targets[0]!.path}" لتحديث عدد الملفات وأطول مدة.`
        : `بدأ فحص ${targets.length} مجلدات مختارة لتحديث عدد الملفات وأطول مدة.`);
    } catch (err) {
      wizardScanningFoldersRef.current = false;
      setWizardScanningFolders(false);
      setWizardScanProgress(null);
      if (isConflictError(err)) {
        setWorkflowMessage('يوجد فحص وسائط يعمل حاليا. بعد اكتماله اضغط فهرسة المجلدات المحددة مرة أخرى.');
      } else {
        setWizardError(describeWorkflowError(err, 'تعذر بدء فحص المجلدات المحددة.'));
      }
    }
  };

  const startWizardAutoScanForMissingDurations = async (rows: WizardProgramDraft[]) => {
    const scanTarget = rows.find(row =>
      row.folderRoot &&
      row.folderHint &&
      ((!row.longestDurationMs || row.longestDurationMs <= 0) || (row.fileCount ?? 0) <= 0)
    );
    if (!scanTarget) return;

    try {
      wizardScanningFoldersRef.current = true;
      setWizardScanningFolders(true);
      setWizardScanProgress(null);
      await mediaApi.scanBrowserFolders(wizardFolderScanTargets([scanTarget]));
      setWorkflowMessage(`بدأ فحص تلقائي لمجلد "${scanTarget.folderHint}" لأن مدة الملفات غير مفهرسة بعد. سيتم تحديث أطول ملف بعد اكتمال الفحص.`);
    } catch (err) {
      wizardScanningFoldersRef.current = false;
      setWizardScanningFolders(false);
      setWizardScanProgress(null);
      if (isConflictError(err)) {
        setWorkflowMessage('يوجد فحص وسائط يعمل حاليا. بعد اكتماله اضغط مطابقة البرامج مرة أخرى لتحديث المدد.');
      }
    }
  };

  const toggleWizardDay = (localId: string, day: string) => {
    setWizardRows(rows => rows.map(row => {
      if (row.localId !== localId) return row;
      const hasDay = row.days.includes(day);
      const nextDays = hasDay ? row.days.filter(item => item !== day) : [...row.days, day];
      return { ...row, days: nextDays.length > 0 ? nextDays : row.days };
    }));
  };

  const buildWizardPreview = async () => {
    const validationError = validateWizardRows(wizardStartDate, wizardEndDate, wizardRows, wizardCycleRepeatCount);
    if (validationError) {
      setWizardError(validationError);
      return;
    }

    setWizardBuilding(true);
    setWizardError('');
    try {
      const payload = buildWizardSchedulePayload(wizardStartDate, wizardEndDate, wizardRows, wizardCycleRepeatCount);
      const response = await schedulerFoundationApi.scheduleInputPreview(payload);
      const parsedPreview = response.data as ExcelPreview;
      const payloadText = JSON.stringify(payload);
      setPreviewSource({
        filename: `wizard-schedule-${wizardStartDate}-to-${wizardEndDate}.json`,
        sha256: await sha256Text(payloadText),
      });
      setPreview(parsedPreview);
      setApprovedSchedule(null);
      setWorkflowError('');
      setWorkflowMessage('تم إنشاء معاينة الجدولة من الويزرد. راجعها ثم اضغط اعتماد الجدول.');
      setWizardStep(5);
      if (parsedPreview.summary.errors > 0) {
        const blockingIssues = parsedPreview.issues.filter(issue => issue.severity === 'error');
        setWizardError(`تم إنشاء المعاينة لكن بها أخطاء تمنع الاعتماد:\n${formatPreviewIssues(blockingIssues, 8, parsedPreview)}`);
      }
    } catch (err) {
      setWizardError(describeWizardPreviewError(err));
    } finally {
      setWizardBuilding(false);
    }
  };

  const saveDraftRecord = async (): Promise<DraftListItem> => {
    if (!preview || preview.summary.errors > 0 || !previewSource) {
      throw new Error('Cannot save schedule before reading a valid source.');
    }

    const sourceExcel = previewSource;
    const name = `${stripScheduleExtension(sourceExcel.filename)} ${preview.settings.schedule_start_date} to ${preview.settings.schedule_end_date}`;
    const response = await schedulerFoundationApi.saveDraftSchedule({
      name,
      sourceExcel,
      preview,
    });
    const body = response.data as { draft: DraftListItem };
    return body.draft;
  };

  const approveSchedule = async () => {
    if (!canApproveSchedule || approvingSchedule) {
      if (approvalBlockers.length > 0) {
        setWorkflowError(`لا يمكن اعتماد الجدول قبل حل هذه النقاط:\n${approvalBlockers.slice(0, 8).map(item => `- ${item}`).join('\n')}`);
      }
      return;
    }
    const confirmed = window.confirm('اعتماد هذا الجدول؟ بعد الاعتماد يمكن تفعيله للبث من نفس الصفحة.');
    if (!confirmed) return;

    setApprovingSchedule(true);
    setWorkflowError('');
    setWorkflowMessage('');
    try {
      const draft = await saveDraftRecord();
      const response = await schedulerFoundationApi.publishDraftSchedule(draft.id);
      const body = response.data as { publishedSchedule: PublishedListItem };
      if (wizardEditingDraftId && wizardEditingDraftId !== draft.id) {
        await schedulerFoundationApi.deleteDraftSchedule(wizardEditingDraftId).catch(() => undefined);
      }
      setApprovedSchedule(body.publishedSchedule);
      setWizardEditingDraftId(null);
      setWizardOpen(false);
      setWorkflowMessage(`تم اعتماد الجدول: ${body.publishedSchedule.name}`);
      await Promise.all([loadDrafts(), loadPublishedSchedules()]);
    } catch (err) {
      setWorkflowError(describeWorkflowError(err, 'تعذر اعتماد الجدول. تأكد أن الخريطة بلا أخطاء وأنها لم تعتمد من قبل.'));
    } finally {
      setApprovingSchedule(false);
    }
  };

  const loadDrafts = async () => {
    setDraftsLoading(true);
    setDraftActionError('');
    try {
      const response = await schedulerFoundationApi.listDraftSchedules();
      const body = response.data as { drafts: DraftListItem[] };
      setDrafts(body.drafts);
    } catch {
      setDraftActionError('تعذر تحميل الجداول المجهزة.');
    } finally {
      setDraftsLoading(false);
    }
  };

  const loadPublishedSchedules = async () => {
    setPublishedLoading(true);
    setQuickBroadcastError('');
    try {
      const response = await schedulerFoundationApi.listPublishedSchedules();
      const body = response.data as { publishedSchedules: PublishedListItem[] };
      setPublishedSchedules(body.publishedSchedules);
    } catch {
      setQuickBroadcastError('تعذر تحميل الجداول المعتمدة.');
    } finally {
      setPublishedLoading(false);
    }
  };

  const loadActiveSchedule = async () => {
    try {
      const response = await schedulerFoundationApi.getActiveSchedule();
      const body = response.data as { activeSchedule: ActiveScheduleStatus | null };
      setActiveSchedule(body.activeSchedule);
    } catch {
      setQuickBroadcastError('تعذر قراءة حالة الجدول النشط.');
    }
  };

  const loadMaterializationRuns = async () => {
    setMaterializationLoading(true);
    try {
      const response = await schedulerFoundationApi.listPlaylistMaterializationRuns();
      const body = response.data as { runs: MaterializationRun[] };
      setMaterializationRuns(body.runs);
    } catch {
      setQuickBroadcastError('تعذر تحميل ملفات التشغيل المجهزة.');
    } finally {
      setMaterializationLoading(false);
    }
  };

  const loadBroadcastStatus = async () => {
    try {
      const response = await broadcastApi.status();
      setBroadcastStatus(response.data as BroadcastStatus);
    } catch {
      setBroadcastStatus(null);
    }
  };

  const loadCurrentBroadcastSchedule = async () => {
    setCurrentScheduleLoading(true);
    setCurrentScheduleError('');
    try {
      const response = await schedulerFoundationApi.currentBroadcastSchedule();
      setCurrentSchedule(response.data as CurrentBroadcastSchedule);
    } catch (err) {
      setCurrentScheduleError(describeQuickBroadcastError(err));
      setCurrentSchedule(null);
    } finally {
      setCurrentScheduleLoading(false);
    }
  };

  const editDraftInWizard = async (draftId: string) => {
    if (editingDraftId) return;
    setEditingDraftId(draftId);
    setDraftActionError('');
    setDraftActionMessage('');
    try {
      const folders = await loadWizardFolders();
      const response = await schedulerFoundationApi.getDraftSchedule(draftId);
      const draft = (response.data as { draft: SchedulerDraftDetail }).draft;
      const draftPreview = draftToPreview(draft);
      setWizardStartDate(draft.scheduleStartDate);
      setWizardEndDate(draft.scheduleEndDate);
      setWizardCycleRepeatCount(detectWizardCycleRepeatCount(draftPreview));
      setWizardProgramText(draft.programs.map(program => program.program_name).join('\n'));
      setWizardRows(wizardRowsFromPreview(draftPreview, folders));
      setPreview(draftPreview);
      setPreviewSource({
        filename: draft.sourceExcelFilename,
        sha256: draft.sourceExcelSha256,
      });
      setApprovedSchedule(null);
      setWizardEditingDraftId(draft.id);
      setWizardError('');
      setWizardStep(3);
      setWizardOpen(true);
    } catch (err) {
      setDraftActionError(describeWorkflowError(err, 'تعذر فتح الجدول داخل الويزرد.'));
    } finally {
      setEditingDraftId(null);
    }
  };

  const deleteDraft = async (draftId: string) => {
    if (deletingDraftId) return;
    const confirmed = window.confirm('حذف هذا الجدول المجهز؟');
    if (!confirmed) return;

    setDeletingDraftId(draftId);
    setDraftActionError('');
    setDraftActionMessage('');
    try {
      await schedulerFoundationApi.deleteDraftSchedule(draftId);
      setDraftActionMessage('تم حذف الجدول المجهز.');
      await loadDrafts();
    } catch (err) {
      setDraftActionError(describeWorkflowError(err, 'تعذر حذف الجدول المجهز.'));
    } finally {
      setDeletingDraftId(null);
    }
  };

  const startPublishedScheduleBroadcast = async (schedule: PublishedListItem) => {
    if (startingPublishedScheduleId) return;

    setStartingPublishedScheduleId(schedule.id);
    setQuickBroadcastMessage('');
    setQuickBroadcastError('');

    try {
      let targetSchedule = schedule;
      if (!schedule.isActive) {
        const activation = await schedulerFoundationApi.activatePublishedSchedule(schedule.id, {
          scheduleId: schedule.id,
          confirmActivation: true,
          confirmationText: `ACTIVATE SCHEDULE ${schedule.id}`,
        });
        targetSchedule = (activation.data as { activeSchedule: PublishedListItem }).activeSchedule;
      }

      let run = materializationRuns
        .filter(item => item.publishedScheduleId === targetSchedule.id)
        .find(isPlayableMaterializationRun) ?? null;

      if (!run) {
        const response = await schedulerFoundationApi.createPlaylistMaterializationDryRun({
          confirmDryRun: true,
          publishedScheduleId: targetSchedule.id,
        });
        run = (response.data as { run: MaterializationRun }).run;
      }

      if (!isPlayableMaterializationRun(run)) {
        throw new Error(describeMaterializationRunProblem(run));
      }

      const response = await schedulerFoundationApi.startMaterializationRunHls(run.id);
      const body = response.data as { hlsUrl?: string };
      const hlsUrl = body.hlsUrl ?? '/hls/stream.m3u8';
      setQuickBroadcastMessage(`تم تشغيل البث. رابط المشاهدة: ${window.location.origin}${hlsUrl}`);
      await Promise.all([
        loadActiveSchedule(),
        loadPublishedSchedules(),
        loadMaterializationRuns(),
        loadBroadcastStatus(),
        loadCurrentBroadcastSchedule(),
      ]);
    } catch (err) {
      setQuickBroadcastError(describeQuickBroadcastError(err));
    } finally {
      setStartingPublishedScheduleId(null);
    }
  };

  const stopLiveBroadcast = async () => {
    if (stoppingBroadcast) return;
    const confirmed = window.confirm('إيقاف البث المباشر الآن؟');
    if (!confirmed) return;

    setStoppingBroadcast(true);
    setQuickBroadcastMessage('');
    setQuickBroadcastError('');
    try {
      await broadcastApi.stop();
      setQuickBroadcastMessage('تم إيقاف البث المباشر.');
      await Promise.all([loadBroadcastStatus(), loadCurrentBroadcastSchedule()]);
    } catch (err) {
      setQuickBroadcastError(describeQuickBroadcastError(err));
    } finally {
      setStoppingBroadcast(false);
    }
  };

  return (
    <div className="space-y-5">
      {wizardOpen && (
        <ScheduleWizardModal
          step={wizardStep}
          startDate={wizardStartDate}
          endDate={wizardEndDate}
          cycleRepeatCount={wizardCycleRepeatCount}
          programText={wizardProgramText}
          rows={wizardRows}
          folders={wizardFolders}
          loadingFolders={wizardLoadingFolders}
          building={wizardBuilding}
          error={wizardError}
          scanningFolders={wizardScanningFolders}
          scanProgress={wizardScanProgress}
          preview={preview}
          canApprove={canApproveSchedule}
          approvalBlockers={approvalBlockers}
          approving={approvingSchedule}
          onClose={() => setWizardOpen(false)}
          onStep={setWizardStep}
          onStartDate={setWizardStartDate}
          onEndDate={setWizardEndDate}
          onCycleRepeatCount={setWizardCycleRepeatCount}
          onProgramText={setWizardProgramText}
          onLoadFolders={() => void refreshWizardFoldersForRows()}
          onParsePrograms={() => void parseWizardPrograms()}
          onBuildPreview={() => void buildWizardPreview()}
          onApprove={() => void approveSchedule()}
          onAddRow={addWizardRow}
          onRemoveRow={removeWizardRow}
          onUpdateRow={updateWizardRow}
          onApplyFolder={applyWizardFolder}
          onScanFolders={(localId?: string) => void scanWizardFolders(localId)}
          onToggleDay={toggleWizardDay}
        />
      )}

      <section>
        <div className="flex flex-wrap items-center gap-2">
          <CalendarDays size={20} style={{ color: 'var(--accent)' }} />
          <h2 className="text-xl font-bold">لوحة تجهيز وجدولة البث</h2>
        </div>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          صفحة واحدة: أنشئ الجدول، راجع الجداول المجهزة، ثم شغل البث من الجدول المعتمد.
        </p>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">1. جدولة جديدة</h3>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              يفتح الويزرد فقط. كل الفحص والاعتماد يتم داخله.
            </p>
          </div>
          <button className="btn-primary flex items-center gap-2 text-sm" onClick={openScheduleWizard}>
            <Wand2 size={14} />
            جدولة
          </button>
        </div>
        {(workflowMessage || workflowError) && (
          <p className="text-xs whitespace-pre-line" style={{ color: workflowError ? 'var(--danger)' : 'var(--success)' }}>
            {workflowError || workflowMessage}
          </p>
        )}
      </section>

      <section className="card space-y-3">
        <div>
          <h3 className="font-semibold">2. الجداول المجهزة من الويزرد</h3>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            الجداول غير المعتمدة فقط. الإجراء المتاح هنا: تعديل أو حذف.
          </p>
        </div>
        <DataTable
          empty={draftsLoading ? 'جاري تحميل الجداول...' : 'لا توجد جداول مجهزة حاليًا'}
          headers={['الجدول', 'الفترة', 'البرامج', 'المواعيد', 'الحالة', 'الإجراء']}
          rows={preparedDrafts.map(draft => [
            draft.name,
            `${draft.scheduleStartDate} to ${draft.scheduleEndDate}`,
            draft.programCount,
            draft.slotCount,
            draft.validationStatus === 'draft_valid' ? 'جاهز للمراجعة' : 'يحتاج تعديل',
            <div key="actions" className="flex flex-wrap gap-2">
              <button
                className="btn-primary inline-flex items-center gap-2 text-xs"
                disabled={editingDraftId === draft.id}
                onClick={() => void editDraftInWizard(draft.id)}
              >
                <Wand2 size={13} />
                {editingDraftId === draft.id ? 'جاري الفتح...' : 'تعديل'}
              </button>
              <button
                className="btn-ghost inline-flex items-center gap-2 text-xs"
                disabled={deletingDraftId === draft.id}
                onClick={() => void deleteDraft(draft.id)}
              >
                <XCircle size={13} />
                {deletingDraftId === draft.id ? 'جاري الحذف...' : 'حذف'}
              </button>
            </div>,
          ])}
        />
        {draftActionMessage && <p className="text-xs" style={{ color: 'var(--success)' }}>{draftActionMessage}</p>}
        {draftActionError && <p className="text-xs whitespace-pre-line" style={{ color: 'var(--danger)' }}>{draftActionError}</p>}
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Radio size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">3. البث المباشر</h3>
              {activeSchedule && <span className="badge badge-ready">النشط الآن: {activeSchedule.name}</span>}
              {broadcastStatus?.status && <span className="badge badge-info">حالة البث: {broadcastStatusLabel(broadcastStatus.status)}</span>}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              الجداول المعتمدة مرتبة من الأحدث إلى الأقدم. زر التشغيل يفعّل الجدول ويجهز ملف التشغيل ثم يبدأ HLS.
            </p>
          </div>
          {materializationLoading && <span className="badge badge-info">جاري تحديث حالة التشغيل</span>}
        </div>

        <DataTable
          empty={publishedLoading ? 'جاري تحميل الجداول المعتمدة...' : 'لا توجد جداول معتمدة بعد'}
          headers={['الجدول المعتمد', 'الفترة', 'البرامج', 'المواعيد', 'الحالة', 'تشغيل']}
          rows={publishedSchedules.map(schedule => {
            const latestRun = materializationRuns.find(run => run.publishedScheduleId === schedule.id);
            const runProblem = latestRun && !isPlayableMaterializationRun(latestRun)
              ? describeMaterializationRunProblem(latestRun)
              : '';
            return [
              schedule.name,
              `${schedule.scheduleStartDate} to ${schedule.scheduleEndDate}`,
              schedule.programCount,
              schedule.slotCount,
              schedule.isActive ? 'نشط الآن' : 'معتمد',
              <div key="broadcast" className="space-y-1">
                <button
                  className="btn-primary inline-flex items-center gap-2 text-xs"
                  disabled={Boolean(startingPublishedScheduleId)}
                  onClick={() => void startPublishedScheduleBroadcast(schedule)}
                >
                  <Play size={13} />
                  {startingPublishedScheduleId === schedule.id ? 'جاري التشغيل...' : 'تشغيل البث المباشر الآن'}
                </button>
                {runProblem && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>{runProblem}</div>}
              </div>,
            ];
          })}
        />

        {quickBroadcastMessage && <p className="text-xs" style={{ color: 'var(--success)' }}>{quickBroadcastMessage}</p>}
        {quickBroadcastError && <p className="text-xs whitespace-pre-line" style={{ color: 'var(--danger)' }}>{quickBroadcastError}</p>}
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ListChecks size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">4. جدول البث العامل</h3>
              {currentSchedule?.playlist && <span className="badge badge-ready">{currentSchedule.playlist.scheduleName}</span>}
              {currentSchedule?.source === 'running-broadcast' && <span className="badge badge-info">من البث الجاري الآن</span>}
              {currentSchedule?.source === 'active-schedule-latest' && <span className="badge badge-info">آخر تجهيز للجدول النشط</span>}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              يعرض البرامج والفواصل الموجودة داخل ملف التشغيل. أظهر الفواصل عند مراجعة الخريطة كاملة، وأخفها عند مراجعة أسماء البرامج ومواعيدها فقط.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-ghost inline-flex items-center gap-2 text-xs"
              disabled={currentScheduleLoading}
              onClick={() => void loadCurrentBroadcastSchedule()}
            >
              <RefreshCw size={13} />
              {currentScheduleLoading ? 'جاري التحديث...' : 'تحديث'}
            </button>
            <button
              className="btn-primary inline-flex items-center gap-2 text-xs"
              disabled={!currentSchedule?.playlist}
              onClick={() => setShowScheduleFillers(value => !value)}
            >
              <Eye size={13} />
              {showScheduleFillers ? 'إخفاء الفواصل' : 'إظهار الفواصل'}
            </button>
          </div>
        </div>

        {currentSchedule?.playlist && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
            <div className="card">
              <div style={{ color: 'var(--text-muted)' }}>كل العناصر</div>
              <div className="text-lg font-bold">{currentScheduleCounts.total}</div>
            </div>
            <div className="card">
              <div style={{ color: 'var(--text-muted)' }}>البرامج</div>
              <div className="text-lg font-bold" style={{ color: 'var(--success)' }}>{currentScheduleCounts.programs}</div>
            </div>
            <div className="card">
              <div style={{ color: 'var(--text-muted)' }}>الفواصل</div>
              <div className="text-lg font-bold" style={{ color: 'var(--warning)' }}>{currentScheduleCounts.fillers}</div>
            </div>
            <div className="card">
              <div style={{ color: 'var(--text-muted)' }}>Run ID</div>
              <div className="text-xs font-mono break-all">{currentSchedule.playlist.runId}</div>
            </div>
          </div>
        )}

        {currentSchedule?.mismatch && (
          <p className="text-xs whitespace-pre-line" style={{ color: 'var(--warning)' }}>
            {currentSchedule.message || 'البث الحالي لا يشير إلى ملف تشغيل الجدول المعروض.'}
          </p>
        )}
        {currentScheduleError && <p className="text-xs whitespace-pre-line" style={{ color: 'var(--danger)' }}>{currentScheduleError}</p>}

        <DataTable
          minWidth={1180}
          empty={currentScheduleLoading ? 'جاري قراءة جدول البث...' : 'لا يوجد جدول تشغيل جاهز للعرض الآن'}
          headers={['النوع', 'اليوم', 'البداية', 'النهاية', 'المدة', 'العنوان', 'الملف', 'الحالة']}
          rows={currentScheduleItems.map(item => [
            <span key="type" className={isScheduleFillerItem(item) ? 'badge badge-info' : 'badge badge-ready'}>
              {scheduleItemTypeLabel(item)}
            </span>,
            item.date,
            item.startTime,
            item.endTime,
            formatScheduleItemDuration(item),
            <div key="title" className="space-y-1">
              <div className="font-medium">{item.title}</div>
              {item.programKey && <div className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>{item.programKey}</div>}
            </div>,
            <span key="file" title={item.absolutePath ?? item.relativePath ?? ''} className="text-xs break-all" style={{ color: 'var(--text-muted)' }}>
              {shortMediaPath(item.absolutePath ?? item.relativePath)}
            </span>,
            scheduleItemStatusLabel(item.validationStatus),
          ])}
        />
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <XCircle size={18} style={{ color: 'var(--danger)' }} />
              <h3 className="font-semibold">5. إيقاف البث الحالي</h3>
              {broadcastStatus?.status && <span className="badge badge-info">الحالة: {broadcastStatusLabel(broadcastStatus.status)}</span>}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              هذا الزر يوقف أي بث HLS يعمل الآن، سواء بدأ من جدول معتمد أو من بث قديم.
            </p>
          </div>
          <button
            className="btn-primary inline-flex items-center gap-2 text-sm"
            disabled={stoppingBroadcast || startingPublishedScheduleId !== null}
            onClick={() => void stopLiveBroadcast()}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
          >
            <XCircle size={14} />
            {stoppingBroadcast ? 'جاري إيقاف البث...' : 'إيقاف البث الآن'}
          </button>
        </div>
        {broadcastStatus?.lastError && (
          <p className="text-xs whitespace-pre-line" style={{ color: 'var(--danger)' }}>
            آخر خطأ: {broadcastStatus.lastError}
          </p>
        )}
      </section>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: 'ready' | 'warning' | 'error' }) {
  const color = tone === 'ready' ? 'var(--success)' : tone === 'warning' ? 'var(--warning)' : tone === 'error' ? 'var(--danger)' : 'var(--text-primary)';
  return (
    <div className="card">
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-2xl font-bold mt-1" style={{ color }}>{value}</div>
    </div>
  );
}

function ScheduleWizardModal({
  step,
  startDate,
  endDate,
  cycleRepeatCount,
  programText,
  rows,
  folders,
  loadingFolders,
  building,
  error,
  scanningFolders,
  scanProgress,
  preview,
  canApprove,
  approvalBlockers,
  approving,
  onClose,
  onStep,
  onStartDate,
  onEndDate,
  onCycleRepeatCount,
  onProgramText,
  onLoadFolders,
  onParsePrograms,
  onBuildPreview,
  onApprove,
  onAddRow,
  onRemoveRow,
  onUpdateRow,
  onApplyFolder,
  onScanFolders,
  onToggleDay,
}: {
  step: number;
  startDate: string;
  endDate: string;
  cycleRepeatCount: WizardCycleRepeatCount;
  programText: string;
  rows: WizardProgramDraft[];
  folders: ProgramFolderOption[];
  loadingFolders: boolean;
  building: boolean;
  error: string;
  scanningFolders: boolean;
  scanProgress: ScanProgress | null;
  preview: ExcelPreview | null;
  canApprove: boolean;
  approvalBlockers: string[];
  approving: boolean;
  onClose: () => void;
  onStep: (step: number) => void;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
  onCycleRepeatCount: (value: WizardCycleRepeatCount) => void;
  onProgramText: (value: string) => void;
  onLoadFolders: () => void;
  onParsePrograms: () => void;
  onBuildPreview: () => void;
  onApprove: () => void;
  onAddRow: () => void;
  onRemoveRow: (localId: string) => void;
  onUpdateRow: (localId: string, patch: Partial<WizardProgramDraft>) => void;
  onApplyFolder: (localId: string, folderId: string) => void;
  onScanFolders: (localId?: string) => void;
  onToggleDay: (localId: string, day: string) => void;
}) {
  const fieldClass = 'w-full rounded-md border px-2 py-1.5 bg-transparent';
  const fieldStyle = { borderColor: 'var(--bg-border)' };
  const wizardIssueMap = preview ? buildWizardIssueMap(rows, preview) : new Map<string, WizardRowIssueSummary>();
  const rowsNeedingScan = rows.filter(shouldScanWizardFolder).length;
  const cycleHours = wizardCycleSpanMinutes(cycleRepeatCount) / 60;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-1" style={{ background: 'rgba(0,0,0,0.72)' }}>
      <div className="w-full max-h-[98vh] overflow-hidden rounded-lg" style={{ width: '99.5vw', maxWidth: 'none', background: 'var(--bg-card)', border: '1px solid var(--bg-border)' }}>
        <div className="flex items-start justify-between gap-4 px-5 py-4" style={{ borderBottom: '1px solid var(--bg-border)' }}>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Wand2 size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">معالج إنشاء الجدولة</h3>
              <span className="badge badge-info">fit / playlist / file-count</span>
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              نفس فكرة النظام القديم: برامج، مواعيد بث، تكرار دورة اليوم، أيام، ثم اعتماد وتشغيل.
            </p>
          </div>
          <button className="btn-ghost px-2 py-2" onClick={onClose} title="إغلاق">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 pt-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {['الفترة', 'قائمة البرامج', 'المطابقة', 'المعاينة', 'الاعتماد'].map((label, index) => (
              <WizardStepPill key={label} label={label} index={index + 1} active={step === index + 1} done={step > index + 1} onClick={() => onStep(index + 1)} />
            ))}
          </div>
        </div>

        <div className="p-4 overflow-y-auto max-h-[82vh]">
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="text-xs space-y-1">
                  <span style={{ color: 'var(--text-muted)' }}>تاريخ بداية الجدولة</span>
                  <input className={fieldClass} style={fieldStyle} type="date" value={startDate} onChange={event => onStartDate(event.target.value)} />
                </label>
                <label className="text-xs space-y-1">
                  <span style={{ color: 'var(--text-muted)' }}>تاريخ نهاية الجدولة</span>
                  <input className={fieldClass} style={fieldStyle} type="date" value={endDate} onChange={event => onEndDate(event.target.value)} />
                </label>
              </div>
              <div className="rounded-md border p-3 space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">تكرار الدورة</div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      {cycleRepeatCount === 1
                        ? 'دورة واحدة تغطي اليوم، والفواصل تكمل الفراغات.'
                        : `${cycleRepeatCount} دورات، مدة كل دورة ${cycleHours} ساعة.`}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {([1, 2, 3, 4] as WizardCycleRepeatCount[]).map(count => (
                      <button
                        key={count}
                        type="button"
                        className="rounded border px-3 py-1.5 text-sm"
                        style={{
                          borderColor: cycleRepeatCount === count ? 'var(--accent)' : 'var(--bg-border)',
                          color: cycleRepeatCount === count ? 'var(--accent)' : 'var(--text-muted)',
                          background: cycleRepeatCount === count ? 'rgba(232,160,32,0.10)' : 'transparent',
                        }}
                        onClick={() => onCycleRepeatCount(count)}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                اختر فترة الخريطة وعدد تكرار الدورة، ثم الصق أسماء البرامج في الخطوة التالية. يمكن كتابة السطر كاسم فقط، أو بصيغة: 12:00 - 12:30 اسم البرنامج.
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => onStep(2)}>
                  <ListChecks size={14} />
                  التالي
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <label className="text-xs space-y-1 block">
                <span style={{ color: 'var(--text-muted)' }}>كل سطر برنامج. يمكن إضافة وقت البث قبل الاسم.</span>
                <textarea
                  className="w-full min-h-72 rounded-md border px-3 py-2 bg-transparent"
                  style={fieldStyle}
                  value={programText}
                  onChange={event => onProgramText(event.target.value)}
                  placeholder={'أيام الله\n12:30 - 13:00 معاني وأسرار الحج\n21:00 فقه الحج'}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button className="btn-ghost flex items-center gap-2 text-sm" disabled={loadingFolders} onClick={onLoadFolders}>
                  <FolderSearch size={14} />
                  {loadingFolders ? 'تحميل البرامج...' : `تحديث البرامج (${folders.length})`}
                </button>
                <button className="btn-primary flex items-center gap-2 text-sm" disabled={loadingFolders} onClick={onParsePrograms}>
                  <CheckCircle2 size={14} />
                  مطابقة الأسماء
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  راجع البرنامج، المجلد، نوع التشغيل، مدة الفترة، ووقت البث داخل الدورة الأولى.
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-ghost flex items-center gap-2 text-sm" disabled={scanningFolders || rowsNeedingScan === 0} onClick={() => onScanFolders()}>
                    <RefreshCw size={14} className={scanningFolders ? 'animate-spin' : ''} />
                    {scanningFolders ? 'جاري الفهرسة...' : `فهرسة المجلدات المحددة (${rowsNeedingScan})`}
                  </button>
                  <button className="btn-ghost flex items-center gap-2 text-sm" onClick={onAddRow}>
                    <Wand2 size={14} />
                    إضافة برنامج
                  </button>
                </div>
              </div>
              {scanningFolders && scanProgress && (
                <div className="rounded-md border p-3 text-xs" style={{ borderColor: 'var(--bg-border)' }}>
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>{scanProgress.currentFile || scanProgress.phase || 'فهرسة المجلدات'}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{scanProgress.scanned}/{scanProgress.total} · أخطاء {scanProgress.errors}</span>
                  </div>
                </div>
              )}
              {preview && preview.issues.length > 0 && (
                <div className="rounded-md border p-3 text-xs" style={{ borderColor: preview.summary.errors > 0 ? 'var(--danger)' : 'var(--warning)', background: preview.summary.errors > 0 ? 'rgba(255,85,85,0.08)' : 'rgba(232,160,32,0.08)' }}>
                  الصفوف المظللة مأخوذة من آخر معاينة. الأحمر يعني خطأ يمنع الاعتماد، والأصفر تحذير لا يمنع الاعتماد.
                </div>
              )}
              <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--bg-border)' }}>
                <table className="w-full text-sm min-w-[2200px]">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
                      {['حذف', 'البرنامج', 'إخفاء اللوجو', 'المشكلة', 'المجلد', 'أطول ملف', 'النوع', 'تشغيل', 'مدة البث', 'البث', 'الأيام', 'file-count'].map(header => (
                        <th key={header} className="text-right px-3 py-2 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const rowIssues = wizardIssueMap.get(row.localId);
                      const issueTone = rowIssues && rowIssues.errors.length > 0 ? 'error' : rowIssues && rowIssues.warnings.length > 0 ? 'warning' : null;
                      const rowBackground = issueTone === 'error'
                        ? 'rgba(255,85,85,0.10)'
                        : issueTone === 'warning'
                          ? 'rgba(232,160,32,0.10)'
                          : 'transparent';
                      return (
                      <tr key={row.localId} style={{ borderBottom: '1px solid var(--bg-border)', background: rowBackground }}>
                        <td className="px-3 py-2 align-top w-16">
                          <button className="btn-ghost px-2 py-1.5" onClick={() => onRemoveRow(row.localId)} title="حذف السطر">
                            <XCircle size={14} />
                          </button>
                        </td>
                        <td className="px-3 py-2 align-top min-w-60">
                          <input className={fieldClass} style={fieldStyle} value={row.name} onChange={event => onUpdateRow(row.localId, { name: event.target.value })} />
                          <div className="mt-1">
                            <span className={`badge ${row.matchStatus === 'needs_review' ? 'badge-warning' : 'badge-ready'}`}>
                              {row.matchStatus === 'needs_review' ? 'مراجعة' : `${row.matchConfidence}%`}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top min-w-32">
                          <label className="inline-flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                            <input
                              type="checkbox"
                              checked={row.hideLogo}
                              onChange={event => onUpdateRow(row.localId, { hideLogo: event.target.checked })}
                            />
                            <span>إخفاء</span>
                          </label>
                        </td>
                        <td className="px-3 py-2 align-top min-w-80 max-w-sm">
                          {rowIssues && rowIssues.issues.length > 0 ? (
                            <div className="space-y-1">
                              {row.notes && (
                                <div className="rounded-md border px-2 py-1 badge-warning" style={{ whiteSpace: 'normal' }}>
                                  {row.notes}
                                </div>
                              )}
                              {rowIssues.issues.slice(0, 3).map((issue, issueIndex) => (
                                <div
                                  key={`${issue.code}-${issueIndex}`}
                                  className={`rounded-md border px-2 py-1 ${issue.severity === 'error' ? 'badge-error' : 'badge-warning'}`}
                                  style={{ whiteSpace: 'normal' }}
                                >
                                  {preview ? formatCompactWizardIssue(issue, preview) : issue.message}
                                </div>
                              ))}
                              {rowIssues.issues.length > 3 && (
                                <div style={{ color: 'var(--text-muted)' }}>+{rowIssues.issues.length - 3} ملاحظة أخرى</div>
                              )}
                            </div>
                          ) : row.notes ? (
                            <div className="rounded-md border px-2 py-1 badge-warning" style={{ whiteSpace: 'normal' }}>
                              {row.notes}
                            </div>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>-</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top min-w-80">
                          <select className={fieldClass} style={fieldStyle} value={row.folderId} onChange={event => onApplyFolder(row.localId, event.target.value)}>
                            <option value="">اختر مجلد البرنامج</option>
                            {folders.map(folder => (
                              <option key={folder.id} value={folder.id}>
                                {folder.root_key} / {folder.display_name_ar || folder.original_relative_path}
                              </option>
                            ))}
                          </select>
                          <div className="text-xs mt-1 ltr-text truncate" style={{ color: 'var(--text-muted)' }}>
                            {row.folderRoot ? `${row.folderRoot}/${row.folderHint}` : 'لم يتم تحديد المجلد'}
                          </div>
                          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            الملفات: {row.fileCount ?? '-'}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top min-w-40">
                          <div className="font-medium">{formatLongestFileDuration(row.longestDurationMs)}</div>
                          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            {row.longestDurationMs ? 'مدة فعلية من مكتبة الوسائط' : 'غير مفهرسة بعد'}
                          </div>
                          {row.folderId && (
                            <button
                              type="button"
                              className="btn-ghost mt-2 flex items-center gap-1 px-2 py-1 text-xs"
                              disabled={scanningFolders}
                              onClick={() => onScanFolders(row.localId)}
                              title="فهرسة هذا المجلد"
                            >
                              <RefreshCw size={12} className={scanningFolders ? 'animate-spin' : ''} />
                              فهرسة
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top min-w-44">
                          <select
                            className={`${fieldClass} min-w-[150px]`}
                            style={fieldStyle}
                            value={row.slotMode}
                            onChange={event => onUpdateRow(row.localId, { slotMode: event.target.value as WizardSlotMode })}
                          >
                            {(Object.keys(slotModeLabels) as WizardSlotMode[]).map(mode => <option key={mode} value={mode}>{slotModeLabels[mode]}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 align-top min-w-44">
                          <select className={`${fieldClass} min-w-[150px]`} style={fieldStyle} value={row.playMode} onChange={event => onUpdateRow(row.localId, { playMode: event.target.value as WizardPlayMode })}>
                            <option value="sequential">sequential</option>
                            <option value="shuffle">shuffle</option>
                            <option value="newest">newest</option>
                            <option value="round_robin">round_robin</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 align-top min-w-32">
                          <input
                            className={`${fieldClass} min-w-[110px]`}
                            style={wizardFieldStyle(rowIssues, 'duration_minutes')}
                            type="number"
                            min={row.slotMode === 'kids-round-robin' ? 60 : 1}
                            disabled={row.slotMode === 'kids-round-robin'}
                            value={row.durationMinutes}
                            onChange={event => onUpdateRow(row.localId, { durationMinutes: Number(event.target.value) })}
                          />
                        </td>
                        <td className="px-3 py-2 align-top min-w-36">
                          <input className={`${fieldClass} min-w-[120px]`} style={wizardTimeFieldStyle(rowIssues, row.startTime)} type="time" value={row.startTime} onChange={event => onUpdateRow(row.localId, { startTime: event.target.value })} />
                        </td>
                        <td className="px-3 py-2 align-top min-w-[360px]">
                          <div className="flex flex-wrap gap-1">
                            {dayKeys.map(day => (
                              <button
                                key={day}
                                type="button"
                                className="rounded border px-2 py-1 text-[11px]"
                                style={{
                                  borderColor: row.days.includes(day) ? 'var(--accent)' : 'var(--bg-border)',
                                  color: row.days.includes(day) ? 'var(--accent)' : 'var(--text-muted)',
                                  background: row.days.includes(day) ? 'rgba(232,160,32,0.10)' : 'transparent',
                                }}
                                onClick={() => onToggleDay(row.localId, day)}
                              >
                                {dayLabels[day]}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top min-w-32">
                          <input className={`${fieldClass} min-w-[110px]`} style={fieldStyle} type="number" min={1} disabled={row.slotMode !== 'file-count'} value={row.fileCountLimit} onChange={event => onUpdateRow(row.localId, { fileCountLimit: Number(event.target.value) })} />
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-ghost text-sm" onClick={() => onStep(2)}>رجوع للقائمة</button>
                <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => onStep(4)}>
                  <Eye size={14} />
                  معاينة قبل الإنشاء
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <SummaryCard label="البرامج" value={rows.length} />
                <SummaryCard label="الدورات" value={cycleRepeatCount} />
                <SummaryCard label="مجلدات محددة" value={rows.filter(row => row.folderId).length} tone="ready" />
                <SummaryCard label="تحتاج مراجعة" value={rows.filter(row => !row.folderId || row.matchStatus === 'needs_review' || (row.fileCount ?? 0) <= 0 || !row.longestDurationMs).length} tone="warning" />
                <SummaryCard label="المواعيد" value={rows.reduce((sum, row) => sum + wizardSlotTimes(row, cycleRepeatCount).length, 0)} />
              </div>
              <DataTable
                empty="لا توجد برامج في الويزرد"
                headers={['البرنامج', 'النوع', 'المدة', 'المواعيد', 'إخفاء اللوجو', 'المجلد', 'أطول حلقة', 'الملفات']}
                rows={rows.map(row => [
                  row.name,
                  row.slotMode,
                  `${row.durationMinutes} دقيقة`,
                  wizardSlotTimes(row, cycleRepeatCount).join('، '),
                  row.hideLogo ? 'نعم' : 'لا',
                  row.folderRoot ? `${row.folderRoot}/${row.folderHint}` : 'غير محدد',
                  formatDurationMs(row.longestDurationMs),
                  row.fileCount ?? '-',
                ])}
              />
              <div className="flex flex-wrap gap-2">
                <button className="btn-ghost text-sm" onClick={() => onStep(3)}>رجوع للتعديل</button>
                <button className="btn-primary flex items-center gap-2 text-sm" disabled={building} onClick={onBuildPreview}>
                  <ListChecks size={14} />
                  {building ? 'جاري إنشاء المعاينة...' : 'إنشاء معاينة الجدولة'}
                </button>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SummaryCard label="البرامج" value={preview?.summary.programCount ?? 0} />
                <SummaryCard label="المواعيد" value={preview?.summary.slotCount ?? 0} />
                <SummaryCard label="التحذيرات" value={preview?.summary.warnings ?? 0} tone="warning" />
                <SummaryCard label="الأخطاء" value={preview?.summary.errors ?? 0} tone="error" />
              </div>
              <div className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                تم تجهيز المعاينة داخل الصفحة. عند عدم وجود أخطاء يمكنك اعتماد الجدول، ثم تفعيله للبث من نفس الصفحة.
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-ghost text-sm" onClick={() => onStep(3)}>رجوع للتعديل</button>
                {approvalBlockers.length > 0 && (
                  <div className="w-full rounded-md border p-3 text-xs whitespace-pre-line" style={{ borderColor: 'var(--danger)', background: 'rgba(255,85,85,0.08)', color: 'var(--danger)' }}>
                    لا يمكن اعتماد الجدول قبل حل هذه النقاط:
                    {'\n'}
                    {approvalBlockers.slice(0, 8).map(item => `- ${item}`).join('\n')}
                    {approvalBlockers.length > 8 ? `\n... و${approvalBlockers.length - 8} ملاحظة أخرى` : ''}
                  </div>
                )}
                <button className="btn-primary flex items-center gap-2 text-sm" disabled={!canApprove || approving} onClick={onApprove}>
                  <ShieldCheck size={14} />
                  {approving ? 'جاري الاعتماد...' : 'اعتماد الجدول'}
                </button>
                <button className="btn-ghost text-sm" onClick={onClose}>إغلاق الويزرد</button>
              </div>
            </div>
          )}

          {step === 5 && preview && preview.issues.length > 0 && <PreviewIssueSummary preview={preview} />}

          {error && <p className="text-xs mt-4 whitespace-pre-line" style={{ color: 'var(--danger)' }}>{error}</p>}
        </div>
      </div>
    </div>
  );
}

function WizardStepPill({ label, index, active, done, onClick }: { label: string; index: number; active: boolean; done: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded-md border px-3 py-2 text-xs flex items-center gap-2"
      style={{
        borderColor: active || done ? 'var(--accent)' : 'var(--bg-border)',
        color: active || done ? 'var(--text-primary)' : 'var(--text-muted)',
        background: active ? 'rgba(232,160,32,0.10)' : 'transparent',
      }}
      onClick={onClick}
    >
      {done ? <CheckCircle2 size={13} style={{ color: 'var(--success)' }} /> : <span>{index}</span>}
      {label}
    </button>
  );
}

interface WizardRowIssueSummary {
  issues: ExcelIssue[];
  errors: ExcelIssue[];
  warnings: ExcelIssue[];
  fields: Record<string, 'error' | 'warning'>;
  times: Record<string, 'error' | 'warning'>;
}

function buildWizardIssueMap(rows: WizardProgramDraft[], preview: ExcelPreview): Map<string, WizardRowIssueSummary> {
  const result = new Map<string, WizardRowIssueSummary>();
  const programKeyToLocalId = new Map<string, string>();
  const programByRow = new Map<number, ProgramRow>();
  const slotByRow = new Map<number, SlotRow>();

  rows.forEach((row, index) => {
    result.set(row.localId, createEmptyWizardRowIssueSummary());
    programKeyToLocalId.set(safeProgramKey(row.name, index), row.localId);
    const previewProgram = preview.programs[index];
    if (previewProgram) programKeyToLocalId.set(previewProgram.program_key, row.localId);
  });

  preview.programs.forEach(program => programByRow.set(program.row, program));
  preview.slots.forEach(slot => slotByRow.set(slot.row, slot));

  preview.issues.forEach(issue => {
    let localId = '';
    let time = '';

    if (issue.sheet === 'Programs' && issue.row) {
      const program = programByRow.get(issue.row);
      localId = program ? programKeyToLocalId.get(program.program_key) ?? '' : '';
    }

    if (issue.sheet === 'Slots' && issue.row) {
      const slot = slotByRow.get(issue.row);
      localId = slot ? programKeyToLocalId.get(slot.program_key) ?? '' : '';
      time = slot?.start_time ?? '';
    }

    if (!localId) return;
    const summary = result.get(localId);
    if (!summary) return;

    summary.issues.push(issue);
    if (issue.severity === 'error') summary.errors.push(issue);
    if (issue.severity === 'warning') summary.warnings.push(issue);
    if (issue.field) {
      summary.fields[issue.field] = mergeWizardIssueTone(summary.fields[issue.field], issue.severity);
    }
    if (time) {
      summary.times[time] = mergeWizardIssueTone(summary.times[time], issue.severity);
    }
  });

  return result;
}

function createEmptyWizardRowIssueSummary(): WizardRowIssueSummary {
  return {
    issues: [],
    errors: [],
    warnings: [],
    fields: {},
    times: {},
  };
}

function mergeWizardIssueTone(current: 'error' | 'warning' | undefined, severity: ExcelIssue['severity']): 'error' | 'warning' {
  if (current === 'error' || severity === 'error') return 'error';
  return 'warning';
}

function wizardFieldStyle(summary: WizardRowIssueSummary | undefined, field: string) {
  const tone = summary?.fields[field];
  return wizardInputStyle(tone);
}

function wizardTimeFieldStyle(summary: WizardRowIssueSummary | undefined, time: string) {
  const tone = time ? summary?.times[time] : undefined;
  return wizardInputStyle(tone);
}

function wizardInputStyle(tone: 'error' | 'warning' | undefined) {
  if (tone === 'error') {
    return { borderColor: 'var(--danger)', background: 'rgba(255,85,85,0.10)' };
  }
  if (tone === 'warning') {
    return { borderColor: 'var(--warning)', background: 'rgba(232,160,32,0.10)' };
  }
  return { borderColor: 'var(--bg-border)' };
}

function formatCompactWizardIssue(issue: ExcelIssue, preview: ExcelPreview): string {
  const label = issue.severity === 'error' ? 'خطأ' : issue.severity === 'warning' ? 'تحذير' : 'معلومة';
  return `${label} - ${previewIssueLocation(issue, preview)}: ${issue.message}`;
}

function previewIssueLocation(issue: ExcelIssue, preview: ExcelPreview): string {
  if (issue.sheet === 'Slots' && issue.row) {
    const slot = preview.slots.find(row => row.row === issue.row);
    if (slot) return `موعد ${slot.start_time}`;
  }
  if (issue.sheet === 'Programs') return 'بيانات البرنامج';
  if (issue.field) return issue.field;
  return issue.sheet;
}

function PreviewIssueSummary({ preview }: { preview: ExcelPreview }) {
  const errors = preview.issues.filter(issue => issue.severity === 'error');
  const warnings = preview.issues.filter(issue => issue.severity === 'warning');
  const infos = preview.issues.filter(issue => issue.severity === 'info');

  return (
    <div className="rounded-md border p-3 mt-4 text-xs space-y-3" style={{ borderColor: errors.length > 0 ? 'var(--danger)' : 'var(--warning)' }}>
      {errors.length > 0 && (
        <div className="space-y-1">
          <div className="font-semibold" style={{ color: 'var(--danger)' }}>
            أخطاء تمنع الاعتماد
          </div>
          {errors.slice(0, 10).map((issue, index) => (
            <div key={`${issue.code}-${index}`} style={{ color: 'var(--danger)' }}>
              {formatPreviewIssue(issue, preview)}
            </div>
          ))}
          {errors.length > 10 && (
            <div style={{ color: 'var(--text-muted)' }}>وهناك {errors.length - 10} خطأ آخر في تبويب الأخطاء والتحذيرات.</div>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="space-y-1">
          <div className="font-semibold" style={{ color: 'var(--warning)' }}>
            تحذيرات لا تمنع الاعتماد
          </div>
          {warnings.slice(0, 6).map((issue, index) => (
            <div key={`${issue.code}-${index}`} style={{ color: 'var(--warning)' }}>
              {formatPreviewIssue(issue, preview)}
            </div>
          ))}
          {warnings.length > 6 && (
            <div style={{ color: 'var(--text-muted)' }}>وهناك {warnings.length - 6} تحذير آخر في تبويب الأخطاء والتحذيرات.</div>
          )}
        </div>
      )}

      {infos.length > 0 && (
        <div style={{ color: 'var(--text-muted)' }}>
          معلومات إضافية: {infos.length}
        </div>
      )}
    </div>
  );
}

function DataTable({
  headers,
  rows,
  empty,
  minWidth = 980,
}: {
  headers: string[];
  rows: Array<Array<ReactNode>>;
  empty: string;
  minWidth?: number;
}) {
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
            {headers.map(header => (
              <th key={header} className="text-right px-4 py-3 font-medium text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} style={{ borderBottom: rowIndex < rows.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-3 align-top max-w-80">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={headers.length} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function createWizardRowsFromText(text: string, folders: ProgramFolderOption[]): WizardProgramDraft[] {
  const rows: WizardProgramDraft[] = [];

  text
    .split(/\r?\n/)
    .map(line => parseWizardProgramLine(line))
    .filter((entry): entry is ParsedWizardProgramLine => Boolean(entry))
    .forEach(entry => {
      const row = createWizardRow(entry, folders, rows.length);
      rows.push(row);
    });

  return rows;
}

function draftToPreview(draft: SchedulerDraftDetail): ExcelPreview {
  return {
    mode: 'preview',
    settings: draft.settings,
    programs: draft.programs,
    slots: draft.slots,
    folderMatches: draft.folderMatches,
    schedulePreview: draft.schedulePreview,
    summary: draft.validationSummary,
    issues: draft.issues,
    productionSafety: draft.productionSafety,
    willActivateSchedule: false,
    willUpdateCursors: false,
    willMaterializePlaylist: false,
  };
}

function detectWizardCycleRepeatCount(preview: ExcelPreview): WizardCycleRepeatCount {
  let detected: WizardCycleRepeatCount = 1;
  for (const slot of preview.slots) {
    const match = /\bcycle\s+\d+\/([1-4])\b/i.exec(slot.notes);
    const value = match ? Number(match[1]) : NaN;
    if (isWizardCycleRepeatCount(value) && value > detected) detected = value;
  }
  return detected;
}

function firstWizardCycleSlots(slots: SlotRow[], cycleRepeatCount: WizardCycleRepeatCount): SlotRow[] {
  if (cycleRepeatCount === 1) return slots;
  const firstCycle = slots.filter(slot => /\bcycle\s+1\/[1-4]\b/i.test(slot.notes));
  return firstCycle.length > 0 ? firstCycle : slots;
}

function wizardRowsFromPreview(preview: ExcelPreview, folders: ProgramFolderOption[]): WizardProgramDraft[] {
  const cycleRepeatCount = detectWizardCycleRepeatCount(preview);
  const slotsByProgram = new Map<string, SlotRow[]>();
  preview.slots.forEach(slot => {
    const slots = slotsByProgram.get(slot.program_key) ?? [];
    slots.push(slot);
    slotsByProgram.set(slot.program_key, slots);
  });

  return preview.programs.map((program, index) => {
    const slots = slotsByProgram.get(program.program_key) ?? [];
    const baseSlots = firstWizardCycleSlots(slots, cycleRepeatCount);
    const match = preview.folderMatches.find(item => item.program_key === program.program_key);
    const folder = folderForMatch(match, folders);
    const longestDurationMs = folder?.active_longest_file_duration_ms ?? folder?.longest_file_duration_ms ?? null;
    const fileCount = folder?.active_file_count ?? folder?.file_count ?? null;
    const times = baseSlots
      .map(slot => slot.start_time)
      .filter((value, timeIndex, values) => Boolean(value) && values.indexOf(value) === timeIndex)
      .slice(0, 1);
    const days = Array.from(new Set(slots.flatMap(slot => slot.days))).filter(day => dayKeys.includes(day));
    const slotMode = wizardSlotModeFromPayload(program.slot_mode);
    const durationMinutes = slotMode === 'kids-round-robin'
      ? 60
      : baseSlots[0]?.duration_minutes ?? roundDurationMsToMinutes(longestDurationMs) ?? 30;

    return {
      localId: `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      name: program.program_name,
      folderId: folder?.id ?? '',
      folderRoot: folder?.root_key ?? program.folder_root,
      folderHint: folder?.original_relative_path ?? program.folder_hint,
      matchStatus: folder ? 'manual' : 'needs_review',
      matchConfidence: match?.confidence ?? 0,
      fileCount,
      longestDurationMs,
      slotMode,
      playMode: wizardPlayModeFromPayload(program.play_mode),
      days: days.length > 0 ? days : [...dayKeys],
      startTime: times[0] ?? '08:00',
      repeatTime: '',
      secondRepeatTime: '',
      durationMinutes,
      fileCountLimit: program.file_count ?? 1,
      hideLogo: program.hide_logo === true,
      notes: program.notes,
    };
  });
}

function folderForMatch(match: FolderMatch | undefined, folders: ProgramFolderOption[]): ProgramFolderOption | null {
  if (!match) return null;
  if (match.matched_folder_id) {
    const byId = folders.find(folder => folder.id === match.matched_folder_id);
    if (byId) return byId;
  }
  if (match.matched_relative_path) {
    return folders.find(folder =>
      folder.root_key === match.folder_root &&
      folder.original_relative_path === match.matched_relative_path
    ) ?? null;
  }
  return null;
}

function wizardSlotModeFromPayload(value: string): WizardSlotMode {
  if (value === 'kids_round_robin') return 'kids-round-robin';
  if (value === 'file_count') return 'file-count';
  if (value === 'playlist') return 'playlist';
  return 'fit';
}

function wizardPlayModeFromPayload(value: string): WizardPlayMode {
  if (value === 'shuffle' || value === 'newest' || value === 'round_robin') return value;
  return 'sequential';
}

interface ParsedWizardProgramLine {
  name: string;
  startTime?: string;
  durationMinutes?: number | null;
  durationWarning?: string;
}

function parseWizardProgramLine(line: string): ParsedWizardProgramLine | null {
  const cleaned = line.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;

  const rangeMatch = cleaned.match(/^(\d{1,2}:\d{2})\s*(?:-|–|—|to|الى|إلى)\s*(\d{1,2}:\d{2})\s+(.+)$/i);
  if (rangeMatch) {
    const startTime = normalizeTimeText(rangeMatch[1]);
    const endTime = normalizeTimeText(rangeMatch[2]);
    const durationMinutes = startTime && endTime ? durationBetweenTimes(startTime, endTime) : null;
    return {
      name: rangeMatch[3].trim(),
      startTime,
      durationMinutes,
      durationWarning: startTime && endTime && durationMinutes === null
        ? `مدة غير منطقية من ${startTime} إلى ${endTime}; تم استخدام مدة الحلقة أو 30 دقيقة بدلًا منها.`
        : undefined,
    };
  }

  const startMatch = cleaned.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
  if (startMatch) {
    return {
      name: startMatch[2].trim(),
      startTime: normalizeTimeText(startMatch[1]),
      durationMinutes: null,
    };
  }

  return { name: cleaned, durationMinutes: null };
}

function createWizardRow(entry: ParsedWizardProgramLine, folders: ProgramFolderOption[], index: number): WizardProgramDraft {
  const best = findBestFolderMatch(entry.name, folders);
  const matchedFolder = best && best.score >= 60 ? best.folder : null;
  const longestDurationMs = matchedFolder?.active_longest_file_duration_ms ?? matchedFolder?.longest_file_duration_ms ?? null;
  const fileCount = matchedFolder?.active_file_count ?? matchedFolder?.file_count ?? null;
  const isKids = isKidsWizardProgram(entry.name, matchedFolder);
  const durationMinutes = isKids ? 60 : roundDurationMsToMinutes(longestDurationMs) || entry.durationMinutes || 30;

  return {
    localId: `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
    name: entry.name,
    folderId: matchedFolder?.id ?? '',
    folderRoot: matchedFolder?.root_key ?? '',
    folderHint: matchedFolder?.original_relative_path ?? '',
    matchStatus: matchedFolder ? (best!.score >= 80 ? 'matched' : 'needs_review') : 'needs_review',
    matchConfidence: matchedFolder ? best!.score : 0,
    fileCount,
    longestDurationMs,
    slotMode: isKids ? 'kids-round-robin' : 'fit',
    playMode: 'sequential',
    days: [...dayKeys],
    startTime: entry.startTime || minutesToTime((8 * 60 + index * 30) % (24 * 60)),
    repeatTime: '',
    secondRepeatTime: '',
    durationMinutes,
    fileCountLimit: 1,
    hideLogo: false,
    notes: entry.durationWarning ?? '',
  };
}

function isKidsWizardProgram(name: string, folder?: ProgramFolderOption | null): boolean {
  const text = normalizeLookupText([
    name,
    folder?.display_name_ar,
    folder?.original_relative_path,
    folder?.safe_slug,
  ].filter(Boolean).join(' '));
  return [
    'kids',
    'children',
    'child',
    '\u0627\u0637\u0641\u0627\u0644',
    '\u0627\u0644\u0627\u0637\u0641\u0627\u0644',
    '\u0637\u0641\u0644',
  ].some(token => text.includes(token));
}

function shouldScanWizardFolder(row: WizardProgramDraft): boolean {
  return Boolean(
    row.folderRoot &&
    row.folderHint &&
    (
      row.slotMode === 'kids-round-robin' ||
      !row.longestDurationMs ||
      row.longestDurationMs <= 0 ||
      (row.fileCount ?? 0) <= 0
    )
  );
}

function wizardFolderScanTargets(rows: WizardProgramDraft[]): WizardFolderScanTarget[] {
  const targets = new Map<string, WizardFolderScanTarget>();
  for (const row of rows) {
    if (!row.folderRoot || !row.folderHint) continue;
    const target = { rootId: row.folderRoot, path: row.folderHint };
    targets.set(`${target.rootId}\0${target.path}`, target);
  }
  return Array.from(targets.values());
}

function findBestFolderMatch(name: string, folders: ProgramFolderOption[]): { folder: ProgramFolderOption; score: number } | null {
  let best: { folder: ProgramFolderOption; score: number } | null = null;
  for (const folder of folders) {
    const score = scoreFolderMatch(name, folder);
    if (!best || score > best.score) {
      best = { folder, score };
    }
  }
  return best;
}

function scoreFolderMatch(name: string, folder: ProgramFolderOption): number {
  const query = normalizeLookupText(name);
  const queryTokens = significantLookupTokens(query);
  const display = normalizeLookupText(folder.display_name_ar);
  const relativePath = normalizeLookupText(folder.original_relative_path);
  const baseName = normalizeLookupText(folder.original_relative_path.split(/[\\/]/).filter(Boolean).pop() ?? folder.display_name_ar);
  const slug = normalizeLookupText(folder.safe_slug);
  const candidates = [display, baseName, relativePath, slug].filter(Boolean);
  const folderText = `${display} ${relativePath} ${slug}`;
  let score = 0;

  for (const candidate of candidates) {
    if (candidate === query) score = Math.max(score, 100);
    else if (candidate.includes(query) || query.includes(candidate)) score = Math.max(score, 86);
    else score = Math.max(
      score,
      tokenOverlapScore(query, candidate),
      tokenSubsetScore(queryTokens, significantLookupTokens(candidate))
    );
  }

  if (folder.root_key === 'normalized-ar') score += 12;
  else if (folder.root_key.includes('normalized')) score += 8;
  if (indicatesFirstSeason(query) && indicatesLaterSeason(folderText)) score -= 18;
  if ((folder.active_file_count ?? folder.file_count ?? 0) <= 0) score -= 25;
  if (folder.status && !['ready', 'indexed'].includes(folder.status)) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

const wizardMatchStopTokens = new Set([
  'ا',
  'د',
  'مع',
  'في',
  'من',
  'الي',
  'الى',
  'الشيخ',
  'الدكتور',
  'فضيله',
  'قناه',
  'دعوه',
  'برنامج',
]);

function tokenOverlapScore(left: string, right: string): number {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  leftTokens.forEach(token => {
    if (rightTokens.has(token)) overlap += 1;
  });
  return Math.round((overlap / Math.max(leftTokens.size, rightTokens.size)) * 72);
}

function tokenSubsetScore(leftTokens: string[], rightTokens: string[]): number {
  if (leftTokens.length < 2 || rightTokens.length === 0) return 0;
  const right = new Set(rightTokens);
  const matched = leftTokens.filter(token => right.has(token)).length;
  if (matched === leftTokens.length) return 84;
  if (matched >= Math.max(2, Math.ceil(leftTokens.length * 0.75))) return 78;
  return 0;
}

function significantLookupTokens(value: string): string[] {
  return normalizeLookupText(value)
    .split(' ')
    .filter(token => token.length > 1 && !/^\d+$/.test(token) && !wizardMatchStopTokens.has(token));
}

function indicatesFirstSeason(value: string): boolean {
  return /(^|\s)1(\s|$)/.test(value) || value.includes('الاول') || value.includes('اول');
}

function indicatesLaterSeason(value: string): boolean {
  return /(^|\s)[2-9](\s|$)/.test(value) || value.includes('الثاني') || value.includes('الثالث');
}

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/عبد\s+الحي/g, 'عبدالحي');
}

function validateWizardRows(startDate: string, endDate: string, rows: WizardProgramDraft[], cycleRepeatCount: WizardCycleRepeatCount): string {
  const issues: string[] = [];
  if (!startDate) issues.push('تاريخ بداية الجدولة غير محدد.');
  if (!endDate) issues.push('تاريخ نهاية الجدولة غير محدد.');
  if (startDate && endDate && endDate < startDate) issues.push('تاريخ نهاية الجدولة يجب أن يكون بعد تاريخ البداية.');
  if (rows.length === 0) issues.push('لا توجد برامج. أضف برنامجًا واحدًا على الأقل.');
  if (!isWizardCycleRepeatCount(cycleRepeatCount)) issues.push('تكرار الدورة يجب أن يكون من 1 إلى 4.');

  rows.forEach((row, index) => {
    const label = `السطر ${index + 1}${row.name.trim() ? ` (${row.name.trim()})` : ''}`;
    if (!row.name.trim()) issues.push(`${label}: اسم البرنامج فارغ.`);
    if (!row.folderId || !row.folderRoot || !row.folderHint) issues.push(`${label}: لم يتم اختيار مجلد البرنامج من مكتبة الوسائط.`);
    if (row.matchStatus === 'needs_review') issues.push(`${label}: المطابقة غير مؤكدة. اختر المجلد الصحيح يدويًا من القائمة قبل إنشاء المعاينة.`);
    if ((row.fileCount ?? 0) <= 0) issues.push(`${label}: المجلد المختار لا يحتوي على ملفات جاهزة.`);
    if (!row.longestDurationMs || row.longestDurationMs <= 0) issues.push(`${label}: مدة الحلقات غير مفهرسة. شغّل فحص المدد أو اختر مجلدًا مفهرسًا.`);
    if (!row.startTime) issues.push(`${label}: وقت البث غير محدد.`);
    if (row.durationMinutes <= 0) issues.push(`${label}: مدة الفترة يجب أن تكون أكبر من صفر.`);
    if (row.slotMode === 'kids-round-robin' && row.durationMinutes !== 60) issues.push(`${label}: kids-round-robin must be exactly 60 minutes.`);
    if (row.days.length === 0) issues.push(`${label}: اختر يوم بث واحدًا على الأقل.`);
    if (row.slotMode === 'file-count' && row.fileCountLimit <= 0) issues.push(`${label}: file-count يحتاج عدد ملفات أكبر من صفر.`);
  });

  return issues.length > 0 ? issues.slice(0, 12).join('\n') : '';
}

function buildWizardSchedulePayload(startDate: string, endDate: string, rows: WizardProgramDraft[], cycleRepeatCount: WizardCycleRepeatCount) {
  const keyedRows: KeyedWizardRow[] = rows.map((row, index) => ({
    row,
    key: safeProgramKey(row.name, index),
    rowIndex: index,
  }));

  return {
    settings: [{
      timezone: 'Europe/Istanbul',
      schedule_start_date: startDate,
      schedule_end_date: endDate,
      default_duration_policy: 'fit',
      default_repeat_policy: 'same_day_same_episode',
      default_gap_policy: 'professional_gap_filler',
    }],
    programs: keyedRows.map(({ row, key }) => ({
      program_key: key,
      program_name: row.name.trim(),
      folder_root: row.folderRoot,
      folder_hint: row.folderHint,
      play_mode: row.playMode,
      slot_mode: wizardSlotModeForPayload(row.slotMode),
      file_count: row.slotMode === 'file-count' ? row.fileCountLimit : '',
      hide_logo: row.hideLogo ? 'true' : 'false',
      repeat_policy: 'same_day_same_episode',
      enabled: 'true',
      notes: row.notes || `wizard:${row.matchStatus}`,
    })),
    slots: buildWizardPayloadSlots(keyedRows, startDate, endDate, cycleRepeatCount),
  };
}

function buildWizardPayloadSlots(keyedRows: KeyedWizardRow[], startDate: string, endDate: string, cycleRepeatCount: WizardCycleRepeatCount): WizardPayloadSlot[] {
  const airings = buildWizardAirings(keyedRows, cycleRepeatCount);
  const airingsByDay = new Map<string, WizardAiring[]>();
  const adjustedDurations = new Map<WizardAiring, number>();

  for (const airing of airings) {
    const dayAirings = airingsByDay.get(airing.day) ?? [];
    dayAirings.push(airing);
    airingsByDay.set(airing.day, dayAirings);
    adjustedDurations.set(airing, Math.max(1, Math.min(airing.durationMinutes, WIZARD_FULL_DAY_MINUTES - airing.startMinutes)));
  }

  for (const dayAirings of airingsByDay.values()) {
    dayAirings.sort((a, b) =>
      a.startMinutes - b.startMinutes ||
      a.keyedRow.rowIndex - b.keyedRow.rowIndex ||
      a.timeIndex - b.timeIndex
    );
    for (let index = 0; index < dayAirings.length - 1; index++) {
      const current = dayAirings[index]!;
      const next = dayAirings.slice(index + 1).find(item => item.startMinutes > current.startMinutes);
      if (!next) continue;
      const maxDurationBeforeNextStart = next.startMinutes - current.startMinutes;
      const currentDuration = adjustedDurations.get(current) ?? current.durationMinutes;
      if (currentDuration > maxDurationBeforeNextStart) {
        adjustedDurations.set(current, Math.max(1, maxDurationBeforeNextStart));
      }
    }
  }

  const groupedSlots = new Map<string, { airing: WizardAiring; durationMinutes: number; days: string[] }>();
  for (const airing of airings) {
    const durationMinutes = adjustedDurations.get(airing) ?? Math.max(1, airing.durationMinutes);
    const groupKey = `${airing.keyedRow.rowIndex}:${airing.timeIndex}:${airing.time}:${durationMinutes}`;
    const group = groupedSlots.get(groupKey);
    if (group) {
      group.days.push(airing.day);
    } else {
      groupedSlots.set(groupKey, { airing, durationMinutes, days: [airing.day] });
    }
  }

  return Array.from(groupedSlots.values())
    .sort((a, b) =>
      a.airing.keyedRow.rowIndex - b.airing.keyedRow.rowIndex ||
      a.airing.timeIndex - b.airing.timeIndex ||
      a.durationMinutes - b.durationMinutes
    )
    .map(({ airing, durationMinutes, days }) => ({
      program_key: airing.keyedRow.key,
      days: sortWizardDays(days).join(';'),
      start_time: airing.time,
      duration_minutes: durationMinutes,
      effective_from: startDate,
      effective_to: endDate,
      priority: airing.keyedRow.rowIndex * 10 + airing.timeIndex + 1,
      notes: cycleRepeatCount === 1
        ? 'main airing; cycle 1/1'
        : `cycle ${airing.cycleIndex + 1}/${airing.cycleRepeatCount}`,
    }));
}

function buildWizardAirings(keyedRows: KeyedWizardRow[], cycleRepeatCount: WizardCycleRepeatCount): WizardAiring[] {
  return keyedRows.flatMap(keyedRow => (
    wizardSlotTimes(keyedRow.row, cycleRepeatCount).flatMap((time, timeIndex) => {
      const startMinutes = timeToMinutes(time);
      if (startMinutes === null) return [];
      const cycleIndex = Math.min(timeIndex, cycleRepeatCount - 1);
      return keyedRow.row.days.map(day => ({
        keyedRow,
        time,
        timeIndex,
        cycleIndex,
        cycleRepeatCount,
        day,
        startMinutes,
        durationMinutes: keyedRow.row.durationMinutes,
      }));
    })
  ));
}

function sortWizardDays(days: string[]): string[] {
  const uniqueDays = Array.from(new Set(days));
  uniqueDays.sort((a, b) => dayKeys.indexOf(a) - dayKeys.indexOf(b));
  return uniqueDays;
}

function wizardSlotModeForPayload(mode: WizardSlotMode): 'fit' | 'playlist' | 'file_count' | 'kids_round_robin' {
  if (mode === 'file-count') return 'file_count';
  if (mode === 'kids-round-robin') return 'kids_round_robin';
  return mode;
}

function isWizardCycleRepeatCount(value: number): value is WizardCycleRepeatCount {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function wizardCycleSpanMinutes(cycleRepeatCount: WizardCycleRepeatCount): number {
  return WIZARD_FULL_DAY_MINUTES / cycleRepeatCount;
}

function wizardSlotTimes(row: WizardProgramDraft, cycleRepeatCount: WizardCycleRepeatCount = 1): string[] {
  const startMinutes = timeToMinutes(row.startTime.trim());
  if (startMinutes === null) return [];

  const cycleSpan = wizardCycleSpanMinutes(cycleRepeatCount);
  return Array.from({ length: cycleRepeatCount }, (_, cycleIndex) =>
    minutesToTime(startMinutes + cycleIndex * cycleSpan)
  ).filter((value, index, values) => values.indexOf(value) === index);
}

function safeProgramKey(name: string, index: number): string {
  const normalized = normalizeLookupText(name).replace(/\s+/g, '-').slice(0, 80);
  return `${normalized || 'program'}-${index + 1}`;
}

function normalizeTimeText(value: string | undefined): string {
  if (!value) return '';
  const [hourRaw, minuteRaw] = value.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function durationBetweenTimes(startTime: string, endTime: string): number | null {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (start === null || end === null) return null;
  const adjustedEnd = end <= start ? end + 24 * 60 : end;
  const duration = adjustedEnd - start;
  if (duration <= 0 || duration > MAX_REASONABLE_WIZARD_SLOT_MINUTES) return null;
  return duration;
}

function timeToMinutes(value: string): number | null {
  const [hourRaw, minuteRaw] = value.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function minutesToTime(minutes: number): string {
  const normalized = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function roundDurationMsToMinutes(value: number | null | undefined): number | null {
  if (!value || value <= 0) return null;
  const roundedMinutes = Math.ceil(value / 60000);
  return Math.max(WIZARD_QUARTER_HOUR_MINUTES, Math.ceil(roundedMinutes / WIZARD_QUARTER_HOUR_MINUTES) * WIZARD_QUARTER_HOUR_MINUTES);
}

function formatDurationMs(value: number | null | undefined): string {
  if (!value || value <= 0) return '-';
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatLongestFileDuration(value: number | null | undefined): string {
  const minutes = roundDurationMsToMinutes(value);
  if (!minutes) return 'غير مفهرسة';
  return `${formatDurationMs(value)} → ${minutes} دقيقة`;
}

function todayDateInputValue(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isPlayableMaterializationRun(run: MaterializationRun): boolean {
  return run.status === 'completed' &&
    run.errors.length === 0 &&
    run.summary.itemCount > 0 &&
    (run.summary.missingMediaFileCount ?? 0) === 0 &&
    run.summary.testPlayoutEligible !== false;
}

function scheduleApprovalBlockers(preview: ExcelPreview): string[] {
  const blockers: string[] = [];
  if (preview.summary.errors > 0) {
    blockers.push(`يوجد ${preview.summary.errors} خطأ في المعاينة يجب حله قبل الاعتماد.`);
  }

  const programNames = new Map(preview.programs.map(program => [program.program_key, program.program_name || program.program_key]));
  const scheduledProgramKeys = new Set(preview.slots.map(slot => slot.program_key).filter(Boolean));
  const matchesByProgramKey = new Map(preview.folderMatches.map(match => [match.program_key, match]));

  scheduledProgramKeys.forEach(programKey => {
    const match = matchesByProgramKey.get(programKey);
    const label = programNames.get(programKey) || programKey;
    if (!match) {
      blockers.push(`البرنامج "${label}" غير مربوط بمجلد ميديا.`);
      return;
    }
    if (match.status !== 'matched' || !match.matched_relative_path) {
      blockers.push(`البرنامج "${label}" يحتاج اختيار مجلد مؤكد. الحالة الحالية: ${match.status_ar || match.status}.`);
    }
  });

  return Array.from(new Set(blockers));
}

function describeMaterializationRunProblem(run: MaterializationRun): string {
  if (run.errors[0]?.message) return run.errors[0].message;
  if (run.summary.missingMediaFileCount && run.summary.missingMediaFileCount > 0) {
    return `${run.summary.missingMediaFileCount} ملف وسائط غير مربوط داخل الخطة. راجع مطابقة البرامج مع normalized-ar.`;
  }
  if (run.summary.testPlayoutEligible === false) return 'ملف التشغيل غير صالح للتشغيل بعد. راجع تفاصيل التجهيز.';
  if (run.status === 'failed') return 'تجهيز ملفات التشغيل فشل. راجع تفاصيل التجهيز.';
  return 'ملف التشغيل غير جاهز بعد.';
}

function isScheduleFillerItem(item: CurrentScheduleItem): boolean {
  return item.type !== 'program' || item.sourceRole === 'filler' || item.sourceRole === 'emergency';
}

function scheduleItemTypeLabel(item: CurrentScheduleItem): string {
  if (item.type === 'program') return 'برنامج';
  if (item.sourceRole === 'emergency') return 'طوارئ';
  return 'فاصل';
}

function formatScheduleItemDuration(item: CurrentScheduleItem): string {
  const seconds = typeof item.durationSeconds === 'number'
    ? item.durationSeconds
    : typeof item.durationMinutes === 'number'
      ? item.durationMinutes * 60
      : typeof item.timelineEndSeconds === 'number' && typeof item.timelineStartSeconds === 'number'
        ? Math.max(0, item.timelineEndSeconds - item.timelineStartSeconds)
        : 0;
  if (!seconds) return '-';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes <= 0) return `${remainder} ث`;
  if (remainder === 0) return `${minutes} د`;
  return `${minutes} د ${remainder} ث`;
}

function scheduleItemStatusLabel(status?: CurrentScheduleItem['validationStatus']): string {
  if (status === 'ready') return 'جاهز';
  if (status === 'missing_media') return 'ملف مفقود';
  if (status === 'unknown_duration') return 'مدة غير معروفة';
  return status || '-';
}

function shortMediaPath(value?: string | null): string {
  if (!value) return '-';
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `.../${parts.slice(-3).join('/')}`;
}

function broadcastStatusLabel(status: NonNullable<BroadcastStatus['status']>): string {
  if (status === 'running') return 'يعمل';
  if (status === 'starting') return 'جاري التشغيل';
  if (status === 'stopping') return 'جاري الإيقاف';
  if (status === 'emergency') return 'طوارئ';
  if (status === 'error') return 'خطأ';
  return 'متوقف';
}

function describeQuickBroadcastError(err: unknown): string {
  const response = isRecord(err) && isRecord(err['response']) ? err['response'] : null;
  const data = response && isRecord(response['data']) ? response['data'] : null;
  const serverMessage = data ? (textValue(data['error']) || textValue(data['message'])) : '';
  if (serverMessage) return serverMessage;
  return err instanceof Error ? err.message : String(err);
}

function isConflictError(err: unknown): boolean {
  const response = isRecord(err) && isRecord(err['response']) ? err['response'] : null;
  return response?.['status'] === 409;
}

function describeWorkflowError(err: unknown, fallback: string): string {
  const serverMessage = describeQuickBroadcastError(err);
  if (serverMessage && serverMessage !== '[object Object]') return serverMessage;
  return fallback;
}

function describeWizardPreviewError(err: unknown): string {
  const response = isRecord(err) && isRecord(err['response']) ? err['response'] : null;
  const status = typeof response?.['status'] === 'number' ? response['status'] : null;
  const data = response && isRecord(response['data']) ? response['data'] : null;
  const code = data ? textValue(data['code']) : '';
  const serverMessage = data ? (textValue(data['error']) || textValue(data['message'])) : '';
  const serverIssues = data && Array.isArray(data['issues'])
    ? formatPreviewIssues(data['issues'].filter(isExcelIssueLike) as ExcelIssue[], 8)
    : '';

  const lines = ['تعذر إنشاء معاينة الجدولة.'];
  if (status || code) {
    lines.push(`الاستجابة: ${status ? `HTTP ${status}` : 'HTTP error'}${code ? ` / ${code}` : ''}`);
  }
  if (serverMessage) {
    lines.push(`رسالة السيرفر: ${serverMessage}`);
  }
  if (serverIssues) {
    lines.push('تفاصيل الأخطاء:');
    lines.push(serverIssues);
  }

  if (!status && !serverMessage) {
    const fallbackMessage = err instanceof Error ? err.message : String(err);
    if (fallbackMessage && fallbackMessage !== '[object Object]') {
      lines.push(`تفاصيل: ${fallbackMessage}`);
    } else {
      lines.push('لم يرجع السيرفر تفاصيل مفهومة. راجع اتصال اللوحة بالـ backend.');
    }
  }

  return lines.join('\n');
}

function formatPreviewIssues(issues: ExcelIssue[], limit: number, preview?: ExcelPreview): string {
  if (issues.length === 0) return 'لا توجد تفاصيل إضافية.';
  const visible = issues.slice(0, limit).map(issue => formatPreviewIssue(issue, preview));
  if (issues.length > limit) visible.push(`... و${issues.length - limit} ملاحظة أخرى`);
  return visible.join('\n');
}

function formatPreviewIssue(issue: ExcelIssue, preview?: ExcelPreview): string {
  const row = issue.row ? `صف ${issue.row}` : 'بدون صف';
  const field = issue.field ? ` / ${issue.field}` : '';
  const context = preview ? previewIssueContext(issue, preview) : '';
  return `[${issue.severity}] ${issue.sheet} ${row}${context}${field} - ${issue.code}: ${issue.message}`;
}

function previewIssueContext(issue: ExcelIssue, preview: ExcelPreview): string {
  if (!issue.row) return '';

  if (issue.sheet === 'Slots') {
    const slot = preview.slots.find(row => row.row === issue.row);
    if (!slot) return '';
    const program = preview.programs.find(row => row.program_key === slot.program_key);
    const title = program?.program_name || slot.program_key;
    const duration = slot.duration_minutes ? ` / ${slot.duration_minutes} دقيقة` : '';
    return ` (${title} - ${slot.start_time}${duration})`;
  }

  if (issue.sheet === 'Programs') {
    const program = preview.programs.find(row => row.row === issue.row);
    if (!program) return '';
    return ` (${program.program_name || program.program_key})`;
  }

  return '';
}

function isExcelIssueLike(value: unknown): value is ExcelIssue {
  return isRecord(value) &&
    typeof value['severity'] === 'string' &&
    typeof value['code'] === 'string' &&
    typeof value['sheet'] === 'string' &&
    typeof value['message'] === 'string';
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return sha256Fallback(bytes);

  const digestInput = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await subtle.digest('SHA-256', digestInput);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Fallback(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  const view = new DataView(padded.buffer);
  const words = new Uint32Array(64);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  padded.set(bytes);
  padded[bytes.length] = 0x80;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(value => value.toString(16).padStart(8, '0'))
    .join('');
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripScheduleExtension(filename: string): string {
  return filename.replace(/\.(xlsx|json)$/i, '').slice(0, 120) || 'Schedule';
}
