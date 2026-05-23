import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  ListChecks,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { schedulerFoundationApi } from '../api/client';

type OutputMode = 'local_file' | 'localhost_hls';

interface TestPlayoutPlan {
  id: string;
  sourcePlaylistPath: string;
  outputMode: OutputMode;
  outputPath: string;
  durationLimitSeconds: number;
  status: 'planned';
  commandPreview: {
    command: string;
    overlays: {
      enabled: boolean;
      logoEnabled: boolean;
      tickerEnabled: boolean;
      tickerAssPath: string | null;
    };
  };
  warnings: Array<{ code: string; message: string }>;
  errors: Array<{ code: string; message: string }>;
  createdAt: string;
}

interface TestPlayoutRun {
  id: string;
  sourcePlaylistPath: string;
  outputMode: OutputMode;
  outputPath: string;
  durationLimitSeconds: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  artifacts: {
    runDir: string;
    statusPath: string;
    reportPath: string;
    ffmpegLogPath: string;
  };
  monitoring: {
    heartbeatAt: string;
    status: string;
    elapsedSeconds: number;
    ffmpegStatus: string;
    output: {
      mode: OutputMode;
      path: string;
      exists: boolean;
      sizeBytes: number | null;
      hlsSegmentCount: number | null;
    };
  };
  errors: Array<{ code: string; message: string }>;
}

