import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  FolderSearch,
  ListChecks,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { schedulerFoundationApi } from '../api/client';

type IssueSeverity = 'error' | 'warning' | 'info';

interface ScheduleIssue {
  severity: IssueSeverity;
  code: string;
  sheet?: string;
  row?: number;
  field?: string;
  message: string;
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

interface PublishedScheduleDetail {
  id: string;
  sourceDraftId: string;
  name: string;
  status: 'published';
  isActive: boolean;
  validationStatus: 'draft_valid';
  validationErrors: ScheduleIssue[];
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
  publishedBy: string | null;
  publishedAt: string;
  createdAt: string;
  folderMatches: FolderMatch[];
  issues: ScheduleIssue[];
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

export default function SchedulerPublishedReviewPage() {
  const { publishedId } = useParams();
  const [schedule, setSchedule] = useState<PublishedScheduleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    if (!publishedId) {
      setError('Published schedule id is missing.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    setActionError('');
    setActionMessage('');
    schedulerFoundationApi.getPublishedSchedule(publishedId)
      .then(response => {
        const body = response.data as { publishedSchedule: PublishedScheduleDetail };
        setSchedule(body.publishedSchedule);
      })
      .catch(() => setError('Could not load published schedule details.'))
      .finally(() => setLoading(false));
  }, [publishedId]);

  const totals = useMemo(() => {
    const rows = schedule?.schedulePreview.days.flatMap(day => day.rows) ?? [];
    return rows.reduce(
      (acc, row) => {
        if (row.type === 'gap') acc.gapMinutes += row.duration_minutes || 0;
        else acc.scheduledMinutes += row.duration_minutes || 0;
        return acc;
      },
      { scheduledMinutes: 0, gapMinutes: 0 }
    );
  }, [schedule]);

  const canActivate = Boolean(
    schedule &&
    !schedule.isActive &&
    schedule.status === 'published' &&
    schedule.validationStatus === 'draft_valid' &&
    schedule.validationErrors.length === 0 &&
    schedule.validationSummary.errors === 0 &&
    schedule.validationSummary.conflicts === 0
  );

  const activateSchedule = async () => {
    if (!schedule || !canActivate || activating) return;
    const requiredText = `ACTIVATE SCHEDULE ${schedule.id}`;
    const confirmed = window.confirm(
      `Activate "${schedule.name}"?\n\nThis only marks the published schedule active in the database. It will not materialize playlists, update cursors, start playout, or broadcast.`
    );
    if (!confirmed) return;
    const typedText = window.prompt(`Type exactly to confirm:\n${requiredText}`);
    if (typedText === null) return;

    setActivating(true);
    setActionError('');
    setActionMessage('');
    try {
      const response = await schedulerFoundationApi.activatePublishedSchedule(schedule.id, {
        scheduleId: schedule.id,
        confirmActivation: true,
        confirmationText: typedText,
      });
      const body = response.data as { activeSchedule: PublishedScheduleDetail; previousPublishedScheduleId: string | null };
      setSchedule(body.activeSchedule);
      setActionMessage(
        body.previousPublishedScheduleId
          ? `Activated schedule. Previous active schedule: ${body.previousPublishedScheduleId}`
          : 'Activated schedule. There was no previous active schedule.'
      );
    } catch {
      setActionError('Could not activate this schedule. Confirm the typed text and validation status.');
    } finally {
      setActivating(false);
    }
  };

  const folderCounts = useMemo(() => {
    return (schedule?.folderMatches ?? []).reduce<Record<string, number>>((acc, match) => {
      acc[match.status] = (acc[match.status] ?? 0) + 1;
      return acc;
    }, {});
  }, [schedule]);

  if (loading) {
    return <div className="card text-center py-10" style={{ color: 'var(--text-muted)' }}>Loading published schedule...</div>;
  }

  if (error || !schedule) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="card text-center py-10" style={{ color: 'var(--danger)' }}>
          {error || 'Published schedule was not found.'}
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
            <h2 className="text-xl font-bold">{schedule.name}</h2>
            <span className="badge badge-ready">published</span>
            <span className={`badge ${schedule.isActive ? 'badge-ready' : 'badge-info'}`}>
              {schedule.isActive ? 'active' : 'inactive'}
            </span>
            <span className="badge badge-ready">{schedule.validationStatus}</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Activation only marks this published schedule active. It does not materialize playlists, update cursors, run playout, or broadcast.
          </p>
          {actionMessage && <p className="text-xs mt-2" style={{ color: 'var(--success)' }}>{actionMessage}</p>}
          {actionError && <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{actionError}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canActivate && (
            <button
              className="btn-primary inline-flex items-center gap-2 text-sm"
              disabled={activating}
              onClick={() => void activateSchedule()}
            >
              <CheckCircle2 size={14} />
              {activating ? 'Activating...' : 'Activate Schedule'}
            </button>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <MetricCard label="Status" value={schedule.status} tone="ready" />
        <MetricCard label="Active" value={schedule.isActive ? 'yes' : 'no'} tone={schedule.isActive ? 'error' : 'info'} />
        <MetricCard label="Programs" value={schedule.programCount} />
        <MetricCard label="Slots" value={schedule.slotCount} />
        <MetricCard label="Scheduled time" value={formatMinutes(totals.scheduledMinutes)} />
        <MetricCard label="Gap time" value={formatMinutes(totals.gapMinutes)} tone={totals.gapMinutes > 0 ? 'warning' : 'ready'} />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <InfoPanel
          icon={CalendarDays}
          title="Schedule"
          rows={[
            ['Date range', `${schedule.scheduleStartDate} to ${schedule.scheduleEndDate}`],
            ['Timezone', schedule.timezone],
            ['Published', schedule.publishedAt],
            ['Published by', schedule.publishedBy ?? '-'],
          ]}
        />
        <InfoPanel
          icon={ListChecks}
          title="Validation"
          rows={[
            ['Validation status', schedule.validationStatus],
            ['Stored validation errors', schedule.validationErrors.length],
            ['Errors', schedule.validationSummary.errors],
            ['Warnings', schedule.validationSummary.warnings],
            ['Conflicts', schedule.validationSummary.conflicts],
          ]}
        />
        <InfoPanel
          icon={FileSpreadsheet}
          title="Source"
          rows={[
            ['Source draft', <span className="ltr-text break-all">{schedule.sourceDraftId}</span>],
            ['Excel filename', schedule.sourceExcelFilename],
            ['Excel SHA-256', <span className="ltr-text break-all">{schedule.sourceExcelSha256}</span>],
            ['Activation flag', schedule.willActivateSchedule ? 'true' : 'false'],
          ]}
        />
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard label="Matched folders" value={folderCounts.matched ?? 0} tone="ready" />
        <MetricCard label="Needs review" value={folderCounts.needs_review ?? 0} tone="warning" />
        <MetricCard label="Missing folders" value={folderCounts.folder_missing ?? 0} tone="warning" />
        <MetricCard label="Rejected folders" value={folderCounts.rejected ?? 0} tone="error" />
        <MetricCard label="Folder errors" value={folderCounts.error ?? 0} tone="error" />
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
          <span>Activation status is stored separately from playlist materialization and playout.</span>
          <span className="badge badge-info">materialize playlists: false</span>
          <span className="badge badge-info">cursor updates: false</span>
          <span className="badge badge-info">playout: false</span>
          <span className="badge badge-info">broadcast: false</span>
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle icon={Clock3} title="Timeline Preview" detail={`${schedule.schedulePreview.days.length} day(s) shown`} />
        {schedule.schedulePreview.days.map(day => (
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
        <SectionTitle icon={FolderSearch} title="Folder Matches" detail={`${schedule.folderMatches.length} program folder match(es)`} />
        <DataTable
          headers={['Program', 'Root', 'Hint', 'Status', 'Confidence', 'Matched path', 'Message']}
          rows={schedule.folderMatches.map(match => [
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
        <SectionTitle icon={AlertTriangle} title="Warnings And Issues" detail={`${schedule.issues.length} issue(s)`} />
        <DataTable
          empty="No issues recorded for this published schedule."
          headers={['Severity', 'Code', 'Sheet', 'Row', 'Field', 'Message']}
          rows={schedule.issues.map(issue => [
            <Severity key="severity" severity={issue.severity} />,
            issue.code,
            issue.sheet ?? '-',
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
      Back to scheduler foundation
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
