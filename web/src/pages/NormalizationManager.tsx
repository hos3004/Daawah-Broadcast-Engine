import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FileCog,
  HardDrive,
  ListChecks,
  Play,
  RefreshCw,
  Save,
  Settings2,
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
    audioBitrate: string;
    videoBitrate: string;
    videoMaxrate: string;
    videoBufsize: string;
    maxVideoBitrate: number;
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
    bitrate: number | null;
    audioRate: number | null;
  };
}

interface ServerNormalizationProcessInfo {
  pid: number;
  ppid: number | null;
  pgid: number | null;
  nice: number | null;
  cpuPercent: number;
  stat: string | null;
  command: string;
}

interface ServerNormalizationJobStatus {
  key: 'fix_existing_normalized' | 'continue_original_ar';
  label: string;
  scriptPath: string;
  pidPath: string;
  outputPath: string;
  reportPath: string | null;
  pid: number | null;
  pgid: number | null;
  running: boolean;
  done: boolean;
  progress: {
    current: number | null;
    total: number | null;
    percent: number | null;
  };
  counts: {
    ok: number;
    failed: number;
    fix: number;
    noAction: number;
    remux: number;
    audioOnly: number;
    fullTranscode: number;
    other: number;
  };
  cpuPercent: number;
  lastLines: string[];
  processes: ServerNormalizationProcessInfo[];
}

interface ServerNormalizationStatus {
  phase: 'fix_running' | 'continue_running' | 'ready_for_continue' | 'idle';
  generatedAt: string;
  server: {
    hostname: string;
    platform: string;
    cpuCount: number;
    loadAverage: [number, number, number];
  };
  paths: {
    originalRoot: string;
    normalizedRoot: string;
    originalSize: string;
    normalizedSize: string;
  };
  disk: {
    path: string;
    usedBytes: number;
    totalBytes: number;
    freeBytes: number;
    percent: number;
    usedLabel: string;
    totalLabel: string;
    freeLabel: string;
  };
  throttle: {
    pidPath: string;
    logPath: string;
    pid: number | null;
    running: boolean;
    lastLines: string[];
  };
  fixJob: ServerNormalizationJobStatus;
  continueJob: ServerNormalizationJobStatus;
  guidance: {
    canStartContinue: boolean;
    reason: string;
  };
}

interface ServerNormalizationNextTaskConfig {
  sourceRoot: string;
  outputRoot: string;
  maxParallel: number;
  nice: number;
  ioniceClass: 2 | 3;
  ioniceLevel: number;
  maxVideoBitrate: number;
  videoBitrate: string;
  videoMaxrate: string;
  videoBufsize: string;
  audioBitrate: string;
  deleteOriginalAfterValidation: boolean;
  requireFixDoneBeforeContinue: boolean;
}

