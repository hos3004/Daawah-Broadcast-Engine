import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  Filter,
  FolderSearch,
  ListChecks,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { schedulerFoundationApi } from '../api/client';

type IssueSeverity = 'error' | 'warning' | 'info';
type IssueFilter = 'all' | 'warnings' | 'errors';

interface DraftIssue {
  severity: IssueSeverity;
  code: string;
  sheet: string;
  row?: number;
  field?: string;
  message: string;
}

interface DraftProgram {
  program_key: string;
  program_name: string;
  folder_root: string;
  folder_hint: string;
  status?: string;
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
  message: string;
}

interface PreviewRow {
  type: 'slot' | 'gap';
  row: number | null;
  program_key: string | null;
  title: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
}

interface PreviewDay {
  date: string;
  day: string;
  rows: PreviewRow[];
}

interface DraftDetail {
  id: string;
  name: string;
  status: 'draft';
  isActive: false;
  scheduleStartDate: string;
  scheduleEndDate: string;
  timezone: string;
  sourceExcelFilename: string;
  sourceExcelSha256: string;
  validationSummary: {
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
  programCount: number;
  slotCount: number;
  createdAt: string;
  updatedAt: string;
  programs: DraftProgram[];
  folderMatches: FolderMatch[];
  issues: DraftIssue[];
  schedulePreview: {
    timezone: string;
    gapPattern: string;
    truncated: boolean;
    days: PreviewDay[];
  };
  willActivateSchedule: false;
  willUpdateCursors: false;
  willMaterializePlaylist: false;
}

export default function SchedulerDraftReviewPage() {
  const { draftId } = useParams();
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dayFilter, setDayFilter] = useState('all');
  const [programFilter, setProgramFilter] = useState('all');
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('all');

