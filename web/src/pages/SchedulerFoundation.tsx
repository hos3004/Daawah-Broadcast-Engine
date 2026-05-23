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
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { schedulerFoundationApi } from '../api/client';

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
  'رفع ملف Excel',
  'قراءة البيانات',
  'فحص البرامج',
  'فحص المواعيد',
  'مطابقة المجلدات',
  'معاينة أولية',
  'حفظ كمسودة فقط',
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

export default function SchedulerFoundationPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('programs');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
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
  const [error, setError] = useState('');

  const completedStep = draftMessage ? 7 : preview ? 6 : selectedFile ? 1 : 0;
  const summary = preview?.summary;
  const issueGroups = useMemo(() => groupIssues(preview?.issues ?? []), [preview]);

  useEffect(() => {
    void loadActiveSchedule();
    void loadMaterializationRuns();
    void loadTestPlayoutPlans();
  }, []);

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setPreview(null);
    setDraftMessage('');
    setError('');
  };

  const runPreview = async () => {
    if (!selectedFile) return;
    setLoading(true);
    setError('');
    try {
      const response = await schedulerFoundationApi.excelImportPreview(selectedFile);
      setPreview(response.data as ExcelPreview);
      setDraftMessage('');
      setActiveTab('programs');
    } catch {
      setError('تعذر قراءة ملف Excel. تأكد من أن الملف بصيغة .xlsx ويحتوي على Sheets المطلوبة.');
    } finally {
      setLoading(false);
    }
  };

  const saveDraft = async () => {
    if (!selectedFile || !preview || preview.summary.errors > 0) return;
    setSavingDraft(true);
    setError('');
    setDraftMessage('');
    try {
      const sha256 = await sha256File(selectedFile);
      const name = `${stripExcelExtension(selectedFile.name)} ${preview.settings.schedule_start_date} to ${preview.settings.schedule_end_date}`;
      const response = await schedulerFoundationApi.saveDraftSchedule({
        name,
        sourceExcel: {
          filename: selectedFile.name,
          sha256,
        },
        preview,
      });
      const body = response.data as { draft: DraftListItem };
      setDraftMessage(`Draft saved: ${body.draft.name}`);
      await loadDrafts();
    } catch {
      setError('Could not save the draft. Make sure the preview has zero errors and try again.');
    } finally {
      setSavingDraft(false);
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
      setError('Could not load draft schedules.');
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
      setError('Could not load published schedules.');
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
      setMaterializationError('Could not load materialization dry-run history.');
    } finally {
      setMaterializationLoading(false);
    }
  };

  const runMaterializationDryRun = async () => {
    if (!activeSchedule || materializing) return;
    const confirmed = window.confirm(
      `Create a playlist materialization dry-run for "${activeSchedule.name}"?\n\nThis writes test artifacts under generated/playlists only. It does not modify media, update cursors, start playout, or broadcast.`
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
      setMaterializationMessage(`Dry-run created: ${body.run.id}`);
      setExpandedRunId(body.run.id);
      await loadMaterializationRuns();
    } catch {
      setMaterializationError('Could not create playlist materialization dry-run.');
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
      setTestPlayoutMessage(`Plan prepared: ${body.plan.id}`);
      setExpandedTestPlayoutPlanId(body.plan.id);
      await loadTestPlayoutPlans();
    } catch {
      setTestPlayoutError('Could not prepare the test playout plan. Check that the playlist path is under generated/playlists and the output target is test-only.');
    } finally {
      setTestPlayoutPreparing(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xl font-bold">لوحة تجهيز وجدولة البث</h2>
            <span className="badge badge-warning">معاينة فقط - لم يتم تفعيل الجدول</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            تحميل نموذج Excel، رفع الجدول، فحص البرامج والمواعيد، ومراجعة المطابقة قبل أي تفعيل.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {preview && preview.summary.errors === 0 && (
            <button
              className="btn-primary flex items-center gap-2 text-sm"
              disabled={!selectedFile || savingDraft}
              onClick={() => void saveDraft()}
            >
              <Save size={14} />
              {savingDraft ? 'Saving Draft...' : 'Save Draft'}
            </button>
          )}
          <button
            className="btn-ghost flex items-center gap-2 text-sm"
            disabled={draftsLoading}
            onClick={() => void loadDrafts()}
          >
            <ListChecks size={14} />
            {draftsLoading ? 'Loading Drafts...' : 'View Drafts'}
          </button>
          <button
            className="btn-ghost flex items-center gap-2 text-sm"
            disabled={publishedLoading}
            onClick={() => void loadPublishedSchedules()}
          >
            <CheckCircle2 size={14} />
            {publishedLoading ? 'Loading Published...' : 'View Published'}
          </button>
        </div>
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

        <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={chooseFile} />

        <div className="mt-4 rounded-md border p-3" style={{ borderColor: 'var(--bg-border)' }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileSpreadsheet size={16} style={{ color: 'var(--accent)' }} />
              <span className="text-sm">{selectedFile?.name ?? 'لم يتم اختيار ملف بعد'}</span>
            </div>
            <button className="btn-primary flex items-center gap-2 text-sm" disabled={!selectedFile || loading} onClick={() => void runPreview()}>
              <ListChecks size={14} />
              {loading ? 'جاري قراءة البيانات...' : 'قراءة الملف للمعاينة'}
            </button>
          </div>
          {error && <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{error}</p>}
          {draftMessage && <p className="text-xs mt-2" style={{ color: 'var(--success)' }}>{draftMessage}</p>}
        </div>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">Playlist Materialization Dry-Run</h3>
              <span className="badge badge-info">dry-run only</span>
              <span className="badge badge-info">no broadcast</span>
              <span className="badge badge-info">no media modification</span>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              Generates review artifacts under generated/playlists only. No ffmpeg, ffprobe, playout, broadcast, production materialization, or cursor mutation.
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
              {materializationLoading ? 'Refreshing...' : 'Refresh Status'}
            </button>
            <button
              className="btn-primary flex items-center gap-2 text-sm"
              disabled={!activeSchedule || materializing}
              onClick={() => void runMaterializationDryRun()}
            >
              <CheckCircle2 size={14} />
              {materializing ? 'Creating Dry-Run...' : 'Create Dry-Run'}
            </button>
          </div>
        </div>

      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="font-semibold">Playlist Materialization Dry-Runs</h3>
          <span className="badge badge-info">generated/playlists only</span>
        </div>
        <div>
          <DataTable
            empty={materializationLoading ? 'Loading dry-runs...' : 'No playlist materialization dry-runs yet'}
            headers={['Run', 'Schedule', 'Status', 'Items', 'Warnings', 'Errors', 'Output', 'Details']}
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
                {expandedRunId === run.id ? 'Hide' : 'Details'}
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
          <h3 className="font-semibold">Test Playout Planning</h3>
          <span className="badge badge-warning">Plan only. Does not run FFmpeg. Does not broadcast.</span>
        </div>
        <div className="rounded-md border p-3" style={{ borderColor: 'var(--bg-border)', background: 'rgba(232,160,32,0.08)' }}>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="badge badge-info">no Run button</span>
            <span className="badge badge-info">no Start button</span>
            <span className="badge badge-info">no Stop button</span>
            <span className="badge badge-info">no RTMP</span>
            <span className="badge badge-info">no stream keys</span>
            <span className="badge badge-info">generated/test-playout only</span>
          </div>
        </div>
        <div className="rounded-md border p-4 space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            <label className="lg:col-span-2 text-xs space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>Dry-run playlist path</span>
              <input
                className="w-full rounded-md border px-3 py-2 bg-transparent"
                style={{ borderColor: 'var(--bg-border)' }}
                value={testPlayoutSourcePath}
                placeholder="generated/playlists/<runId>/playlist.json"
                onChange={event => setTestPlayoutSourcePath(event.target.value)}
              />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>Output mode</span>
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
              <span style={{ color: 'var(--text-muted)' }}>Duration limit seconds</span>
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
              {testPlayoutPreparing ? 'Preparing Plan...' : 'Prepare Plan'}
            </button>
            <button
              className="btn-ghost flex items-center gap-2 text-sm"
              disabled={testPlayoutLoading}
              onClick={() => void loadTestPlayoutPlans()}
            >
              <ListChecks size={14} />
              {testPlayoutLoading ? 'Loading Plans...' : 'Refresh Plans'}
            </button>
          </div>
          {testPlayoutMessage && <p className="text-xs" style={{ color: 'var(--success)' }}>{testPlayoutMessage}</p>}
          {testPlayoutError && <p className="text-xs" style={{ color: 'var(--danger)' }}>{testPlayoutError}</p>}
        </div>
        <DataTable
          empty={testPlayoutLoading ? 'Loading test playout plans...' : 'No test playout plans yet'}
          headers={['Plan', 'Mode', 'Status', 'Duration', 'Source playlist', 'Output', 'Details']}
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
              {expandedTestPlayoutPlanId === plan.id ? 'Hide' : 'Details'}
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
            <h3 className="font-semibold">Draft Schedules</h3>
            <span className="badge badge-info">inactive drafts only</span>
          </div>
          <DataTable
            empty={draftsLoading ? 'Loading drafts...' : 'No draft schedules saved yet'}
            headers={['Name', 'Date range', 'Programs', 'Slots', 'Status', 'Source Excel', 'Created', 'Review']}
            rows={drafts.map(draft => [
              draft.name,
              `${draft.scheduleStartDate} to ${draft.scheduleEndDate}`,
              draft.programCount,
              draft.slotCount,
              draft.status === 'draft' && !draft.isActive ? 'inactive draft' : draft.status,
              `${draft.sourceExcelFilename} (${draft.sourceExcelSha256.slice(0, 12)}...)`,
              draft.createdAt,
              <Link
                key="review"
                to={`/scheduler-foundation/drafts/${draft.id}`}
                className="btn-ghost inline-flex items-center gap-2 text-xs"
              >
                <Eye size={13} />
                Review
              </Link>,
            ])}
          />
        </section>
      )}

      {(publishedSchedules.length > 0 || publishedLoading) && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="font-semibold">Published Schedules</h3>
            <span className="badge badge-ready">activation marks one active schedule only</span>
          </div>
          <DataTable
            empty={publishedLoading ? 'Loading published schedules...' : 'No published schedules yet'}
            headers={['Name', 'Date range', 'Programs', 'Slots', 'Status', 'Source draft', 'Published', 'Review']}
            rows={publishedSchedules.map(schedule => [
              schedule.name,
              `${schedule.scheduleStartDate} to ${schedule.scheduleEndDate}`,
              schedule.programCount,
              schedule.slotCount,
              schedule.isActive ? 'published active' : 'published inactive',
              schedule.sourceDraftId,
              schedule.publishedAt,
              <Link
                key="review"
                to={`/scheduler-foundation/published/${schedule.id}`}
                className="btn-ghost inline-flex items-center gap-2 text-xs"
              >
                <Eye size={13} />
                Review
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

async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function stripExcelExtension(filename: string): string {
  return filename.replace(/\.xlsx$/i, '').slice(0, 120) || 'Excel schedule';
}

function statusBadgeClass(value: string | undefined): string {
  if (value === 'صالح للمعاينة') return 'badge badge-ready';
  if (value === 'يحتوي على أخطاء' || value === 'غير صالح') return 'badge badge-error';
  if (value === 'يحتاج مراجعة') return 'badge badge-warning';
  return 'badge badge-pending';
}
