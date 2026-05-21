import { useMemo, useRef, useState } from 'react';
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
  const [draftMessage, setDraftMessage] = useState('');
  const [error, setError] = useState('');

  const completedStep = draftMessage ? 7 : preview ? 6 : selectedFile ? 1 : 0;
  const summary = preview?.summary;
  const issueGroups = useMemo(() => groupIssues(preview?.issues ?? []), [preview]);

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
