import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCog,
  ListChecks,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { schedulerFoundationApi } from '../api/client';

type NormalizationScope = 'media_roots' | 'active_schedule' | 'published_schedule';
type NormalizationDecision = 'ok' | 'remux' | 'audio-only' | 'full-transcode' | 'failed';

interface NormalizationStatus {
  outputRoot: string;
  target: {
    width: number;
    height: number;
    fps: number;
    videoCodec: string;
    pixelFormat: string;
    audioCodec: string;
    audioRate: number;
    audioChannels: number;
  };
  roots: Array<{
    rootKey: string;
    absolutePath: string;
    isReadonly: boolean;
  }>;
  latestPlan: NormalizationPlan | null;
}

interface NormalizationItem {
  id: string;
  mediaFileId: string | null;
  sourceRole: string;
  title: string;
  rootKey: string | null;
  absolutePath: string;
  relativePath: string | null;
  normalizedPath: string;
  exists: boolean;
  decision: NormalizationDecision;
  reasons: string[];
  probe: {
    durationSec: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    pixelFormat: string | null;
    audioRate: number | null;
  };
}

interface NormalizationSummary {
  total: number;
  ok: number;
  remux: number;
  audioOnly: number;
  fullTranscode: number;
  failed: number;
  canPublishNormalizedSet: boolean;
}

interface NormalizationPreflight {
  scope: NormalizationScope;
  outputRoot: string;
  items: NormalizationItem[];
  summary: NormalizationSummary;
  errors: Array<{ code: string; message: string; itemId?: string }>;
}

interface NormalizationPlan {
  id: string;
  scope: NormalizationScope;
  status: 'dry_run_ready' | 'blocked';
  outputRoot: string;
  artifactPath: string;
  summary: NormalizationSummary;
  tasks: Array<{
    id: string;
    decision: Exclude<NormalizationDecision, 'ok'>;
    inputPath: string;
    outputPath: string;
    reasons: string[];
    commandPreview: string;
  }>;
  errors: Array<{ code: string; message: string; itemId?: string }>;
  createdAt: string;
}

interface NormalizationRun {
  id: string;
  planId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  outputRoot: string;
  artifactPath: string;
  logPath: string;
  startedAt: string;
  endedAt: string | null;
  currentTaskId: string | null;
  currentFile: string | null;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  outputSizeBytes: number;
  completedCount: number;
  failedCount: number;
  totalCount: number;
  errors: Array<{ code: string; message: string; taskId?: string }>;
}

interface NormalizedSet {
  id: string;
  runId: string;
  planId: string;
  status: 'ready' | 'blocked';
  outputRoot: string;
  artifactPath: string;
  diffPath: string;
  summary: {
    total: number;
    normalizedReady: number;
    originalSafeFallback: number;
    missingNormalized: number;
    failed: number;
    canUseForPlaylist: boolean;
  };
  createdAt: string;
}

const decisionLabels: Record<NormalizationDecision, string> = {
  ok: 'ok',
  remux: 'remux',
  'audio-only': 'audio-only',
  'full-transcode': 'full-transcode',
  failed: 'failed',
};