export default function TestPlayoutPage() {
  const [sourcePlaylistPath, setSourcePlaylistPath] = useState('');
  const [outputMode, setOutputMode] = useState<OutputMode>('local_file');
  const [durationLimitSeconds, setDurationLimitSeconds] = useState(120);
  const [useOverlays, setUseOverlays] = useState(false);
  const [overlayDate, setOverlayDate] = useState('');
  const [confirmationText, setConfirmationText] = useState('');
  const [plans, setPlans] = useState<TestPlayoutPlan[]>([]);
  const [runs, setRuns] = useState<TestPlayoutRun[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState('');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const selectedPlan = useMemo(
    () => plans.find(plan => plan.id === selectedPlanId) ?? null,
    [plans, selectedPlanId]
  );
  const selectedRun = useMemo(
    () => runs.find(run => run.id === selectedRunId) ?? null,
    [runs, selectedRunId]
  );

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async () => {
    setError('');
    try {
      const [plansResponse, runsResponse] = await Promise.all([
        schedulerFoundationApi.listTestPlayoutPlans(),
        schedulerFoundationApi.listTestPlayoutRuns(),
      ]);
      const nextPlans = (plansResponse.data as { plans: TestPlayoutPlan[] }).plans;
      const nextRuns = (runsResponse.data as { runs: TestPlayoutRun[] }).runs;
      setPlans(nextPlans);
      setRuns(nextRuns);
      if (!selectedPlanId && nextPlans[0]) setSelectedPlanId(nextPlans[0].id);
      if (!selectedRunId && nextRuns[0]) setSelectedRunId(nextRuns[0].id);
    } catch {
      setError('Could not load test playout state.');
    }
  };

  const createPlan = async () => {
    setLoading(true);
    setMessage('');
    setError('');
    try {
      const response = await schedulerFoundationApi.createTestPlayoutPlan({
        confirmPrepareOnly: true,
        sourcePlaylistPath: sourcePlaylistPath.trim(),
        outputMode,
        durationLimitSeconds,
        useControlPanelOverlays: useOverlays,
        overlayDate: overlayDate.trim() || undefined,
      });
      const body = response.data as { plan: TestPlayoutPlan };
      setMessage(`Plan prepared: ${body.plan.id}`);
      setSelectedPlanId(body.plan.id);
      await refresh();
    } catch {
      setError('Could not prepare the plan. Use generated/playlists/<runId>/playlist.json and file-expanded media.');
    } finally {
      setLoading(false);
    }
  };

  const fillFromPlan = (plan: TestPlayoutPlan) => {
    setSourcePlaylistPath(plan.sourcePlaylistPath);
    setOutputMode(plan.outputMode);
    setDurationLimitSeconds(plan.durationLimitSeconds);
    setSelectedPlanId(plan.id);
  };

  const runSelectedPlan = async () => {
    const plan = selectedPlan;
    if (!plan) return;
    setRunning(true);
    setMessage('');
    setError('');
    setRunLog('');
    try {
      const response = await schedulerFoundationApi.runTestPlayout({
        confirmExecution: true,
        confirmationText,
        sourcePlaylistPath: plan.sourcePlaylistPath,
        outputMode: plan.outputMode,
        durationLimitSeconds: plan.durationLimitSeconds,
        useControlPanelOverlays: useOverlays,
        overlayDate: overlayDate.trim() || undefined,
      });
      const body = response.data as { run: TestPlayoutRun };
      setMessage(`Run finished: ${body.run.status}`);
      setSelectedRunId(body.run.id);
      await refresh();
      await loadRunLog(body.run.id);
    } catch {
      setError('Could not run isolated test playout. Confirm text must be RUN ISOLATED TEST PLAYOUT and FFmpeg/media must be available.');
    } finally {
      setRunning(false);
    }
  };

  const loadRunLog = async (runId: string) => {
    setSelectedRunId(runId);
    try {
      const response = await schedulerFoundationApi.getTestPlayoutRunLogs(runId, 240);
      const body = response.data as { log: { text: string } };
      setRunLog(body.log.text || 'No FFmpeg log was written.');
    } catch {
      setRunLog('Could not load FFmpeg log.');
    }
  };

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Play size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xl font-bold">Test Playout</h2>
            <span className="badge badge-warning">isolated only</span>
            <span className="badge badge-info">no RTMP</span>
            <span className="badge badge-info">generated/test-playout</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Prepare and run a short local-only playout from generated playlist artifacts without touching production broadcast.
          </p>
        </div>
        <button className="btn-ghost flex items-center gap-2 text-sm" onClick={() => void refresh()}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Metric label="plans" value={plans.length} />
        <Metric label="runs" value={runs.length} />
        <Metric label="completed" value={runs.filter(run => run.status === 'completed').length} tone="ready" />
        <Metric label="failed" value={runs.filter(run => run.status === 'failed').length} tone="error" />
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
          <h3 className="font-semibold">Prepare Plan</h3>
          <span className="badge badge-info">validates playlist before execution</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-6 gap-3">
          <label className="lg:col-span-3 text-xs space-y-1">
            <span style={{ color: 'var(--text-muted)' }}>Dry-run playlist path</span>
            <input
              className="w-full rounded-md border px-3 py-2 bg-transparent ltr-text"
              style={{ borderColor: 'var(--bg-border)' }}
              value={sourcePlaylistPath}
              placeholder="generated/playlists/<runId>/playlist.json"
              onChange={event => setSourcePlaylistPath(event.target.value)}
            />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: 'var(--text-muted)' }}>Output mode</span>
            <select
              className="w-full rounded-md border px-3 py-2 bg-transparent"
              style={{ borderColor: 'var(--bg-border)' }}
              value={outputMode}
              onChange={event => setOutputMode(event.target.value as OutputMode)}
            >
              <option value="local_file">local file</option>
              <option value="localhost_hls">localhost HLS</option>
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: 'var(--text-muted)' }}>Seconds</span>
            <input
              className="w-full rounded-md border px-3 py-2 bg-transparent"
              style={{ borderColor: 'var(--bg-border)' }}
              type="number"
              min={1}
              max={1200}
              value={durationLimitSeconds}
              onChange={event => setDurationLimitSeconds(Number(event.target.value))}
            />
          </label>
          <div className="flex items-end">
            <button
              className="btn-primary flex items-center gap-2 text-sm w-full justify-center"
              disabled={!sourcePlaylistPath.trim() || loading}
              onClick={() => void createPlan()}
            >
              <ListChecks size={14} />
              {loading ? 'Preparing...' : 'Prepare'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useOverlays} onChange={event => setUseOverlays(event.target.checked)} />
            Use control-panel overlays
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: 'var(--text-muted)' }}>Overlay date</span>
            <input
              className="w-full rounded-md border px-3 py-2 bg-transparent"
              style={{ borderColor: 'var(--bg-border)' }}
              type="date"
              value={overlayDate}
              onChange={event => setOverlayDate(event.target.value)}
            />
          </label>
        </div>

        {message && <p className="text-xs mt-3" style={{ color: 'var(--success)' }}>{message}</p>}
        {error && <p className="text-xs mt-3" style={{ color: 'var(--danger)' }}>{error}</p>}
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Plans</h3>
            <span className="badge badge-info">plan first</span>
          </div>
          <DataTable
            empty="No test playout plans yet."
            headers={['Plan', 'Mode', 'Seconds', 'Output', 'Action']}
            rows={plans.map(plan => [
              <button key="id" className="btn-ghost text-xs ltr-text" onClick={() => fillFromPlan(plan)}>{plan.id}</button>,
              plan.outputMode,
              plan.durationLimitSeconds,
              <span key="out" className="ltr-text break-all">{plan.outputPath}</span>,
              <button key="select" className="btn-primary inline-flex items-center gap-2 text-xs" onClick={() => fillFromPlan(plan)}>
                <Eye size={13} />
                Select
              </button>,
            ])}
          />
          {selectedPlan && (
            <div className="rounded-md border p-3 text-xs space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
              <div className="flex flex-wrap gap-2">
                <span className="badge badge-info">ffmpeg execution: false until run</span>
                <span className="badge badge-info">broadcast: false</span>
                <span className="badge badge-info">RTMP: false</span>
              </div>
              <pre className="rounded-md border p-3 overflow-x-auto" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                {selectedPlan.commandPreview.command}
              </pre>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Run Selected Plan</h3>
            <span className="badge badge-warning">requires typed confirmation</span>
          </div>
          <div className="rounded-md border p-4 space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 text-xs">
              <Info label="selected plan" value={selectedPlan?.id ?? '-'} />
              <Info label="output" value={selectedPlan?.outputMode ?? '-'} />
              <Info label="duration" value={selectedPlan ? `${selectedPlan.durationLimitSeconds}s` : '-'} />
            </div>
            <input
              className="w-full rounded-md border px-3 py-2 bg-transparent"
              style={{ borderColor: confirmationText === 'RUN ISOLATED TEST PLAYOUT' ? 'var(--success)' : 'var(--bg-border)' }}
              value={confirmationText}
              placeholder="RUN ISOLATED TEST PLAYOUT"
              onChange={event => setConfirmationText(event.target.value)}
            />
            <button
              className="btn-primary flex items-center gap-2 text-sm"
              disabled={!selectedPlan || confirmationText !== 'RUN ISOLATED TEST PLAYOUT' || running}
              onClick={() => void runSelectedPlan()}
            >
              <Play size={14} />
              {running ? 'Running FFmpeg...' : 'Run Short Test'}
            </button>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="badge badge-info">cursor mutation: false</span>
              <span className="badge badge-info">broadcast started: false</span>
              <span className="badge badge-info">stream key usage: false</span>
              <span className="badge badge-info">production paths: false</span>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Runs</h3>
          <span className="badge badge-info">read-only artifacts</span>
        </div>
        <DataTable
          empty="No isolated test playout runs yet."
          headers={['Run', 'Status', 'Output', 'Elapsed', 'Exit', 'Logs']}
          rows={runs.map(run => [
            <span key="id" className="ltr-text">{run.id}</span>,
            <span key="status" className={run.status === 'completed' ? 'badge badge-ready' : run.status === 'failed' ? 'badge badge-error' : 'badge badge-warning'}>{run.status}</span>,
            <span key="out" className="ltr-text break-all">{run.outputPath}</span>,
            `${run.monitoring.elapsedSeconds}s`,
            run.exitCode ?? '-',
            <button key="logs" className="btn-ghost inline-flex items-center gap-2 text-xs" onClick={() => void loadRunLog(run.id)}>
              <ListChecks size={13} />
              Logs
            </button>,
          ])}
        />
        {selectedRun && (
          <div className="rounded-md border p-3 text-xs space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
              <Info label="report" value={selectedRun.artifacts.reportPath} />
              <Info label="status" value={selectedRun.artifacts.statusPath} />
              <Info label="ffmpeg log" value={selectedRun.artifacts.ffmpegLogPath} />
              <Info label="output exists" value={selectedRun.monitoring.output.exists ? 'yes' : 'no'} />
            </div>
            {selectedRun.outputMode === 'localhost_hls' && (
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 size={14} style={{ color: 'var(--success)' }} />
                <span>HLS index:</span>
                <span className="ltr-text break-all">{`${selectedRun.outputPath.replace(/\\/g, '/')}/index.m3u8`}</span>
              </div>
            )}
            {selectedRun.errors.length > 0 && (
              <div className="rounded-md border p-3" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                {selectedRun.errors.map(issue => <div key={issue.code}>{issue.code}: {issue.message}</div>)}
              </div>
            )}
            {runLog && (
              <pre className="rounded-md border p-3 overflow-x-auto max-h-96" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                {runLog}
              </pre>
            )}
          </div>
        )}
      </section>

      <section className="rounded-md border p-3 flex flex-wrap items-center gap-2" style={{ borderColor: 'var(--warning)', background: 'rgba(245,158,11,0.08)' }}>
        <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Stop is handled by the short duration limit and FFmpeg watchdog. Production stop controls remain only on the broadcast page.
        </span>
        <Square size={14} style={{ color: 'var(--text-muted)' }} />
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'ready' | 'warning' | 'error' }) {
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
      <div className="font-medium break-all ltr-text">{value}</div>
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