  useEffect(() => {
    if (!draftId) {
      setError('Draft id is missing.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    schedulerFoundationApi.getDraftSchedule(draftId)
      .then(response => {
        const body = response.data as { draft: DraftDetail };
        setDraft(body.draft);
      })
      .catch(() => setError('Could not load draft schedule details.'))
      .finally(() => setLoading(false));
  }, [draftId]);

  const programs = useMemo(() => {
    const rows = draft?.programs ?? [];
    return rows
      .map(program => ({
        key: program.program_key,
        name: program.program_name || program.program_key,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [draft]);

  const totals = useMemo(() => {
    const rows = draft?.schedulePreview.days.flatMap(day => day.rows) ?? [];
    return rows.reduce(
      (acc, row) => {
        if (row.type === 'gap') acc.gapMinutes += row.duration_minutes || 0;
        else acc.scheduledMinutes += row.duration_minutes || 0;
        return acc;
      },
      { scheduledMinutes: 0, gapMinutes: 0 }
    );
  }, [draft]);

  const folderCounts = useMemo(() => {
    return (draft?.folderMatches ?? []).reduce<Record<string, number>>((acc, match) => {
      acc[match.status] = (acc[match.status] ?? 0) + 1;
      return acc;
    }, {});
  }, [draft]);

  const visibleDays = useMemo(() => {
    const days = draft?.schedulePreview.days ?? [];
    return days
      .filter(day => dayFilter === 'all' || day.date === dayFilter)
      .map(day => ({
        ...day,
        rows: day.rows.filter(row => programFilter === 'all' || row.program_key === programFilter),
      }))
      .filter(day => day.rows.length > 0);
  }, [dayFilter, draft, programFilter]);

  const filteredIssues = useMemo(() => {
    const issues = draft?.issues ?? [];
    if (issueFilter === 'errors') return issues.filter(issue => issue.severity === 'error');
    if (issueFilter === 'warnings') return issues.filter(issue => issue.severity === 'warning');
    return issues;
  }, [draft, issueFilter]);

  if (loading) {
    return <div className="card text-center py-10" style={{ color: 'var(--text-muted)' }}>Loading draft review...</div>;
  }

  if (error || !draft) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="card text-center py-10" style={{ color: 'var(--danger)' }}>
          {error || 'Draft schedule was not found.'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <BackLink />
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <ShieldCheck size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xl font-bold">{draft.name}</h2>
            <span className="badge badge-pending">draft review</span>
            <span className="badge badge-info">inactive</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Review only. This screen does not publish, activate, materialize playlists, update cursors, or run playout.
          </p>
        </div>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <MetricCard label="Status" value={draft.status} tone="info" />
        <MetricCard label="Active" value={draft.isActive ? 'yes' : 'no'} tone={draft.isActive ? 'error' : 'ready'} />
        <MetricCard label="Programs" value={draft.programCount} />
        <MetricCard label="Slots" value={draft.slotCount} />
        <MetricCard label="Scheduled time" value={formatMinutes(totals.scheduledMinutes)} />
        <MetricCard label="Gap time" value={formatMinutes(totals.gapMinutes)} tone={totals.gapMinutes > 0 ? 'warning' : 'ready'} />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <InfoPanel
          icon={CalendarDays}
          title="Schedule"
          rows={[
            ['Date range', `${draft.scheduleStartDate} to ${draft.scheduleEndDate}`],
            ['Timezone', draft.timezone],
            ['Created', draft.createdAt],
            ['Updated', draft.updatedAt],
          ]}
        />
        <InfoPanel
          icon={ListChecks}
          title="Validation"
          rows={[
            ['File status', draft.validationSummary.fileStatus],
            ['Errors', draft.validationSummary.errors],
            ['Warnings', draft.validationSummary.warnings],
            ['Conflicts', draft.validationSummary.conflicts],
          ]}
        />
        <InfoPanel
          icon={FileSpreadsheet}
          title="Source Excel"
          rows={[
            ['Filename', draft.sourceExcelFilename],
            ['SHA-256', <span className="ltr-text break-all">{draft.sourceExcelSha256}</span>],
            ['Activation flag', draft.willActivateSchedule ? 'true' : 'false'],
            ['Cursor flag', draft.willUpdateCursors ? 'true' : 'false'],
          ]}
        />
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Filter size={16} style={{ color: 'var(--accent)' }} />
            <h3 className="font-semibold">Filters</h3>
          </div>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Filters affect the timeline and issue tables only.
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <SelectField label="Day" value={dayFilter} onChange={setDayFilter}>
            <option value="all">All days</option>
            {draft.schedulePreview.days.map(day => (
              <option key={day.date} value={day.date}>{day.date}</option>
            ))}
          </SelectField>
          <SelectField label="Program" value={programFilter} onChange={setProgramFilter}>
            <option value="all">All programs</option>
            {programs.map(program => (
              <option key={program.key} value={program.key}>{program.name}</option>
            ))}
          </SelectField>
          <SelectField label="Issues" value={issueFilter} onChange={value => setIssueFilter(value as IssueFilter)}>
            <option value="all">All issues</option>
            <option value="warnings">Warnings only</option>
            <option value="errors">Errors only</option>
          </SelectField>
        </div>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard label="Matched folders" value={folderCounts.matched ?? 0} tone="ready" />
        <MetricCard label="Needs review" value={folderCounts.needs_review ?? 0} tone="warning" />
        <MetricCard label="Missing folders" value={folderCounts.folder_missing ?? 0} tone="warning" />
        <MetricCard label="Rejected folders" value={folderCounts.rejected ?? 0} tone="error" />
        <MetricCard label="Folder errors" value={folderCounts.error ?? 0} tone="error" />
      </section>

      <section className="space-y-3">
        <SectionTitle icon={Clock3} title="Timeline Preview" detail={`${visibleDays.length} day(s) shown`} />
        {visibleDays.length === 0 ? (
          <div className="card text-center py-8" style={{ color: 'var(--text-muted)' }}>No timeline rows match the current filters.</div>
        ) : visibleDays.map(day => (
          <div key={day.date} className="card p-0 overflow-hidden">
            <div className="px-4 py-3 font-semibold" style={{ borderBottom: '1px solid var(--bg-border)' }}>
              {day.date}
            </div>
            <DataTable
              framed={false}
              headers={['Type', 'Start', 'End', 'Duration', 'Program', 'Title']}
              rows={day.rows.map(row => [
                <span key="type" className={`badge ${row.type === 'gap' ? 'badge-warning' : 'badge-ready'}`}>{row.type}</span>,
                row.start_time,
                row.end_time,
                `${row.duration_minutes}m`,
                <span key="program" className="ltr-text">{row.program_key ?? '-'}</span>,
                row.title,
              ])}
            />
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <SectionTitle icon={FolderSearch} title="Folder Matches" detail={`${draft.folderMatches.length} program folder match(es)`} />
        <DataTable
          headers={['Program', 'Root', 'Hint', 'Status', 'Confidence', 'Matched path', 'Message']}
          rows={draft.folderMatches.map(match => [
            <span key="program" className="ltr-text">{match.program_key}</span>,
            match.folder_root,
            match.folder_hint,
            <FolderStatus key="status" status={match.status} label={match.status_ar} />,
            `${match.confidence}%`,
            match.matched_relative_path ?? '-',
            match.message,
          ])}
        />
      </section>

      <section className="space-y-3">
        <SectionTitle icon={AlertTriangle} title="Warnings And Issues" detail={`${filteredIssues.length} issue(s) shown`} />
        <DataTable
          empty="No issues match the current filter."
          headers={['Severity', 'Code', 'Sheet', 'Row', 'Field', 'Message']}
          rows={filteredIssues.map(issue => [
            <Severity key="severity" severity={issue.severity} />,
            issue.code,
            issue.sheet,
            issue.row ?? '-',
            issue.field ?? '-',
            issue.message,
          ])}
        />
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/scheduler-foundation" className="btn-ghost inline-flex items-center gap-2 text-sm">
      <ArrowRight size={14} />
      Back to drafts
    </Link>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ready' | 'warning' | 'error' | 'info' }) {
  const color =
    tone === 'ready' ? 'var(--success)' :
    tone === 'warning' ? 'var(--warning)' :
    tone === 'error' ? 'var(--danger)' :
    tone === 'info' ? 'var(--accent)' :
    'var(--text-primary)';

  return (
    <div className="card">
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-xl font-bold mt-1 break-words" style={{ color }}>{value}</div>
    </div>
  );
}

function InfoPanel({ icon: Icon, title, rows }: {
  icon: LucideIcon;
  title: string;
  rows: Array<[string, ReactNode]>;
}) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} style={{ color: 'var(--accent)' }} />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="space-y-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label}>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
            <div className="font-medium mt-1 break-words">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SelectField({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
      >
        {children}
      </select>
    </label>
  );
}

function SectionTitle({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Icon size={16} style={{ color: 'var(--accent)' }} />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{detail}</span>
    </div>
  );
}

function DataTable({ headers, rows, empty = 'No rows to display.', framed = true }: {
  headers: string[];
  rows: Array<Array<ReactNode>>;
  empty?: string;
  framed?: boolean;
}) {
  return (
    <div className={`${framed ? 'card' : ''} p-0 overflow-x-auto`}>
      <table className="w-full min-w-[960px] text-sm">
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
                <td key={cellIndex} className="px-4 py-3 align-top max-w-96 break-words">
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

function FolderStatus({ status, label }: { status: FolderMatch['status']; label: string }) {
  const cls =
    status === 'matched' ? 'badge-ready' :
    status === 'needs_review' || status === 'folder_missing' ? 'badge-warning' :
    'badge-error';
  return <span className={`badge ${cls}`}>{label || status}</span>;
}

function Severity({ severity }: { severity: IssueSeverity }) {
  if (severity === 'error') {
    return <span className="flex items-center gap-1" style={{ color: 'var(--danger)' }}><XCircle size={14} /> error</span>;
  }
  if (severity === 'warning') {
    return <span className="flex items-center gap-1" style={{ color: 'var(--warning)' }}><AlertTriangle size={14} /> warning</span>;
  }
  return <span className="flex items-center gap-1" style={{ color: 'var(--success)' }}><CheckCircle2 size={14} /> info</span>;
}

function formatMinutes(totalMinutes: number): string {
  const minutes = Math.round(totalMinutes);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h ${remainder.toString().padStart(2, '0')}m`;
}