interface ServerNormalizationNextTask {
  config: ServerNormalizationNextTaskConfig;
  envPreview: Record<string, string>;
  commandPreview: string;
  safety: {
    startsAutomatically: false;
    scriptPath: string;
    pidPath: string;
    outputPath: string;
    deletesOriginalOnlyAfterValidation: boolean;
    requiresFixDoneBeforeContinue: boolean;
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

const defaultNextTaskConfig: ServerNormalizationNextTaskConfig = {
  sourceRoot: '/srv/daawah/media/original-ar',
  outputRoot: '/srv/daawah/media/normalized-ar',
  maxParallel: 5,
  nice: 10,
  ioniceClass: 2,
  ioniceLevel: 7,
  maxVideoBitrate: 3500000,
  videoBitrate: '2500k',
  videoMaxrate: '3500k',
  videoBufsize: '7000k',
  audioBitrate: '192k',
  deleteOriginalAfterValidation: true,
  requireFixDoneBeforeContinue: true,
};

export default function NormalizationManagerPage() {
  const [status, setStatus] = useState<NormalizationStatus | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerNormalizationStatus | null>(null);
  const [nextTask, setNextTask] = useState<ServerNormalizationNextTask | null>(null);
  const [nextConfig, setNextConfig] = useState<ServerNormalizationNextTaskConfig>(defaultNextTaskConfig);
  const [scope, setScope] = useState<NormalizationScope>('media_roots');
  const [publishedScheduleId, setPublishedScheduleId] = useState('');
  const [includeOriginalAr, setIncludeOriginalAr] = useState(true);
  const [includeSource, setIncludeSource] = useState(false);
  const [includeBumpers, setIncludeBumpers] = useState(false);
  const [limit, setLimit] = useState(500);
  const [preflight, setPreflight] = useState<NormalizationPreflight | null>(null);
  const [plans, setPlans] = useState<NormalizationPlan[]>([]);
  const [runs, setRuns] = useState<NormalizationRun[]>([]);
  const [sets, setSets] = useState<NormalizedSet[]>([]);
  const [loading, setLoading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [savingNextTask, setSavingNextTask] = useState(false);
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
    if (includeOriginalAr) keys.push('original-ar');
    if (includeSource) keys.push('source');
    if (includeBumpers) keys.push('bumpers');
    return keys;
  }, [includeBumpers, includeOriginalAr, includeSource]);

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async () => {
    setError('');
    try {
      const [statusResponse, serverStatusResponse, nextTaskResponse, plansResponse, runsResponse, setsResponse] = await Promise.all([
        schedulerFoundationApi.normalizationStatus(),
        schedulerFoundationApi.serverNormalizationStatus(),
        schedulerFoundationApi.getNormalizationNextTask(),
        schedulerFoundationApi.listNormalizationPlans(),
        schedulerFoundationApi.listNormalizationRuns(),
        schedulerFoundationApi.listNormalizedSets(),
      ]);
      const statusBody = statusResponse.data as NormalizationStatus;
      const serverStatusBody = serverStatusResponse.data as ServerNormalizationStatus;
      const nextTaskBody = nextTaskResponse.data as ServerNormalizationNextTask;
      const plansBody = plansResponse.data as { plans: NormalizationPlan[] };
      const runsBody = runsResponse.data as { runs: NormalizationRun[] };
      const setsBody = setsResponse.data as { sets: NormalizedSet[] };
      setStatus(statusBody);
      setServerStatus(serverStatusBody);
      setNextTask(nextTaskBody);
      setNextConfig(nextTaskBody.config);
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

  const updateNextConfig = <Key extends keyof ServerNormalizationNextTaskConfig>(
    key: Key,
    value: ServerNormalizationNextTaskConfig[Key]
  ) => {
    setNextConfig(current => ({ ...current, [key]: value }));
  };

  const saveNextTask = async () => {
    setSavingNextTask(true);
    setMessage('');
    setError('');
    try {
      const response = await schedulerFoundationApi.saveNormalizationNextTask(nextConfig);
      const body = response.data as ServerNormalizationNextTask;
      setNextTask(body);
      setNextConfig(body.config);
      setMessage('تم حفظ إعدادات مهمة الإكمال القادمة.');
    } catch {
      setError('Could not save the next normalization task settings.');
    } finally {
      setSavingNextTask(false);
    }
  };

  const topItems = preflight?.items.slice(0, 80) ?? [];
  const currentServerJob = serverStatus?.continueJob.running ? serverStatus.continueJob : serverStatus?.fixJob;
  const summaryCards = buildSummaryCards(currentServerJob, preflight, status);

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <FileCog size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xl font-bold">Normalization Manager</h2>
            <span className="badge badge-warning">dry-run first</span>
            <span className="badge badge-info">typed confirmation before FFmpeg</span>
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
        {summaryCards.map(card => (
          <SummaryCard key={card.label} label={card.label} value={card.value} tone={card.tone} />
        ))}
      </section>

      <section className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Activity size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">العمل الحالي على السيرفر</h3>
              <span className={serverStatus?.phase === 'ready_for_continue' ? 'badge badge-ready' : serverStatus?.phase === 'idle' ? 'badge badge-warning' : 'badge badge-info'}>
                {serverStatus ? phaseLabel(serverStatus.phase) : 'loading'}
              </span>
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              متابعة مباشرة لسكريبتات /tmp على VPS: إصلاح normalized-ar الحالي ثم تجهيز إكمال original-ar.
            </p>
          </div>
          <span className="text-xs ltr-text" style={{ color: 'var(--text-muted)' }}>
            {serverStatus?.generatedAt ? new Date(serverStatus.generatedAt).toLocaleString() : '-'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-xs">
          <Info label="server" value={serverStatus ? `${serverStatus.server.hostname} / ${serverStatus.server.cpuCount} cores` : '-'} />
          <Info label="load avg" value={serverStatus ? serverStatus.server.loadAverage.map(value => value.toFixed(2)).join(' / ') : '-'} />
          <Info label="original-ar" value={serverStatus?.paths.originalSize ?? 'unknown'} />
          <Info label="normalized-ar" value={serverStatus?.paths.normalizedSize ?? 'unknown'} />
          <Info label="disk free" value={serverStatus ? `${serverStatus.disk.freeLabel} free / ${serverStatus.disk.percent}% used` : '-'} />
          <Info label="throttle watcher" value={serverStatus ? `${serverStatus.throttle.running ? 'running' : 'stopped'}${serverStatus.throttle.pid ? ` pid ${serverStatus.throttle.pid}` : ''}` : '-'} />
          <Info label="current cpu" value={currentServerJob ? `${currentServerJob.cpuPercent.toFixed(1)}%` : '-'} />
          <Info label="next gate" value={serverStatus?.guidance.canStartContinue ? 'ready after DONE' : serverStatus?.guidance.reason ?? '-'} />
        </div>

        {serverStatus && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <ServerJobPanel job={serverStatus.fixJob} />
            <ServerJobPanel job={serverStatus.continueJob} />
          </div>
        )}

        {currentServerJob && (
          <div className="rounded-md border p-3 text-xs space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
            <div className="flex flex-wrap items-center gap-2">
              <Cpu size={15} style={{ color: 'var(--accent)' }} />
              <span className="font-medium">عمليات المهمة الحالية</span>
              <span className="badge badge-info">{currentServerJob.processes.length} processes</span>
            </div>
            <DataTable
              empty="No matching processes right now."
              headers={['PID', 'PGID', 'Nice', 'CPU', 'Stat', 'Command']}
              rows={currentServerJob.processes.slice(0, 8).map(processInfo => [
                processInfo.pid,
                processInfo.pgid ?? '-',
                processInfo.nice ?? '-',
                `${processInfo.cpuPercent.toFixed(1)}%`,
                processInfo.stat ?? '-',
                <span key="cmd" className="ltr-text break-all">{processInfo.command}</span>,
              ])}
            />
            {currentServerJob.lastLines.length > 0 && (
              <pre className="rounded-md border p-3 overflow-x-auto max-h-72 ltr-text" style={{ borderColor: 'var(--bg-border)', color: 'var(--text-muted)' }}>
                {currentServerJob.lastLines.join('\n')}
              </pre>
            )}
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Settings2 size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">ضبط المهمة القادمة</h3>
              <span className="badge badge-warning">prepare only</span>
              <span className="badge badge-info">no auto start</span>
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              هذه الإعدادات تحفظ خطة إكمال Normalize من original-ar إلى normalized-ar بعد انتهاء مرحلة الإصلاح.
            </p>
          </div>
          <button className="btn-primary inline-flex items-center gap-2 text-sm" disabled={savingNextTask} onClick={() => void saveNextTask()}>
            <Save size={14} />
            {savingNextTask ? 'Saving...' : 'Save settings'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <Field label="Source root" value={nextConfig.sourceRoot} onChange={value => updateNextConfig('sourceRoot', value)} className="xl:col-span-2" />
          <Field label="Output root" value={nextConfig.outputRoot} onChange={value => updateNextConfig('outputRoot', value)} className="xl:col-span-2" />
          <NumberField label="Parallel files" value={nextConfig.maxParallel} min={1} max={10} onChange={value => updateNextConfig('maxParallel', value)} />
          <NumberField label="nice" value={nextConfig.nice} min={0} max={19} onChange={value => updateNextConfig('nice', value)} />
          <label className="text-xs space-y-1">
            <span style={{ color: 'var(--text-muted)' }}>ionice class</span>
            <select
              className="w-full rounded-md border px-3 py-2 bg-transparent"
              style={{ borderColor: 'var(--bg-border)' }}
              value={nextConfig.ioniceClass}
              onChange={event => updateNextConfig('ioniceClass', Number(event.target.value) as 2 | 3)}
            >
              <option value={2}>best-effort low</option>
              <option value={3}>idle</option>
            </select>
          </label>
          <NumberField label="ionice level" value={nextConfig.ioniceLevel} min={0} max={7} onChange={value => updateNextConfig('ioniceLevel', value)} />
          <NumberField label="max video bitrate" value={nextConfig.maxVideoBitrate} min={500000} max={20000000} onChange={value => updateNextConfig('maxVideoBitrate', value)} />
          <Field label="video bitrate" value={nextConfig.videoBitrate} onChange={value => updateNextConfig('videoBitrate', value)} />
          <Field label="video maxrate" value={nextConfig.videoMaxrate} onChange={value => updateNextConfig('videoMaxrate', value)} />
          <Field label="video bufsize" value={nextConfig.videoBufsize} onChange={value => updateNextConfig('videoBufsize', value)} />
          <Field label="audio bitrate" value={nextConfig.audioBitrate} onChange={value => updateNextConfig('audioBitrate', value)} />
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={nextConfig.requireFixDoneBeforeContinue}
              onChange={event => updateNextConfig('requireFixDoneBeforeContinue', event.target.checked)}
            />
            require DONE before continue
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={nextConfig.deleteOriginalAfterValidation}
              onChange={event => updateNextConfig('deleteOriginalAfterValidation', event.target.checked)}
            />
            delete original only after validation
          </label>
        </div>

        <div className="rounded-md border p-3 text-xs space-y-2" style={{ borderColor: 'var(--bg-border)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <HardDrive size={15} style={{ color: 'var(--accent)' }} />
            <span className="font-medium">Command preview</span>
            <span className="badge badge-info">{nextTask?.safety.scriptPath ?? '/tmp/continue_normalize_ar_server.sh'}</span>
          </div>
          <pre className="overflow-x-auto ltr-text" style={{ color: 'var(--text-muted)' }}>
            {nextTask?.commandPreview ?? 'Save settings to generate a command preview.'}
          </pre>
        </div>
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
              <Info label="target video" value={status ? `${status.target.width}x${status.target.height} ${status.target.fps}fps ${status.target.videoCodec} ${status.target.pixelFormat} ${status.target.videoBitrate}` : '-'} />
              <Info label="target audio" value={status ? `${status.target.audioCodec} ${status.target.audioRate / 1000}k stereo ${status.target.audioBitrate}` : '-'} />
              <Info label="output root" value={status?.outputRoot ?? '/srv/daawah/media/normalized-ar'} />
              <Info label="bitrate gate" value={status ? `<= ${formatBitrate(status.target.maxVideoBitrate)}` : '<= 3.5 Mbps'} />
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
                  <input type="checkbox" checked={includeOriginalAr} onChange={event => setIncludeOriginalAr(event.target.checked)} />
                  original-ar
                </label>
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
              `${item.probe.width ?? '?'}x${item.probe.height ?? '?'} ${item.probe.fps ?? '?'}fps ${item.probe.videoCodec ?? '?'} ${formatBitrate(item.probe.bitrate)} / ${item.probe.audioCodec ?? '?'} ${item.probe.audioRate ?? '?'}Hz`,
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

interface SummaryCardMetric {
  label: string;
  value: string | number;
  tone?: 'ready' | 'warning' | 'error';
}

function buildSummaryCards(
  currentServerJob: ServerNormalizationJobStatus | undefined,
  preflight: NormalizationPreflight | null,
  status: NormalizationStatus | null
): SummaryCardMetric[] {
  if (currentServerJob && isLiveJobSummaryAvailable(currentServerJob)) {
    const checked = currentServerJob.progress.current ?? jobProcessedCount(currentServerJob);
    const total = currentServerJob.progress.total ?? checked;
    return [
      { label: 'total', value: total },
      { label: 'checked', value: checked },
      { label: 'ok', value: jobOkCount(currentServerJob), tone: 'ready' },
      { label: 'fix', value: currentServerJob.counts.fix, tone: 'warning' },
      { label: 'failed', value: currentServerJob.counts.failed, tone: 'error' },
      { label: 'cpu', value: `${currentServerJob.cpuPercent.toFixed(1)}%` },
    ];
  }

  const summary = preflight?.summary ?? status?.latestPlan?.summary;
  return [
    { label: 'total', value: summary?.total ?? 0 },
    { label: 'ok', value: summary?.ok ?? 0, tone: 'ready' },
    { label: 'remux', value: summary?.remux ?? 0 },
    { label: 'audio-only', value: summary?.audioOnly ?? 0, tone: 'warning' },
    { label: 'full-transcode', value: summary?.fullTranscode ?? 0, tone: 'warning' },
    { label: 'failed', value: summary?.failed ?? 0, tone: 'error' },
  ];
}

function isLiveJobSummaryAvailable(job: ServerNormalizationJobStatus): boolean {
  return job.running || job.done || job.progress.current !== null || jobProcessedCount(job) > 0;
}

function jobProcessedCount(job: ServerNormalizationJobStatus): number {
  return job.counts.ok
    + job.counts.noAction
    + job.counts.fix
    + job.counts.failed
    + job.counts.remux
    + job.counts.audioOnly
    + job.counts.fullTranscode
    + job.counts.other;
}

function jobOkCount(job: ServerNormalizationJobStatus): number {
  return job.counts.ok + job.counts.noAction;
}

function SummaryCard({ label, value, tone }: SummaryCardMetric) {
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

function ServerJobPanel({ job }: { job: ServerNormalizationJobStatus }) {
  const progressText = job.progress.current !== null && job.progress.total !== null
    ? `${job.progress.current}/${job.progress.total}${job.progress.percent !== null ? ` (${job.progress.percent}%)` : ''}`
    : '-';
  return (
    <div className="rounded-md border p-3 text-xs space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">{job.label}</div>
        <span className={job.running ? 'badge badge-info' : job.done ? 'badge badge-ready' : 'badge badge-warning'}>
          {job.running ? 'running' : job.done ? 'DONE' : 'idle'}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Info label="progress" value={progressText} />
        <Info label="ok / failed" value={`${jobOkCount(job)} / ${job.counts.failed}`} />
        <Info label="fix / no action" value={`${job.counts.fix} / ${job.counts.noAction}`} />
        <Info label="cpu" value={`${job.cpuPercent.toFixed(1)}%`} />
        <Info label="pid" value={job.pid ?? '-'} />
        <Info label="pgid" value={job.pgid ?? '-'} />
        <Info label="report" value={job.reportPath ?? '-'} />
        <Info label="output" value={job.outputPath} />
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={`text-xs space-y-1 ${className ?? ''}`}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <input
        className="w-full rounded-md border px-3 py-2 bg-transparent ltr-text"
        style={{ borderColor: 'var(--bg-border)' }}
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="text-xs space-y-1">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <input
        className="w-full rounded-md border px-3 py-2 bg-transparent ltr-text"
        style={{ borderColor: 'var(--bg-border)' }}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function phaseLabel(phase: ServerNormalizationStatus['phase']): string {
  if (phase === 'fix_running') return 'fix running';
  if (phase === 'continue_running') return 'continue running';
  if (phase === 'ready_for_continue') return 'ready for continue';
  return 'idle';
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

function formatBitrate(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '? bitrate';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)} Mbps`;
  return `${Math.round(value / 1000)} kbps`;
}
