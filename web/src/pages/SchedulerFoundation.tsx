import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Circle,
  Download,
  Eye,
  FileSpreadsheet,
  FolderSearch,
  ListChecks,
  Save,
  ShieldCheck,
  Upload,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { mediaApi, schedulerFoundationApi } from '../api/client';

type TabKey = 'programs' | 'slots' | 'matching' | 'issues' | 'preview';

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

type WizardSlotMode = 'fit' | 'playlist' | 'file-count';
type WizardPlayMode = 'sequential' | 'shuffle' | 'newest' | 'round_robin';

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
  notes: string;
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
  scheduleStartDate: string;
  scheduleEndDate: string;
  timezone: string;
  sourceExcelFilename: string;
  sourceExcelSha256: string;
  programCount: number;
  slotCount: number;
  validationSummary: {
    errors: number;
    warnings: number;
    fileStatus: string;
  };
  createdAt: string;
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
  validationSummary: {
    errors: number;
    warnings: number;
    fileStatus: string;
  };
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

interface TestPlayoutPlan {
  id: string;
  sourcePlaylistPath: string;
  outputMode: 'local_file' | 'localhost_hls';
  outputPath: string;
  durationLimitSeconds: number;
  status: 'planned';
  commandPreview: {
    command: string;
    willExecute: false;
    safety: {
      ffmpegExecution: false;
      playoutStarted: false;
      broadcastStarted: false;
      rtmpPush: false;
      streamKeyUsage: false;
      cursorMutation: false;
      mediaAccess: false;
      dnsChanges: false;
    };
    notes: string[];
  };
  warnings: Array<{ code: string; message: string }>;
  errors: Array<{ code: string; message: string }>;
  createdAt: string;
}

const tabs: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'programs', label: 'البرامج', icon: FileSpreadsheet },
  { key: 'slots', label: 'المواعيد', icon: CalendarDays },
  { key: 'matching', label: 'المطابقة', icon: FolderSearch },
  { key: 'issues', label: 'الأخطاء والتحذيرات', icon: ListChecks },
  { key: 'preview', label: 'المعاينة', icon: Wand2 },
];

const steps = [
  'رفع الملف',
  'قراءة الخريطة',
  'اعتماد الجدول',
  'تفعيل للبث',
];

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
};

const MAX_REASONABLE_WIZARD_SLOT_MINUTES = 6 * 60;