export default function NormalizationManagerPage() {
  const [status, setStatus] = useState<NormalizationStatus | null>(null);
  const [scope, setScope] = useState<NormalizationScope>('media_roots');
  const [publishedScheduleId, setPublishedScheduleId] = useState('');
  const [includeSource, setIncludeSource] = useState(true);
  const [includeBumpers, setIncludeBumpers] = useState(true);
  const [limit, setLimit] = useState(500);
  const [preflight, setPreflight] = useState<NormalizationPreflight | null>(null);
  const [plans, setPlans] = useState<NormalizationPlan[]>([]);
  const [runs, setRuns] = useState<NormalizationRun[]>([]);
  const [sets, setSets] = useState<NormalizedSet[]>([]);
  const [loading, setLoading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [publishingSetRunId, setPublishingSetRunId] = useState<string | null>(null);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState('');
  const [executionPlanId, setExecutionPlanId] = useState('');
  const [confirmationText, setConfirmationText] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const rootKeys = useMemo(() => {
    const keys: string[] = [];
    if (includeSource) keys.push('source');
    if (includeBumpers) keys.push('bumpers');
    return keys;
  }, [includeBumpers, includeSource]);

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async () => {
    setError('');
    try {
      const [statusResponse, plansResponse] = await Promise.all([
        schedulerFoundationApi.normalizationStatus(),
        schedulerFoundationApi.listNormalizationPlans(),
      ]);
      const runsResponse = await schedulerFoundationApi.listNormalizationRuns();
      const setsResponse = await schedulerFoundationApi.listNormalizedSets();
      const statusBody = statusResponse.data as NormalizationStatus;
      const plansBody = plansResponse.data as { plans: NormalizationPlan[] };
      const runsBody = runsResponse.data as { runs: NormalizationRun[] };
      const setsBody = setsResponse.data as { sets: NormalizedSet[] };
      setStatus(statusBody);
      setPlans(plansBody.plans);
      setRuns(runsBody.runs);
      setSets(setsBody.sets);
      if (!executionPlanId && statusBody.latestPlan) setExecutionPlanId(statusBody.latestPlan.id);
      if (!selectedRunId && runsBody.runs[0]) setSelectedRunId(runsBody.runs[0].id);
    } catch {
      setError('Could not load normalization status.');
    }
  };

  const buildPayload = () => ({
    scope,
    publishedScheduleId: scope === 'published_schedule' ? publishedScheduleId.trim() : undefined,
    rootKeys: scope === 'media_roots' ? rootKeys : undefined,
    limit,
  });

  const runPreflight = async () => {
    setLoading(true);
    setMessage('');
    setError('');
    try {
      const response = await schedulerFoundationApi.normalizationPreflight(buildPayload());
      setPreflight(response.data as NormalizationPreflight);
    } catch {
      setError('Could not run normalization preflight. Check the selected scope and schedule id.');
    } finally {
      setLoading(false);
    }
  };

  const createPlan = async () => {
    setPlanning(true);
    setMessage('');
    setError('');
    try {
      const response = await schedulerFoundationApi.createNormalizationPlan({
        ...buildPayload(),
        confirmDryRun: true,
      });
      const body = response.data as { plan: NormalizationPlan };
      setMessage(`Dry-run plan created: ${body.plan.id}`);
      setExpandedPlanId(body.plan.id);
      setExecutionPlanId(body.plan.id);
      await refresh();
    } catch {
      setError('Could not create normalization dry-run plan.');
    } finally {
      setPlanning(false);
    }
  };

  const attemptExecution = async () => {
    if (!executionPlanId.trim() || startingRun) return;
    setStartingRun(true);
    setMessage('');
    setError('');
    try {
      const response = await schedulerFoundationApi.startNormalizationRun({
        planId: executionPlanId.trim(),
        confirmExecution: true,
        confirmationText,
      });
      const body = response.data as { run: NormalizationRun };
      setMessage(`Normalization run started: ${body.run.id}`);
      setSelectedRunId(body.run.id);
      await refresh();
    } catch {
      setError('Could not start normalization. Confirm text must be RUN SMART NORMALIZATION and the plan must have failed: 0.');
    } finally {
      setStartingRun(false);
    }
  };

  const stopRun = async (runId: string) => {
    setStoppingRunId(runId);
    setError('');
    try {
      await schedulerFoundationApi.stopNormalizationRun(runId);
      setMessage(`Stop requested: ${runId}`);
      await refresh();
    } catch {
      setError('Could not stop normalization run.');
    } finally {
      setStoppingRunId(null);
    }
  };

  const loadRunLog = async (runId: string) => {
    setSelectedRunId(runId);
    try {
      const response = await schedulerFoundationApi.getNormalizationRunLogs(runId, 260);
      const body = response.data as { log: { text: string } };
      setRunLog(body.log.text || 'No normalization log was written.');
    } catch {
      setRunLog('Could not load normalization log.');
    }
  };

  const publishSet = async (runId: string) => {
    setPublishingSetRunId(runId);
    setMessage('');
    setError('');
    try {
      const response = await schedulerFoundationApi.publishNormalizedSet({ runId, confirmPublish: true });
      const body = response.data as { set: NormalizedSet };
      setMessage(`Normalized set prepared: ${body.set.id}`);
      await refresh();
    } catch {
      setError('Could not prepare normalized set. The run must be completed with failedCount=0.');
    } finally {
      setPublishingSetRunId(null);
    }
  };

  const topItems = preflight?.items.slice(0, 80) ?? [];

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <FileCog size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xl font-bold">Normalization Manager</h2>
            <span className="badge badge-warning">dry-run first</span>
            <span className="badge badge-info">no FFmpeg execution</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Scan source and bumper media, classify playout risk, and prepare a reviewable plan for /srv/daawah/media/normalized-ar.
          </p>
        </div>
        <button className="btn-ghost flex items-center gap-2 text-sm" onClick={() => void refresh()}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <SummaryCard label="total" value={preflight?.summary.total ?? status?.latestPlan?.summary.total ?? 0} />
        <SummaryCard label="ok" value={preflight?.summary.ok ?? status?.latestPlan?.summary.ok ?? 0} tone="ready" />
        <SummaryCard label="remux" value={preflight?.summary.remux ?? status?.latestPlan?.summary.remux ?? 0} />
        <SummaryCard label="audio-only" value={preflight?.summary.audioOnly ?? status?.latestPlan?.summary.audioOnly ?? 0} tone="warning" />
        <SummaryCard label="full-transcode" value={preflight?.summary.fullTranscode ?? status?.latestPlan?.summary.fullTranscode ?? 0} tone="warning" />
        <SummaryCard label="failed" value={preflight?.summary.failed ?? status?.latestPlan?.summary.failed ?? 0} tone="error" />
      </section>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">Scan / Preflight</h3>
              <span className="badge badge-info">read-only</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-4 text-xs">
              <Info label="target video" value={status ? `${status.target.width}x${status.target.height} ${status.target.fps}fps ${status.target.videoCodec} ${status.target.pixelFormat}` : '-'} />
              <Info label="target audio" value={status ? `${status.target.audioCodec} ${status.target.audioRate / 1000}k stereo` : '-'} />
              <Info label="output root" value={status?.outputRoot ?? '/srv/daawah/media/normalized-ar'} />
              <Info label="acceptance" value="failed: 0" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 mt-4">
          <label className="text-xs space-y-1">
            <span style={{ color: 'var(--text-muted)' }}>Scope</span>
            <select
              className="w-full rounded-md border px-3 py-2 bg-transparent"
              style={{ borderColor: 'var(--bg-border)' }}
              value={scope}
              onChange={event => setScope(event.target.value as NormalizationScope)}
            >
              <option value="media_roots">media roots</option>
              <option value="active_schedule">active schedule</option>
              <option value="published_schedule">published schedule</option>
            </select>
          </label>
          {scope === 'published_schedule' && (
            <label className="lg:col-span-2 text-xs space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>Published schedule id</span>
              <input
                className="w-full rounded-md border px-3 py-2 bg-transparent"
                style={{ borderColor: 'var(--bg-border)' }}
                value={publishedScheduleId}
                onChange={event => setPublishedScheduleId(event.target.value)}
              />
            </label>
          )}
          {scope === 'media_roots' && (
            <div className="lg:col-span-2 rounded-md border px-3 py-2" style={{ borderColor: 'var(--bg-border)' }}>
              <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Roots</div>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={includeSource} onChange={event => setIncludeSource(event.target.checked)} />
                  source
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={includeBumpers} onChange={event => setIncludeBumpers(event.target.checked)} />
                  bumpers
                </label>
              </div>
            </div>
          )}
          <label className="text-xs space-y-1">
            <span style={{ color: 'var(--text-muted)' }}>Limit</span>
            <input
              className="w-full rounded-md border px-3 py-2 bg-transparent"
              style={{ borderColor: 'var(--bg-border)' }}
              type="number"
              min={1}
              max={5000}
              value={limit}
              onChange={event => setLimit(Number(event.target.value))}
            />
          </label>
          <div className="flex items-end gap-2">
            <button className="btn-primary flex items-center gap-2 text-sm" disabled={loading} onClick={() => void runPreflight()}>
              <ListChecks size={14} />
              {loading ? 'Scanning...' : 'Run Preflight'}
            </button>
          </div>
        </div>

        {message && <p className="text-xs mt-3" style={{ color: 'var(--success)' }}>{message}</p>}
        {error && <p className="text-xs mt-3" style={{ color: 'var(--danger)' }}>{error}</p>}
      </section>

      {preflight && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">Preflight Results</h3>
              <span className={preflight.summary.failed === 0 ? 'badge badge-ready' : 'badge badge-warning'}>
                {preflight.summary.failed === 0 ? 'validation gate clear' : 'blocked by failed files'}
              </span>
            </div>
            <button className="btn-primary flex items-center gap-2 text-sm" disabled={planning} onClick={() => void createPlan()}>
              <CheckCircle2 size={14} />
              {planning ? 'Creating Plan...' : 'Create Dry-Run Plan'}
            </button>
          </div>
          <DataTable
            empty="No media rows returned."
            headers={['File', 'Decision', 'Reasons', 'Probe', 'Output']}
            rows={topItems.map(item => [
              <span key="file" className="ltr-text break-all">{item.relativePath ?? item.title}</span>,
              <span key="decision" className={decisionBadge(item.decision)}>{decisionLabels[item.decision]}</span>,
              item.reasons.length ? item.reasons.join(', ') : '-',
              `${item.probe.width ?? '?'}x${item.probe.height ?? '?'} ${item.probe.fps ?? '?'}fps ${item.probe.videoCodec ?? '?'} / ${item.probe.audioCodec ?? '?'} ${item.probe.audioRate ?? '?'}Hz`,
              <span key="out" className="ltr-text break-all">{item.normalizedPath}</span>,
            ])}
          />
          {preflight.items.length > topItems.length && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Showing first {topItems.length} of {preflight.items.length} items.</p>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Normalize Plans</h3>
          <span className="badge badge-info">generated/normalization only</span>
        </div>
        <DataTable
          empty="No normalization plans yet."
          headers={['Plan', 'Scope', 'Status', 'Tasks', 'Failed', 'Artifact', 'Details']}
          rows={plans.map(plan => [
            plan.id,
            plan.scope,
            <span key="status" className={plan.status === 'dry_run_ready' ? 'badge badge-ready' : 'badge badge-warning'}>{plan.status}</span>,
            plan.tasks.length,
            plan.summary.failed,
            <span key="artifact" className="ltr-text break-all">{plan.artifactPath}</span>,
            <button
              key="details"
              className="btn-ghost inline-flex items-center gap-2 text-xs"
              onClick={() => setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)}
            >
              <ListChecks size={13} />
              {expandedPlanId === plan.id ? 'Hide' : 'Details'}
            </button>,
          ])}
        />
        {plans.map(plan => (
          expandedPlanId === plan.id && (
            <div key={plan.id} className="rounded-md border p-3 text-xs space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
              <div className="flex flex-wrap gap-2">
                <span className="badge badge-info">ffmpeg execution: false</span>
                <span className="badge badge-info">normalized media writes: false</span>
                <span className="badge badge-info">original media modification: false</span>
                <span className="badge badge-info">broadcast: false</span>
              </div>
              {plan.errors.length > 0 && (
                <div className="rounded-md border p-3" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                  {plan.errors.slice(0, 8).map(issue => <div key={`${issue.code}-${issue.itemId ?? issue.message}`}>{issue.code}: {issue.message}</div>)}
                </div>
              )}
              <pre className="rounded-md border p-3 overflow-x-auto" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                {plan.tasks[0]?.commandPreview ?? 'No normalization tasks required.'}
              </pre>
            </div>
          )
        ))}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center gap-2">
          <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
          <h3 className="font-semibold">Run Smart Normalization</h3>
          <span className="badge badge-warning">writes normalized media only</span>
          <span className="badge badge-info">no playlist activation</span>
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          Starts a background job from a dry-run-ready plan. Outputs stay inside the normalized media root and originals are never modified.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 mt-4">
          <input
            className="rounded-md border px-3 py-2 bg-transparent ltr-text"
            style={{ borderColor: 'var(--bg-border)' }}
            value={executionPlanId}
            placeholder="plan id"
            onChange={event => setExecutionPlanId(event.target.value)}
          />
          <input
            className="lg:col-span-2 rounded-md border px-3 py-2 bg-transparent"
            style={{ borderColor: 'var(--bg-border)' }}
            value={confirmationText}
            placeholder="RUN SMART NORMALIZATION"
            onChange={event => setConfirmationText(event.target.value)}
          />
          <button
            className="btn-ghost flex items-center gap-2 text-sm"
            disabled={!executionPlanId.trim() || confirmationText !== 'RUN SMART NORMALIZATION' || startingRun}
            onClick={() => void attemptExecution()}
          >
            {confirmationText === 'RUN SMART NORMALIZATION' ? <Play size={14} /> : <XCircle size={14} />}
            {startingRun ? 'Starting...' : 'Start'}
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Normalization Runs</h3>
          <span className="badge badge-info">progress and logs</span>
        </div>
        <DataTable
          empty="No normalization runs yet."
          headers={['Run', 'Status', 'Progress', 'Current file', 'Output size', 'Actions']}
          rows={runs.map(run => [
            <span key="id" className="ltr-text">{run.id}</span>,
            <span key="status" className={run.status === 'completed' ? 'badge badge-ready' : run.status === 'failed' ? 'badge badge-error' : run.status === 'stopped' ? 'badge badge-warning' : 'badge badge-info'}>{run.status}</span>,
            `${run.completedCount}/${run.totalCount} failed ${run.failedCount}`,
            <span key="file" className="ltr-text break-all">{run.currentFile ?? '-'}</span>,
            formatBytes(run.outputSizeBytes),
            <div key="actions" className="flex flex-wrap gap-2">
              <button className="btn-ghost inline-flex items-center gap-2 text-xs" onClick={() => void loadRunLog(run.id)}>
                <ListChecks size={13} />
                Logs
              </button>
              {run.status === 'running' && (
                <button className="btn-danger inline-flex items-center gap-2 text-xs" disabled={stoppingRunId === run.id} onClick={() => void stopRun(run.id)}>
                  Stop
                </button>
              )}
              {run.status === 'completed' && run.failedCount === 0 && (
                <button className="btn-primary inline-flex items-center gap-2 text-xs" disabled={publishingSetRunId === run.id} onClick={() => void publishSet(run.id)}>
                  Publish Set
                </button>
              )}
            </div>,
          ])}
        />
        {selectedRunId && (
          <div className="rounded-md border p-3 text-xs space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
            {runs.filter(run => run.id === selectedRunId).map(run => (
              <div key={run.id} className="grid grid-cols-1 lg:grid-cols-5 gap-3">
                <Info label="elapsed" value={`${run.elapsedSeconds}s`} />
                <Info label="remaining" value={run.estimatedRemainingSeconds === null ? '-' : `${run.estimatedRemainingSeconds}s`} />
                <Info label="artifact" value={run.artifactPath} />
                <Info label="log" value={run.logPath} />
                <Info label="output root" value={run.outputRoot} />
              </div>
            ))}
            {runLog && (
              <pre className="rounded-md border p-3 overflow-x-auto max-h-96" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                {runLog}
              </pre>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Published Normalized Sets</h3>
          <span className="badge badge-info">mapping and diff only</span>
        </div>
        <DataTable
          empty="No normalized sets prepared yet."
          headers={['Set', 'Status', 'Ready', 'Original safe', 'Missing', 'Artifacts']}
          rows={sets.map(set => [
            <span key="id" className="ltr-text">{set.id}</span>,
            <span key="status" className={set.status === 'ready' ? 'badge badge-ready' : 'badge badge-warning'}>{set.status}</span>,
            `${set.summary.normalizedReady}/${set.summary.total}`,
            set.summary.originalSafeFallback,
            set.summary.missingNormalized,
            <div key="artifacts" className="text-xs ltr-text break-all">
              <div>{set.artifactPath}</div>
              <div>{set.diffPath}</div>
            </div>,
          ])}
        />
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

function Info({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="font-medium break-all">{value}</div>
    </div>
  );
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: unknown[][]; empty: string }) {
  if (rows.length === 0) {
    return <div className="rounded-md border p-4 text-center text-sm" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>{empty}</div>;
  }
  return (
    <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--bg-border)' }}>
      <table className="w-full text-sm">
        <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
          <tr>
            {headers.map(header => <th key={header} className="text-right px-3 py-2 font-medium whitespace-nowrap">{header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t" style={{ borderColor: 'var(--bg-border)' }}>
              {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top max-w-sm">{cell as React.ReactNode}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function decisionBadge(decision: NormalizationDecision): string {
  if (decision === 'ok') return 'badge badge-ready';
  if (decision === 'failed') return 'badge badge-warning';
  if (decision === 'full-transcode') return 'badge badge-warning';
  return 'badge badge-info';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