export default function SchedulerFoundationPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('programs');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null);
  const [preview, setPreview] = useState<ExcelPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedSchedules, setPublishedSchedules] = useState<PublishedListItem[]>([]);
  const [activeSchedule, setActiveSchedule] = useState<ActiveScheduleStatus | null>(null);
  const [materializationRuns, setMaterializationRuns] = useState<MaterializationRun[]>([]);
  const [materializationLoading, setMaterializationLoading] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [materializationMessage, setMaterializationMessage] = useState('');
  const [materializationError, setMaterializationError] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [testPlayoutPlans, setTestPlayoutPlans] = useState<TestPlayoutPlan[]>([]);
  const [testPlayoutLoading, setTestPlayoutLoading] = useState(false);
  const [testPlayoutPreparing, setTestPlayoutPreparing] = useState(false);
  const [testPlayoutSourcePath, setTestPlayoutSourcePath] = useState('');
  const [testPlayoutOutputMode, setTestPlayoutOutputMode] = useState<'local_file' | 'localhost_hls'>('local_file');
  const [testPlayoutDuration, setTestPlayoutDuration] = useState(1200);
  const [testPlayoutMessage, setTestPlayoutMessage] = useState('');
  const [testPlayoutError, setTestPlayoutError] = useState('');
  const [expandedTestPlayoutPlanId, setExpandedTestPlayoutPlanId] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [approvedSchedule, setApprovedSchedule] = useState<PublishedListItem | null>(null);
  const [approvingSchedule, setApprovingSchedule] = useState(false);
  const [activatingSchedule, setActivatingSchedule] = useState(false);
  const [workflowMessage, setWorkflowMessage] = useState('');
  const [workflowError, setWorkflowError] = useState('');
  const [error, setError] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardStartDate, setWizardStartDate] = useState(() => todayDateInputValue());
  const [wizardEndDate, setWizardEndDate] = useState(() => todayDateInputValue());
  const [wizardProgramText, setWizardProgramText] = useState('');
  const [wizardRows, setWizardRows] = useState<WizardProgramDraft[]>([]);
  const [wizardFolders, setWizardFolders] = useState<ProgramFolderOption[]>([]);
  const [wizardLoadingFolders, setWizardLoadingFolders] = useState(false);
  const [wizardBuilding, setWizardBuilding] = useState(false);
  const [wizardError, setWizardError] = useState('');

  const hasScheduleSource = Boolean(selectedFile || previewSource);
  const completedStep = activeSchedule ? 4 : approvedSchedule ? 3 : preview ? 2 : hasScheduleSource ? 1 : 0;
  const summary = preview?.summary;
  const canApproveSchedule = Boolean(hasScheduleSource && preview && preview.summary.errors === 0 && !approvedSchedule);
  const canActivateApprovedSchedule = Boolean(approvedSchedule && !approvedSchedule.isActive && !activeSchedule);
  const issueGroups = useMemo(() => groupIssues(preview?.issues ?? []), [preview]);

  useEffect(() => {
    void loadActiveSchedule();
    void loadMaterializationRuns();
    void loadTestPlayoutPlans();
  }, []);

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setPreviewSource(null);
    setPreview(null);
    setDraftMessage('');
    setApprovedSchedule(null);
    setWorkflowMessage('');
    setWorkflowError('');
    setError('');
  };

  const runPreview = async () => {
    if (!selectedFile) return;
    setLoading(true);
    setError('');
    setWorkflowError('');
    try {
      const parsedPreview = isJsonScheduleFile(selectedFile)
        ? readJsonSchedulePreview(await selectedFile.text())
        : (await schedulerFoundationApi.excelImportPreview(selectedFile)).data as ExcelPreview;
      setPreview(parsedPreview);
      setDraftMessage('');
      setApprovedSchedule(null);
      setWorkflowMessage('تمت قراءة الخريطة. راجع جدول البرامج ثم اضغط اعتماد الجدول.');
      setActiveTab('programs');
    } catch {
      setError('تعذر قراءة الملف. استخدم ملف Excel بصيغة .xlsx أو ملف JSON صادر من النظام.');
    } finally {
      setLoading(false);
    }
  };

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

  const openScheduleWizard = () => {
    setWizardOpen(true);
    setWizardError('');
    setWizardStep(wizardRows.length > 0 ? 3 : 1);
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
    setWizardRows(rows => rows.map(row => (row.localId === localId ? { ...row, ...patch } : row)));
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

    updateWizardRow(localId, {
      folderId: folder.id,
      folderRoot: folder.root_key,
      folderHint: folder.original_relative_path,
      fileCount: folder.active_file_count ?? folder.file_count ?? null,
      longestDurationMs: folder.active_longest_file_duration_ms ?? folder.longest_file_duration_ms ?? null,
      durationMinutes: roundDurationMsToMinutes(folder.active_longest_file_duration_ms ?? folder.longest_file_duration_ms) || 30,
      matchStatus: 'manual',
      matchConfidence: 100,
    });
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
    const validationError = validateWizardRows(wizardStartDate, wizardEndDate, wizardRows);
    if (validationError) {
      setWizardError(validationError);
      return;
    }

    setWizardBuilding(true);
    setWizardError('');
    try {
      const payload = buildWizardSchedulePayload(wizardStartDate, wizardEndDate, wizardRows);
      const response = await schedulerFoundationApi.scheduleInputPreview(payload);
      const parsedPreview = response.data as ExcelPreview;
      const payloadText = JSON.stringify(payload);
      setSelectedFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setPreviewSource({
        filename: `wizard-schedule-${wizardStartDate}-to-${wizardEndDate}.json`,
        sha256: await sha256Text(payloadText),
      });
      setPreview(parsedPreview);
      setDraftMessage('');
      setApprovedSchedule(null);
      setWorkflowError('');
      setWorkflowMessage('تم إنشاء معاينة الجدولة من الويزرد. راجعها ثم اضغط اعتماد الجدول.');
      setActiveTab('preview');
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
    if (!preview || preview.summary.errors > 0 || (!selectedFile && !previewSource)) {
      throw new Error('Cannot save schedule before reading a valid source.');
    }

    const sourceExcel = selectedFile
      ? { filename: selectedFile.name, sha256: await sha256File(selectedFile) }
      : previewSource!;
    const name = `${stripScheduleExtension(sourceExcel.filename)} ${preview.settings.schedule_start_date} to ${preview.settings.schedule_end_date}`;
    const response = await schedulerFoundationApi.saveDraftSchedule({
      name,
      sourceExcel,
      preview,
    });
    const body = response.data as { draft: DraftListItem };
    return body.draft;
  };

  const saveDraft = async () => {
    if (!preview || preview.summary.errors > 0 || (!selectedFile && !previewSource)) return;
    setSavingDraft(true);
    setError('');
    setDraftMessage('');
    try {
      const draft = await saveDraftRecord();
      setDraftMessage(`تم حفظ الجدول: ${draft.name}`);
      await loadDrafts();
    } catch {
      setError('تعذر حفظ الجدول. تأكد أن الملف بلا أخطاء ثم حاول مرة أخرى.');
    } finally {
      setSavingDraft(false);
    }
  };

  const approveSchedule = async () => {
    if (!canApproveSchedule || approvingSchedule) return;
    const confirmed = window.confirm('اعتماد هذا الجدول؟ بعد الاعتماد يمكن تفعيله للبث من نفس الصفحة.');
    if (!confirmed) return;

    setApprovingSchedule(true);
    setWorkflowError('');
    setWorkflowMessage('');
    try {
      const draft = await saveDraftRecord();
      const response = await schedulerFoundationApi.publishDraftSchedule(draft.id);
      const body = response.data as { publishedSchedule: PublishedListItem };
      setApprovedSchedule(body.publishedSchedule);
      setWorkflowMessage(`تم اعتماد الجدول: ${body.publishedSchedule.name}`);
      await Promise.all([loadDrafts(), loadPublishedSchedules()]);
    } catch {
      setWorkflowError('تعذر اعتماد الجدول. تأكد أن الخريطة بلا أخطاء وأنها لم تعتمد من قبل.');
    } finally {
      setApprovingSchedule(false);
    }
  };

  const activateApprovedSchedule = async () => {
    if (!approvedSchedule || activatingSchedule) return;
    const confirmed = window.confirm(`تفعيل "${approvedSchedule.name}" للبث؟`);
    if (!confirmed) return;

    setActivatingSchedule(true);
    setWorkflowError('');
    setWorkflowMessage('');
    try {
      const response = await schedulerFoundationApi.activatePublishedSchedule(approvedSchedule.id, {
        scheduleId: approvedSchedule.id,
        confirmActivation: true,
        confirmationText: `ACTIVATE SCHEDULE ${approvedSchedule.id}`,
      });
      const body = response.data as { activeSchedule: PublishedListItem };
      setApprovedSchedule({ ...approvedSchedule, isActive: true });
      setActiveSchedule({
        id: body.activeSchedule.id,
        name: body.activeSchedule.name,
        isActive: true,
        scheduleStartDate: body.activeSchedule.scheduleStartDate,
        scheduleEndDate: body.activeSchedule.scheduleEndDate,
        timezone: body.activeSchedule.timezone,
        slotCount: body.activeSchedule.slotCount,
      });
      setWorkflowMessage('تم تفعيل الجدول للبث. الخطوة التالية هي تجهيز ملفات التشغيل أو تشغيل تجربة البث.');
      await Promise.all([loadActiveSchedule(), loadPublishedSchedules()]);
    } catch {
      setWorkflowError('تعذر تفعيل الجدول. تأكد أنه معتمد وصالح ولم يكن مفعلاً من قبل.');
    } finally {
      setActivatingSchedule(false);
    }
  };

  const loadDrafts = async () => {
    setDraftsLoading(true);
    setError('');
    try {
      const response = await schedulerFoundationApi.listDraftSchedules();
      const body = response.data as { drafts: DraftListItem[] };
      setDrafts(body.drafts);
    } catch {
      setError('تعذر تحميل الجداول المحفوظة.');
    } finally {
      setDraftsLoading(false);
    }
  };

  const loadPublishedSchedules = async () => {
    setPublishedLoading(true);
    setError('');
    try {
      const response = await schedulerFoundationApi.listPublishedSchedules();
      const body = response.data as { publishedSchedules: PublishedListItem[] };
      setPublishedSchedules(body.publishedSchedules);
    } catch {
      setError('تعذر تحميل الجداول المعتمدة.');
    } finally {
      setPublishedLoading(false);
    }
  };

  const loadActiveSchedule = async () => {
    setMaterializationError('');
    try {
      const response = await schedulerFoundationApi.getActiveSchedule();
      const body = response.data as { activeSchedule: ActiveScheduleStatus | null };
      setActiveSchedule(body.activeSchedule);
    } catch {
      setMaterializationError('Could not load active schedule status.');
    }
  };

  const loadMaterializationRuns = async () => {
    setMaterializationLoading(true);
    setMaterializationError('');
    try {
      const response = await schedulerFoundationApi.listPlaylistMaterializationRuns();
      const body = response.data as { runs: MaterializationRun[] };
      setMaterializationRuns(body.runs);
    } catch {
      setMaterializationError('تعذر تحميل ملفات التشغيل المجهزة.');
    } finally {
      setMaterializationLoading(false);
    }
  };

  const runMaterializationDryRun = async () => {
    if (!activeSchedule || materializing) return;
    const confirmed = window.confirm(
      `تجهيز ملفات التشغيل للجدول "${activeSchedule.name}"؟\n\nسيتم إنشاء ملفات playlist داخل generated/playlists فقط.`
    );
    if (!confirmed) return;

    setMaterializing(true);
    setMaterializationError('');
    setMaterializationMessage('');
    try {
      const response = await schedulerFoundationApi.createPlaylistMaterializationDryRun({
        confirmDryRun: true,
        publishedScheduleId: activeSchedule.id,
      });
      const body = response.data as { run: MaterializationRun };
      setMaterializationMessage(`تم تجهيز ملفات التشغيل: ${body.run.id}`);
      setExpandedRunId(body.run.id);
      await loadMaterializationRuns();
    } catch {
      setMaterializationError('تعذر تجهيز ملفات التشغيل.');
    } finally {
      setMaterializing(false);
    }
  };

  const loadTestPlayoutPlans = async () => {
    setTestPlayoutLoading(true);
    setTestPlayoutError('');
    try {
      const response = await schedulerFoundationApi.listTestPlayoutPlans();
      const body = response.data as { plans: TestPlayoutPlan[] };
      setTestPlayoutPlans(body.plans);
    } catch {
      setTestPlayoutError('Could not load test playout plans.');
    } finally {
      setTestPlayoutLoading(false);
    }
  };

  const prepareTestPlayoutPlan = async () => {
    if (!testPlayoutSourcePath.trim() || testPlayoutPreparing) return;
    setTestPlayoutPreparing(true);
    setTestPlayoutMessage('');
    setTestPlayoutError('');
    try {
      const response = await schedulerFoundationApi.createTestPlayoutPlan({
        confirmPrepareOnly: true,
        sourcePlaylistPath: testPlayoutSourcePath.trim(),
        outputMode: testPlayoutOutputMode,
        durationLimitSeconds: testPlayoutDuration,
      });
      const body = response.data as { plan: TestPlayoutPlan };
      setTestPlayoutMessage(`تم تجهيز تجربة البث: ${body.plan.id}`);
      setExpandedTestPlayoutPlanId(body.plan.id);
      await loadTestPlayoutPlans();
    } catch {
      setTestPlayoutError('تعذر تجهيز تجربة البث. تأكد أن مسار playlist داخل generated/playlists.');
    } finally {
      setTestPlayoutPreparing(false);
    }
  };

  return (
    <div className="space-y-5">
      {wizardOpen && (
        <ScheduleWizardModal
          step={wizardStep}
          startDate={wizardStartDate}
          endDate={wizardEndDate}
          programText={wizardProgramText}
          rows={wizardRows}
          folders={wizardFolders}
          loadingFolders={wizardLoadingFolders}
          building={wizardBuilding}
          error={wizardError}
          preview={preview}
          canApprove={canApproveSchedule}
          approving={approvingSchedule}
          onClose={() => setWizardOpen(false)}
          onStep={setWizardStep}
          onStartDate={setWizardStartDate}
          onEndDate={setWizardEndDate}
          onProgramText={setWizardProgramText}
          onLoadFolders={() => void loadWizardFolders(true)}
          onParsePrograms={() => void parseWizardPrograms()}
          onBuildPreview={() => void buildWizardPreview()}
          onApprove={() => void approveSchedule()}
          onAddRow={addWizardRow}
          onRemoveRow={removeWizardRow}
          onUpdateRow={updateWizardRow}
          onApplyFolder={applyWizardFolder}
          onToggleDay={toggleWizardDay}
        />
      )}

      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xl font-bold">لوحة تجهيز وجدولة البث</h2>
            <span className="badge badge-info">ارفع الخريطة ثم اعتمدها</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            مسار مبسط: قراءة ملف Excel أو JSON، مراجعة جدول البرامج، اعتماد الجدول، ثم تفعيله للبث.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-primary flex items-center gap-2 text-sm"
            onClick={openScheduleWizard}
          >
            <Wand2 size={14} />
            جدولة جديدة
          </button>
          {preview && preview.summary.errors === 0 && !approvedSchedule && (
            <button
              className="btn-primary flex items-center gap-2 text-sm"
              disabled={!canApproveSchedule || approvingSchedule}
              onClick={() => void approveSchedule()}
            >
              <Save size={14} />
              {approvingSchedule ? 'جاري الاعتماد...' : 'اعتماد الجدول'}
            </button>
          )}
          <button
            className="btn-ghost flex items-center gap-2 text-sm"
            disabled={draftsLoading}
            onClick={() => void loadDrafts()}
          >
            <ListChecks size={14} />
            {draftsLoading ? 'جاري التحميل...' : 'الجداول المحفوظة'}
          </button>
          <button
            className="btn-ghost flex items-center gap-2 text-sm"
            disabled={publishedLoading}
            onClick={() => void loadPublishedSchedules()}
          >
            <CheckCircle2 size={14} />
            {publishedLoading ? 'جاري التحميل...' : 'الجداول المعتمدة'}
          </button>
        </div>
      </section>

      <section className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold">المسار السريع</h3>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              استخدم هذه الخطوات فقط في التشغيل العادي. الجداول التفصيلية بالأسفل للمراجعة عند الحاجة.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary flex items-center gap-2 text-sm" onClick={openScheduleWizard}>
              <Wand2 size={14} />
              جدولة جديدة
            </button>
            <button className="btn-ghost flex items-center gap-2 text-sm" onClick={() => fileRef.current?.click()}>
              <Upload size={14} />
              اختيار ملف
            </button>
            <button className="btn-primary flex items-center gap-2 text-sm" disabled={!selectedFile || loading} onClick={() => void runPreview()}>
              <ListChecks size={14} />
              {loading ? 'جاري القراءة...' : 'قراءة الخريطة'}
            </button>
            <button className="btn-primary flex items-center gap-2 text-sm" disabled={!canApproveSchedule || approvingSchedule} onClick={() => void approveSchedule()}>
              <CheckCircle2 size={14} />
              {approvingSchedule ? 'جاري الاعتماد...' : 'اعتماد الجدول'}
            </button>
            <button className="btn-primary flex items-center gap-2 text-sm" disabled={!canActivateApprovedSchedule || activatingSchedule} onClick={() => void activateApprovedSchedule()}>
              <ShieldCheck size={14} />
              {activatingSchedule ? 'جاري التفعيل...' : 'تفعيل للبث'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <WorkflowStep number={1} title="المصدر" value={selectedFile?.name ?? previewSource?.filename ?? 'اختر Excel/JSON أو أنشئ جدولة'} done={hasScheduleSource} />
          <WorkflowStep number={2} title="المراجعة" value={preview ? `${preview.summary.programCount} برنامج / ${preview.summary.slotCount} موعد` : 'لم تتم القراءة بعد'} done={Boolean(preview)} warning={Boolean(preview && preview.summary.errors > 0)} />
          <WorkflowStep number={3} title="الاعتماد" value={approvedSchedule ? approvedSchedule.name : 'بانتظار الاعتماد'} done={Boolean(approvedSchedule)} />
          <WorkflowStep number={4} title="التفعيل" value={activeSchedule?.name ?? 'لم يتم التفعيل'} done={Boolean(activeSchedule)} />
        </div>

        {(workflowMessage || workflowError) && (
          <p className="text-xs" style={{ color: workflowError ? 'var(--danger)' : 'var(--success)' }}>
            {workflowError || workflowMessage}
          </p>
        )}
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard label="عدد البرامج" value={summary?.programCount ?? 0} />
        <SummaryCard label="البرامج المطابقة" value={summary?.matchedPrograms ?? 0} tone="ready" />
        <SummaryCard label="تحتاج مراجعة" value={summary?.needsReviewPrograms ?? 0} tone="warning" />
        <SummaryCard label="المجلدات غير الموجودة" value={summary?.missingFolders ?? 0} tone="warning" />
        <SummaryCard label="عدد المواعيد" value={summary?.slotCount ?? 0} />
        <SummaryCard label="التعارضات" value={summary?.conflicts ?? 0} tone="error" />
        <SummaryCard label="التحذيرات" value={summary?.warnings ?? 0} tone="warning" />
        <SummaryCard label="الأخطاء" value={summary?.errors ?? 0} tone="error" />
      </section>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold mb-1">نظرة عامة</h3>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              حالة الملف: <span className={statusBadgeClass(summary?.fileStatus)}>{summary?.fileStatus ?? 'بانتظار الملف'}</span>
            </p>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              لا يتم نشر جدول، ولا يتم بناء playlist، ولا يتم تحديث cursors في هذه الصفحة.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button className="btn-primary flex items-center gap-2 text-sm" onClick={openScheduleWizard}>
              <Wand2 size={14} />
              جدولة جديدة
            </button>
            <a className="btn-primary flex items-center gap-2 text-sm" href={schedulerFoundationApi.excelTemplateUrl}>
              <Download size={14} />
              تحميل نموذج Excel
            </a>
            <button className="btn-ghost flex items-center gap-2 text-sm" onClick={() => fileRef.current?.click()}>
              <Upload size={14} />
              رفع ملف الجدولة
            </button>
          </div>
        </div>

        <input ref={fileRef} type="file" accept=".xlsx,.json,application/json" className="hidden" onChange={chooseFile} />

        <div className="mt-4 rounded-md border p-3" style={{ borderColor: 'var(--bg-border)' }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileSpreadsheet size={16} style={{ color: 'var(--accent)' }} />
              <span className="text-sm">{selectedFile?.name ?? previewSource?.filename ?? 'لم يتم اختيار ملف أو إنشاء جدولة بعد'}</span>
            </div>
            <button className="btn-primary flex items-center gap-2 text-sm" disabled={!selectedFile || loading} onClick={() => void runPreview()}>
              <ListChecks size={14} />
              {loading ? 'جاري قراءة البيانات...' : 'قراءة الملف للمعاينة'}
            </button>
          </div>
          {error && <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{error}</p>}
          {draftMessage && <p className="text-xs mt-2" style={{ color: 'var(--success)' }}>{draftMessage}</p>}
          {preview && preview.summary.errors === 0 && !approvedSchedule && (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button className="btn-primary flex items-center gap-2 text-sm" disabled={!canApproveSchedule || approvingSchedule} onClick={() => void approveSchedule()}>
                <CheckCircle2 size={14} />
                {approvingSchedule ? 'جاري الاعتماد...' : 'اعتماد الجدول'}
              </button>
              <button className="btn-ghost flex items-center gap-2 text-sm" disabled={!canApproveSchedule || savingDraft} onClick={() => void saveDraft()}>
                <Save size={14} />
                {savingDraft ? 'جاري الحفظ...' : 'حفظ فقط'}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">تجهيز ملفات التشغيل</h3>
              <span className="badge badge-info">ملفات مراجعة</span>
              <span className="badge badge-info">بدون بث مباشر</span>
              <span className="badge badge-info">لا يغير ملفات الفيديو</span>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              يجهز ملفات playlist داخل generated/playlists حتى تستخدمها في تجربة البث أو المراجعة.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-4">
              <Info label="active schedule" value={activeSchedule?.name ?? 'No active schedule'} />
              <Info label="date range" value={activeSchedule ? `${activeSchedule.scheduleStartDate} to ${activeSchedule.scheduleEndDate}` : '-'} />
              <Info label="timezone" value={activeSchedule?.timezone ?? '-'} />
              <Info label="slots" value={activeSchedule?.slotCount ?? 0} />
            </div>
            {materializationMessage && <p className="text-xs mt-3" style={{ color: 'var(--success)' }}>{materializationMessage}</p>}
            {materializationError && <p className="text-xs mt-3" style={{ color: 'var(--danger)' }}>{materializationError}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-ghost flex items-center gap-2 text-sm"
              disabled={materializationLoading}
              onClick={() => {
                void loadActiveSchedule();
                void loadMaterializationRuns();
              }}
            >
              <ListChecks size={14} />
              {materializationLoading ? 'جاري التحديث...' : 'تحديث الحالة'}
            </button>
            <button
              className="btn-primary flex items-center gap-2 text-sm"
              disabled={!activeSchedule || materializing}
              onClick={() => void runMaterializationDryRun()}
            >
              <CheckCircle2 size={14} />
              {materializing ? 'جاري التجهيز...' : 'تجهيز ملفات التشغيل'}
            </button>
          </div>
        </div>

      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="font-semibold">ملفات التشغيل المجهزة</h3>
          <span className="badge badge-info">generated/playlists</span>
        </div>
        <div>
          <DataTable
            empty={materializationLoading ? 'جاري التحميل...' : 'لم يتم تجهيز ملفات تشغيل بعد'}
            headers={['التشغيل', 'الجدول', 'الحالة', 'العناصر', 'تحذيرات', 'أخطاء', 'المخرجات', 'تفاصيل']}
            rows={materializationRuns.map(run => [
              run.id,
              run.publishedScheduleId,
              run.status,
              run.summary.itemCount,
              run.warnings.length,
              run.errors.length,
              run.outputPath,
              <button
                key="details"
                className="btn-ghost inline-flex items-center gap-2 text-xs"
                onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
              >
                <Eye size={13} />
                {expandedRunId === run.id ? 'إخفاء' : 'تفاصيل'}
              </button>,
            ])}
          />
          {materializationRuns.map(run => (
            expandedRunId === run.id && (
              <div key={run.id} className="rounded-md border p-3 mt-3 text-xs" style={{ borderColor: 'var(--bg-border)' }}>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <Info label="scheduled items" value={run.summary.scheduledItemCount} />
                  <Info label="gap filler items" value={run.summary.gapFillerItemCount} />
                  <Info label="scheduled minutes" value={run.summary.totalScheduledMinutes} />
                  <Info label="gap minutes" value={run.summary.totalGapMinutes} />
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <span className="badge badge-info">cursor mutation: false</span>
                  <span className="badge badge-info">ffmpeg: false</span>
                  <span className="badge badge-info">ffprobe: false</span>
                  <span className="badge badge-info">playout: false</span>
                  <span className="badge badge-info">broadcast: false</span>
                  <span className={run.summary.concatRiskCount === 0 ? 'badge badge-ready' : 'badge badge-warning'}>
                    concat risk: {run.summary.concatRiskCount}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mt-3">
                  <Info label="normalized set" value={run.summary.normalizedSetId ?? 'none'} />
                  <Info label="normalized files" value={run.summary.normalizedMediaCount} />
                  <Info label="safe originals" value={run.summary.originalSafeFallbackCount} />
                  <Info label="missing normalized" value={run.summary.missingNormalizedCount} />
                  <Info label="original not normalized" value={run.summary.originalNotNormalizedCount} />
                </div>
                {run.warnings.length > 0 && (
                  <div className="mt-3" style={{ color: 'var(--warning)' }}>
                    {run.warnings.map(warning => <div key={warning.code}>{warning.code}: {warning.message}</div>)}
                  </div>
                )}
              </div>
            )
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="font-semibold">تجربة البث</h3>
          <span className="badge badge-warning">تحضير تجربة محلية فقط</span>
        </div>
        <div className="rounded-md border p-3" style={{ borderColor: 'var(--bg-border)', background: 'rgba(232,160,32,0.08)' }}>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="badge badge-info">لا يستخدم RTMP</span>
            <span className="badge badge-info">لا يستخدم مفاتيح بث</span>
            <span className="badge badge-info">المخرجات داخل generated/test-playout</span>
          </div>
        </div>
        <div className="rounded-md border p-4 space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            <label className="lg:col-span-2 text-xs space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>مسار ملف التشغيل</span>
              <input
                className="w-full rounded-md border px-3 py-2 bg-transparent"
                style={{ borderColor: 'var(--bg-border)' }}
                value={testPlayoutSourcePath}
                placeholder="generated/playlists/<runId>/playlist.json"
                onChange={event => setTestPlayoutSourcePath(event.target.value)}
              />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>نوع الخروج</span>
              <select
                className="w-full rounded-md border px-3 py-2 bg-transparent"
                style={{ borderColor: 'var(--bg-border)' }}
                value={testPlayoutOutputMode}
                onChange={event => setTestPlayoutOutputMode(event.target.value as 'local_file' | 'localhost_hls')}
              >
                <option value="local_file">local file</option>
                <option value="localhost_hls">localhost HLS</option>
              </select>
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>مدة التجربة بالثواني</span>
              <input
                className="w-full rounded-md border px-3 py-2 bg-transparent"
                style={{ borderColor: 'var(--bg-border)' }}
                type="number"
                min={1}
                max={1200}
                value={testPlayoutDuration}
                onChange={event => setTestPlayoutDuration(Number(event.target.value))}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-primary flex items-center gap-2 text-sm"
              disabled={!testPlayoutSourcePath.trim() || testPlayoutPreparing}
              onClick={() => void prepareTestPlayoutPlan()}
            >
              <ShieldCheck size={14} />
              {testPlayoutPreparing ? 'جاري التجهيز...' : 'تجهيز تجربة البث'}
            </button>
            <button
              className="btn-ghost flex items-center gap-2 text-sm"
              disabled={testPlayoutLoading}
              onClick={() => void loadTestPlayoutPlans()}
            >
              <ListChecks size={14} />
              {testPlayoutLoading ? 'جاري التحميل...' : 'تحديث التجارب'}
            </button>
          </div>
          {testPlayoutMessage && <p className="text-xs" style={{ color: 'var(--success)' }}>{testPlayoutMessage}</p>}
          {testPlayoutError && <p className="text-xs" style={{ color: 'var(--danger)' }}>{testPlayoutError}</p>}
        </div>
        <DataTable
          empty={testPlayoutLoading ? 'جاري تحميل التجارب...' : 'لم يتم تجهيز تجربة بث بعد'}
          headers={['التجربة', 'النوع', 'الحالة', 'المدة', 'ملف التشغيل', 'المخرجات', 'تفاصيل']}
          rows={testPlayoutPlans.map(plan => [
            plan.id,
            plan.outputMode === 'local_file' ? 'local file' : 'localhost HLS',
            plan.status,
            `${plan.durationLimitSeconds}s`,
            plan.sourcePlaylistPath,
            plan.outputPath,
            <button
              key="details"
              className="btn-ghost inline-flex items-center gap-2 text-xs"
              onClick={() => setExpandedTestPlayoutPlanId(expandedTestPlayoutPlanId === plan.id ? null : plan.id)}
            >
              <Eye size={13} />
              {expandedTestPlayoutPlanId === plan.id ? 'إخفاء' : 'تفاصيل'}
            </button>,
          ])}
        />
        {testPlayoutPlans.map(plan => (
          expandedTestPlayoutPlanId === plan.id && (
            <div key={plan.id} className="rounded-md border p-3 text-xs space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
              <div className="flex flex-wrap gap-2">
                <span className="badge badge-info">will execute: false</span>
                <span className="badge badge-info">ffmpeg execution: false</span>
                <span className="badge badge-info">playout started: false</span>
                <span className="badge badge-info">broadcast started: false</span>
                <span className="badge badge-info">stream key usage: false</span>
                <span className="badge badge-info">cursor mutation: false</span>
                <span className="badge badge-info">media access: false</span>
              </div>
              <pre className="rounded-md border p-3 overflow-x-auto" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                {plan.commandPreview.command}
              </pre>
              {plan.warnings.length > 0 && (
                <div style={{ color: 'var(--warning)' }}>
                  {plan.warnings.map(warning => <div key={warning.code}>{warning.code}: {warning.message}</div>)}
                </div>
              )}
            </div>
          )
        ))}
      </section>

      {(drafts.length > 0 || draftsLoading) && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="font-semibold">الجداول المحفوظة</h3>
            <span className="badge badge-info">لم تعتمد بعد</span>
          </div>
          <DataTable
            empty={draftsLoading ? 'جاري التحميل...' : 'لا توجد جداول محفوظة'}
            headers={['الاسم', 'الفترة', 'البرامج', 'المواعيد', 'الحالة', 'الملف', 'تاريخ الحفظ', 'مراجعة']}
            rows={drafts.map(draft => [
              draft.name,
              `${draft.scheduleStartDate} to ${draft.scheduleEndDate}`,
              draft.programCount,
              draft.slotCount,
              draft.status === 'draft' && !draft.isActive ? 'محفوظ' : draft.status,
              `${draft.sourceExcelFilename} (${draft.sourceExcelSha256.slice(0, 12)}...)`,
              draft.createdAt,
              <Link
                key="review"
                to={`/scheduler-foundation/drafts/${draft.id}`}
                className="btn-ghost inline-flex items-center gap-2 text-xs"
              >
                <Eye size={13} />
                مراجعة
              </Link>,
            ])}
          />
        </section>
      )}

      {(publishedSchedules.length > 0 || publishedLoading) && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="font-semibold">الجداول المعتمدة</h3>
            <span className="badge badge-ready">يمكن تفعيل جدول واحد فقط</span>
          </div>
          <DataTable
            empty={publishedLoading ? 'جاري التحميل...' : 'لا توجد جداول معتمدة'}
            headers={['الاسم', 'الفترة', 'البرامج', 'المواعيد', 'الحالة', 'مصدر الاعتماد', 'تاريخ الاعتماد', 'مراجعة']}
            rows={publishedSchedules.map(schedule => [
              schedule.name,
              `${schedule.scheduleStartDate} to ${schedule.scheduleEndDate}`,
              schedule.programCount,
              schedule.slotCount,
              schedule.isActive ? 'مفعل للبث' : 'معتمد غير مفعل',
              schedule.sourceDraftId,
              schedule.publishedAt,
              <Link
                key="review"
                to={`/scheduler-foundation/published/${schedule.id}`}
                className="btn-ghost inline-flex items-center gap-2 text-xs"
              >
                <Eye size={13} />
                مراجعة
              </Link>,
            ])}
          />
        </section>
      )}

      <section className="grid grid-cols-1 md:grid-cols-7 gap-2">
        {steps.map((step, index) => {
          const done = index < completedStep;
          const current = index === completedStep;
          return (
            <div
              key={step}
              className="rounded-md border px-3 py-2 text-xs flex items-center gap-2"
              style={{
                borderColor: done || current ? 'var(--accent)' : 'var(--bg-border)',
                color: done || current ? 'var(--text-primary)' : 'var(--text-muted)',
                background: current ? 'rgba(232,160,32,0.10)' : 'var(--bg-card)',
              }}
            >
              {done ? <CheckCircle2 size={13} style={{ color: 'var(--success)' }} /> : <Circle size={13} />}
              {step}
            </div>
          );
        })}
      </section>

      {preview && (
        <section className="card">
          <h3 className="font-semibold mb-3">إعدادات الملف</h3>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 text-sm">
            <Info label="timezone" value={`${preview.settings.timezone} (${preview.settings.timezoneSource === 'sheet' ? 'من الملف' : 'افتراضي'})`} />
            <Info label="بداية الجدول" value={preview.settings.schedule_start_date || 'غير محدد'} />
            <Info label="نهاية الجدول" value={preview.settings.schedule_end_date || 'غير محدد'} />
            <Info label="عدد الأيام" value={preview.settings.rangeDays ?? 'غير محدد'} />
            <Info label="repeat_policy" value={preview.settings.default_repeat_policy} />
            <Info label="gap_policy" value={preview.settings.default_gap_policy} />
          </div>
        </section>
      )}

      <section className="flex flex-wrap gap-2">
        {tabs.map(tab => (
          <button
            key={tab.key}
            className="btn-ghost flex items-center gap-2 text-sm px-3 py-2"
            style={{
              background: activeTab === tab.key ? 'rgba(232,160,32,0.12)' : undefined,
              color: activeTab === tab.key ? 'var(--accent)' : undefined,
            }}
            onClick={() => setActiveTab(tab.key)}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </section>

      {activeTab === 'programs' && <ProgramsTable rows={preview?.programs ?? []} />}
      {activeTab === 'slots' && <SlotsTable rows={preview?.slots ?? []} />}
      {activeTab === 'matching' && <MatchingTable rows={preview?.folderMatches ?? []} />}
      {activeTab === 'issues' && <IssuesTable issues={preview?.issues ?? []} groups={issueGroups} />}
      {activeTab === 'preview' && <SchedulePreview preview={preview} />}
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

function Info({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="font-medium mt-1">{value}</div>
    </div>
  );
}

function WorkflowStep({
  number,
  title,
  value,
  done,
  warning,
}: {
  number: number;
  title: string;
  value: string | number;
  done: boolean;
  warning?: boolean;
}) {
  const borderColor = warning ? 'var(--warning)' : done ? 'var(--success)' : 'var(--bg-border)';
  const iconColor = warning ? 'var(--warning)' : done ? 'var(--success)' : 'var(--text-muted)';
  return (
    <div className="rounded-md border p-3 min-h-24" style={{ borderColor }}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{title}</div>
        <span className="flex h-6 w-6 items-center justify-center rounded-full border text-xs" style={{ borderColor, color: iconColor }}>
          {done && !warning ? <CheckCircle2 size={14} /> : number}
        </span>
      </div>
      <div className="font-medium mt-2 text-sm break-words">{value}</div>
    </div>
  );
}

function ScheduleWizardModal({
  step,
  startDate,
  endDate,
  programText,
  rows,
  folders,
  loadingFolders,
  building,
  error,
  preview,
  canApprove,
  approving,
  onClose,
  onStep,
  onStartDate,
  onEndDate,
  onProgramText,
  onLoadFolders,
  onParsePrograms,
  onBuildPreview,
  onApprove,
  onAddRow,
  onRemoveRow,
  onUpdateRow,
  onApplyFolder,
  onToggleDay,
}: {
  step: number;
  startDate: string;
  endDate: string;
  programText: string;
  rows: WizardProgramDraft[];
  folders: ProgramFolderOption[];
  loadingFolders: boolean;
  building: boolean;
  error: string;
  preview: ExcelPreview | null;
  canApprove: boolean;
  approving: boolean;
  onClose: () => void;
  onStep: (step: number) => void;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
  onProgramText: (value: string) => void;
  onLoadFolders: () => void;
  onParsePrograms: () => void;
  onBuildPreview: () => void;
  onApprove: () => void;
  onAddRow: () => void;
  onRemoveRow: (localId: string) => void;
  onUpdateRow: (localId: string, patch: Partial<WizardProgramDraft>) => void;
  onApplyFolder: (localId: string, folderId: string) => void;
  onToggleDay: (localId: string, day: string) => void;
}) {
  const fieldClass = 'w-full rounded-md border px-2 py-1.5 bg-transparent';
  const fieldStyle = { borderColor: 'var(--bg-border)' };
  const wizardIssueMap = preview ? buildWizardIssueMap(rows, preview) : new Map<string, WizardRowIssueSummary>();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2" style={{ background: 'rgba(0,0,0,0.72)' }}>
      <div className="w-full max-h-[96vh] overflow-hidden rounded-lg" style={{ width: '98vw', maxWidth: 'none', background: 'var(--bg-card)', border: '1px solid var(--bg-border)' }}>
        <div className="flex items-start justify-between gap-4 px-5 py-4" style={{ borderBottom: '1px solid var(--bg-border)' }}>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Wand2 size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">معالج إنشاء الجدولة</h3>
              <span className="badge badge-info">fit / playlist / file-count</span>
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              نفس فكرة النظام القديم: برامج، مواعيد بث، إعادات، أيام، ثم اعتماد وتشغيل.
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

        <div className="p-5 overflow-y-auto max-h-[78vh]">
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
              <div className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                اختر فترة الخريطة، ثم الصق أسماء البرامج في الخطوة التالية. يمكن كتابة السطر كاسم فقط، أو بصيغة: 12:00 - 12:30 اسم البرنامج.
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
                  راجع البرنامج، المجلد، نوع التشغيل، مدة الفترة، وقت البث والإعادات.
                </div>
                <button className="btn-ghost flex items-center gap-2 text-sm" onClick={onAddRow}>
                  <Wand2 size={14} />
                  إضافة برنامج
                </button>
              </div>
              {preview && preview.issues.length > 0 && (
                <div className="rounded-md border p-3 text-xs" style={{ borderColor: preview.summary.errors > 0 ? 'var(--danger)' : 'var(--warning)', background: preview.summary.errors > 0 ? 'rgba(255,85,85,0.08)' : 'rgba(232,160,32,0.08)' }}>
                  الصفوف المظللة مأخوذة من آخر معاينة. الأحمر يعني خطأ يمنع الاعتماد، والأصفر تحذير لا يمنع الاعتماد.
                </div>
              )}
              <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--bg-border)' }}>
                <table className="w-full text-sm min-w-[1760px]">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
                      {['البرنامج', 'المشكلة', 'المجلد', 'النوع', 'تشغيل', 'المدة', 'البث', 'الإعادة 1', 'الإعادة 2', 'الأيام', 'file-count', ''].map(header => (
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
                        <td className="px-3 py-2 align-top min-w-60">
                          <input className={fieldClass} style={fieldStyle} value={row.name} onChange={event => onUpdateRow(row.localId, { name: event.target.value })} />
                          <div className="mt-1">
                            <span className={`badge ${row.matchStatus === 'needs_review' ? 'badge-warning' : 'badge-ready'}`}>
                              {row.matchStatus === 'needs_review' ? 'مراجعة' : `${row.matchConfidence}%`}
                            </span>
                          </div>
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
                            أطول حلقة: {formatDurationMs(row.longestDurationMs)} · الملفات: {row.fileCount ?? '-'}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <select className={fieldClass} style={fieldStyle} value={row.slotMode} onChange={event => onUpdateRow(row.localId, { slotMode: event.target.value as WizardSlotMode })}>
                            {(Object.keys(slotModeLabels) as WizardSlotMode[]).map(mode => <option key={mode} value={mode}>{slotModeLabels[mode]}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <select className={fieldClass} style={fieldStyle} value={row.playMode} onChange={event => onUpdateRow(row.localId, { playMode: event.target.value as WizardPlayMode })}>
                            <option value="sequential">sequential</option>
                            <option value="shuffle">shuffle</option>
                            <option value="newest">newest</option>
                            <option value="round_robin">round_robin</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 align-top w-28">
                          <input className={fieldClass} style={wizardFieldStyle(rowIssues, 'duration_minutes')} type="number" min={1} value={row.durationMinutes} onChange={event => onUpdateRow(row.localId, { durationMinutes: Number(event.target.value) })} />
                        </td>
                        <td className="px-3 py-2 align-top w-28">
                          <input className={fieldClass} style={wizardTimeFieldStyle(rowIssues, row.startTime)} type="time" value={row.startTime} onChange={event => onUpdateRow(row.localId, { startTime: event.target.value })} />
                        </td>
                        <td className="px-3 py-2 align-top w-28">
                          <input className={fieldClass} style={wizardTimeFieldStyle(rowIssues, row.repeatTime)} type="time" value={row.repeatTime} onChange={event => onUpdateRow(row.localId, { repeatTime: event.target.value })} />
                        </td>
                        <td className="px-3 py-2 align-top w-28">
                          <input className={fieldClass} style={wizardTimeFieldStyle(rowIssues, row.secondRepeatTime)} type="time" value={row.secondRepeatTime} onChange={event => onUpdateRow(row.localId, { secondRepeatTime: event.target.value })} />
                        </td>
                        <td className="px-3 py-2 align-top min-w-72">
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
                        <td className="px-3 py-2 align-top w-28">
                          <input className={fieldClass} style={fieldStyle} type="number" min={1} disabled={row.slotMode !== 'file-count'} value={row.fileCountLimit} onChange={event => onUpdateRow(row.localId, { fileCountLimit: Number(event.target.value) })} />
                        </td>
                        <td className="px-3 py-2 align-top">
                          <button className="btn-ghost px-2 py-1.5" onClick={() => onRemoveRow(row.localId)} title="حذف السطر">
                            <XCircle size={14} />
                          </button>
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
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SummaryCard label="البرامج" value={rows.length} />
                <SummaryCard label="مجلدات محددة" value={rows.filter(row => row.folderId).length} tone="ready" />
                <SummaryCard label="تحتاج مراجعة" value={rows.filter(row => !row.folderId).length} tone="warning" />
                <SummaryCard label="المواعيد" value={rows.reduce((sum, row) => sum + wizardSlotTimes(row).length, 0)} />
              </div>
              <DataTable
                empty="لا توجد برامج في الويزرد"
                headers={['البرنامج', 'النوع', 'المدة', 'المواعيد', 'المجلد', 'أطول حلقة', 'الملفات']}
                rows={rows.map(row => [
                  row.name,
                  row.slotMode,
                  `${row.durationMinutes} دقيقة`,
                  wizardSlotTimes(row).join('، '),
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

function ProgramsTable({ rows }: { rows: ProgramRow[] }) {
  return (
    <DataTable
      empty="ارفع ملف Excel لعرض البرامج المستوردة"
      headers={['الصف', 'الحالة', 'program_key', 'اسم البرنامج', 'root', 'folder_hint', 'play_mode', 'slot_mode', 'file_count', 'repeat_policy', 'enabled', 'ملاحظات', 'الأخطاء/التحذيرات']}
      rows={rows.map(row => [
        row.row,
        <StatusBadge key="status" status={row.status} />,
        row.program_key,
        row.program_name,
        row.folder_root,
        row.folder_hint,
        row.play_mode,
        row.slot_mode,
        row.file_count ?? '',
        row.repeat_policy,
        row.enabled === null ? 'غير صحيح' : row.enabled ? 'مفعل' : 'غير مفعل',
        row.notes,
        <IssueList key="issues" issues={row.issues} />,
      ])}
    />
  );
}

function SlotsTable({ rows }: { rows: SlotRow[] }) {
  return (
    <DataTable
      empty="ارفع ملف Excel لعرض مواعيد البث"
      headers={['الصف', 'الحالة', 'program_key', 'days', 'start_time', 'end_time', 'duration', 'effective_from', 'effective_to', 'priority', 'ملاحظات', 'الأخطاء/التحذيرات']}
      rows={rows.map(row => [
        row.row,
        <StatusBadge key="status" status={row.status} />,
        row.program_key,
        row.days.join('; ') || row.raw_days,
        row.start_time,
        row.end_time || (row.crosses_midnight ? 'يعبر منتصف الليل' : ''),
        row.duration_minutes ?? '',
        row.effective_from,
        row.effective_to,
        row.priority ?? '',
        row.notes,
        <IssueList key="issues" issues={row.issues} />,
      ])}
    />
  );
}

function MatchingTable({ rows }: { rows: FolderMatch[] }) {
  return (
    <DataTable
      empty="لا توجد نتائج مطابقة بعد"
      headers={['الصف', 'program_key', 'root', 'folder_hint', 'الحالة', 'الثقة', 'المجلد المطابق/المقترحات', 'رسالة']}
      rows={rows.map(row => [
        row.row,
        row.program_key,
        row.folder_root,
        row.folder_hint,
        <FolderStatus key="status" match={row} />,
        `${row.confidence}%`,
        row.matched_relative_path || row.suggestions.map(item => `${item.original_relative_path} (${item.confidence}%)`).join('، '),
        row.message,
      ])}
    />
  );
}

function IssuesTable({ issues, groups }: { issues: ExcelIssue[]; groups: Record<string, number> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {Object.entries(groups).map(([code, count]) => (
          <span key={code} className="badge badge-info">{code}: {count}</span>
        ))}
      </div>
      <DataTable
        empty="لا توجد أخطاء أو تحذيرات"
        headers={['النوع', 'الكود', 'Sheet', 'الصف', 'الحقل', 'الرسالة']}
        rows={issues.map(issue => [
          <SeverityIcon key="sev" severity={issue.severity} />,
          issue.code,
          issue.sheet,
          issue.row ?? '',
          issue.field ?? '',
          issue.message,
        ])}
      />
    </div>
  );
}

function SchedulePreview({ preview }: { preview: ExcelPreview | null }) {
  if (!preview) {
    return <div className="card text-center py-8" style={{ color: 'var(--text-muted)' }}>ارفع ملف Excel لعرض المعاينة الأولية</div>;
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>timezone: <strong>{preview.schedulePreview.timezone}</strong></span>
          <span>نمط سد الفراغات: <strong>{preview.schedulePreview.gapPattern}</strong></span>
          {preview.schedulePreview.truncated && <span className="badge badge-warning">المعاينة مختصرة لأول 31 يوم</span>}
        </div>
      </div>

      {preview.schedulePreview.days.map(day => (
        <div key={day.date} className="card p-0 overflow-hidden">
          <div className="px-4 py-3 font-semibold" style={{ borderBottom: '1px solid var(--bg-border)' }}>
            {day.date} - {dayLabels[day.day] ?? day.day}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
                {['النوع', 'البداية', 'النهاية', 'المدة', 'program_key', 'العنوان'].map(header => (
                  <th key={header} className="text-right px-4 py-2 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {day.rows.map((row, index) => (
                <tr key={`${day.date}-${index}`} style={{ borderBottom: index < day.rows.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
                  <td className="px-4 py-2">
                    <span className={`badge ${row.type === 'gap' ? 'badge-warning' : 'badge-ready'}`}>
                      {row.type === 'gap' ? 'Professional Gap Preview' : 'موعد'}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{row.start_time}</td>
                  <td className="px-4 py-2 font-mono text-xs">{row.end_time}</td>
                  <td className="px-4 py-2">{row.duration_minutes} دقيقة</td>
                  <td className="px-4 py-2 font-mono text-xs">{row.program_key ?? ''}</td>
                  <td className="px-4 py-2">{row.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: Array<Array<ReactNode>>; empty: string }) {
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm min-w-[980px]">
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

function StatusBadge({ status }: { status: 'ok' | 'warning' | 'error' }) {
  if (status === 'ok') return <span className="badge badge-ready">صالح</span>;
  if (status === 'warning') return <span className="badge badge-warning">يحتاج مراجعة</span>;
  return <span className="badge badge-error">خطأ</span>;
}

function FolderStatus({ match }: { match: FolderMatch }) {
  const cls = match.status === 'matched' ? 'badge-ready' : match.status === 'folder_missing' ? 'badge-warning' : match.status === 'needs_review' ? 'badge-warning' : 'badge-error';
  return <span className={`badge ${cls}`}>{match.status_ar}</span>;
}

function SeverityIcon({ severity }: { severity: ExcelIssue['severity'] }) {
  if (severity === 'error') return <span className="flex items-center gap-1" style={{ color: 'var(--danger)' }}><XCircle size={14} /> خطأ</span>;
  if (severity === 'warning') return <span className="flex items-center gap-1" style={{ color: 'var(--warning)' }}><AlertTriangle size={14} /> تحذير</span>;
  return <span className="flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Circle size={14} /> معلومة</span>;
}

function IssueList({ issues }: { issues: ExcelIssue[] }) {
  if (issues.length === 0) return <span style={{ color: 'var(--text-muted)' }}>-</span>;
  return (
    <div className="space-y-1 text-xs">
      {issues.map((issue, index) => (
        <div key={`${issue.code}-${index}`} style={{ color: issue.severity === 'error' ? 'var(--danger)' : 'var(--warning)' }}>
          {issue.message}
        </div>
      ))}
    </div>
  );
}

function groupIssues(issues: ExcelIssue[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((acc, issue) => {
    acc[issue.code] = (acc[issue.code] ?? 0) + 1;
    return acc;
  }, {});
}

function createWizardRowsFromText(text: string, folders: ProgramFolderOption[]): WizardProgramDraft[] {
  const rows: WizardProgramDraft[] = [];
  const byName = new Map<string, WizardProgramDraft>();

  text
    .split(/\r?\n/)
    .map(line => parseWizardProgramLine(line))
    .filter((entry): entry is ParsedWizardProgramLine => Boolean(entry))
    .forEach(entry => {
      const key = normalizeLookupText(entry.name);
      const existing = byName.get(key);
      if (existing && entry.startTime) {
        if (existing.startTime !== entry.startTime && !existing.repeatTime) {
          existing.repeatTime = entry.startTime;
        } else if (existing.startTime !== entry.startTime && existing.repeatTime !== entry.startTime && !existing.secondRepeatTime) {
          existing.secondRepeatTime = entry.startTime;
        }
        if (entry.durationMinutes && existing.durationMinutes === 30) {
          existing.durationMinutes = entry.durationMinutes;
        }
        return;
      }

      const row = createWizardRow(entry, folders, rows.length);
      rows.push(row);
      byName.set(key, row);
    });

  return rows;
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
  const durationMinutes = entry.durationMinutes || roundDurationMsToMinutes(longestDurationMs) || 30;

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
    slotMode: 'fit',
    playMode: 'sequential',
    days: [...dayKeys],
    startTime: entry.startTime || minutesToTime((8 * 60 + index * 30) % (24 * 60)),
    repeatTime: '',
    secondRepeatTime: '',
    durationMinutes,
    fileCountLimit: 1,
    notes: entry.durationWarning ?? '',
  };
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
  const display = normalizeLookupText(folder.display_name_ar);
  const relativePath = normalizeLookupText(folder.original_relative_path);
  const baseName = normalizeLookupText(folder.original_relative_path.split(/[\\/]/).filter(Boolean).pop() ?? folder.display_name_ar);
  const slug = normalizeLookupText(folder.safe_slug);
  const candidates = [display, baseName, relativePath, slug].filter(Boolean);
  let score = 0;

  for (const candidate of candidates) {
    if (candidate === query) score = Math.max(score, 100);
    else if (candidate.includes(query) || query.includes(candidate)) score = Math.max(score, 86);
    else score = Math.max(score, tokenOverlapScore(query, candidate));
  }

  if (folder.root_key === 'normalized-ar') score += 12;
  else if (folder.root_key.includes('normalized')) score += 8;
  if ((folder.active_file_count ?? folder.file_count ?? 0) <= 0) score -= 25;
  if (folder.status && !['ready', 'indexed'].includes(folder.status)) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

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

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function validateWizardRows(startDate: string, endDate: string, rows: WizardProgramDraft[]): string {
  const issues: string[] = [];
  if (!startDate) issues.push('تاريخ بداية الجدولة غير محدد.');
  if (!endDate) issues.push('تاريخ نهاية الجدولة غير محدد.');
  if (startDate && endDate && endDate < startDate) issues.push('تاريخ نهاية الجدولة يجب أن يكون بعد تاريخ البداية.');
  if (rows.length === 0) issues.push('لا توجد برامج. أضف برنامجًا واحدًا على الأقل.');

  rows.forEach((row, index) => {
    const label = `السطر ${index + 1}${row.name.trim() ? ` (${row.name.trim()})` : ''}`;
    if (!row.name.trim()) issues.push(`${label}: اسم البرنامج فارغ.`);
    if (!row.folderId || !row.folderRoot || !row.folderHint) issues.push(`${label}: لم يتم اختيار مجلد البرنامج من مكتبة الوسائط.`);
    if (!row.startTime) issues.push(`${label}: وقت البث غير محدد.`);
    if (row.durationMinutes <= 0) issues.push(`${label}: مدة الفترة يجب أن تكون أكبر من صفر.`);
    if (row.days.length === 0) issues.push(`${label}: اختر يوم بث واحدًا على الأقل.`);
    if (row.slotMode === 'file-count' && row.fileCountLimit <= 0) issues.push(`${label}: file-count يحتاج عدد ملفات أكبر من صفر.`);
  });

  return issues.length > 0 ? issues.slice(0, 12).join('\n') : '';
}

function buildWizardSchedulePayload(startDate: string, endDate: string, rows: WizardProgramDraft[]) {
  const keyedRows = rows.map((row, index) => ({
    row,
    key: safeProgramKey(row.name, index),
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
      repeat_policy: 'same_day_same_episode',
      enabled: 'true',
      notes: row.notes || `wizard:${row.matchStatus}`,
    })),
    slots: keyedRows.flatMap(({ row, key }, rowIndex) => wizardSlotTimes(row).map((time, timeIndex) => ({
      program_key: key,
      days: row.days.join(';'),
      start_time: time,
      duration_minutes: row.durationMinutes,
      effective_from: startDate,
      effective_to: endDate,
      priority: rowIndex * 10 + timeIndex + 1,
      notes: timeIndex === 0 ? 'main airing' : `repeat ${timeIndex}`,
    }))),
  };
}

function wizardSlotModeForPayload(mode: WizardSlotMode): 'fit' | 'playlist' | 'file_count' {
  return mode === 'file-count' ? 'file_count' : mode;
}

function wizardSlotTimes(row: WizardProgramDraft): string[] {
  return [row.startTime, row.repeatTime, row.secondRepeatTime]
    .map(value => value.trim())
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
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
  return Math.max(1, Math.ceil(value / 60000));
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

function todayDateInputValue(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

async function sha256File(file: File): Promise<string> {
  return sha256Bytes(new Uint8Array(await file.arrayBuffer()));
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

function isJsonScheduleFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
}

function readJsonSchedulePreview(text: string): ExcelPreview {
  const parsed = JSON.parse(text) as unknown;
  const candidate = isRecord(parsed) && isRecord(parsed['preview'])
    ? parsed['preview']
    : isRecord(parsed) && isRecord(parsed['draft'])
      ? parsed['draft']
      : parsed;
  if (!isRecord(candidate)) {
    throw new Error('Invalid schedule JSON.');
  }

  const maybePreview = candidate as Partial<ExcelPreview>;
  if (
    !isRecord(maybePreview.settings) ||
    !Array.isArray(maybePreview.programs) ||
    !Array.isArray(maybePreview.slots) ||
    !Array.isArray(maybePreview.folderMatches) ||
    !isRecord(maybePreview.schedulePreview) ||
    !isRecord(maybePreview.summary)
  ) {
    throw new Error('Schedule JSON must contain settings, programs, slots, folderMatches, schedulePreview, and summary.');
  }

  return {
    mode: 'preview',
    settings: maybePreview.settings as SettingsPreview,
    programs: maybePreview.programs as ProgramRow[],
    slots: maybePreview.slots as SlotRow[],
    folderMatches: maybePreview.folderMatches as FolderMatch[],
    schedulePreview: maybePreview.schedulePreview as ExcelPreview['schedulePreview'],
    summary: maybePreview.summary as ExcelPreview['summary'],
    issues: Array.isArray(maybePreview.issues) ? maybePreview.issues as ExcelIssue[] : [],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripScheduleExtension(filename: string): string {
  return filename.replace(/\.(xlsx|json)$/i, '').slice(0, 120) || 'Schedule';
}

function statusBadgeClass(value: string | undefined): string {
  if (value === 'صالح للمعاينة') return 'badge badge-ready';
  if (value === 'يحتوي على أخطاء' || value === 'غير صالح') return 'badge badge-error';
  if (value === 'يحتاج مراجعة') return 'badge badge-warning';
  return 'badge badge-pending';
}
