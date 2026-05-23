import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { broadcastApi, schedulerFoundationApi, systemApi } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { Radio, HardDrive, Cpu, AlertTriangle, Play, Clock, FileCog, ListChecks, Server, Wifi } from 'lucide-react';
import dayjs from 'dayjs';

interface PlaylistItem {
  id: string;
  title: string;
  title_ar: string | null;
  type: string;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
}

interface BroadcastStatus {
  status: string;
  pid: number | null;
  startedAt: string | null;
  currentItem: PlaylistItem | null;
  nextItem: PlaylistItem | null;
  isEmergency: boolean;
  hls?: { ok: boolean; ageSeconds: number };
}

interface ServerStatus {
  ok: boolean;
  timestamp: string;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
  };
  process: {
    pid: number;
    uptimeSeconds: number;
    nodeVersion: string;
  };
  cpu: {
    count: number;
    model: string;
    load1: number;
    load5: number;
    load15: number;
    loadPercent: number;
  };
  memory: {
    percent: number;
    usedStr: string;
    totalStr: string;
    freeStr: string;
  };
  disks: {
    media: { percent: number; usedStr: string; totalStr: string };
    hls: { percent: number; usedStr: string; totalStr: string };
  };
  wsClients: number;
}

interface NormalizationRunSummary {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  completedCount: number;
  failedCount: number;
  totalCount: number;
  currentFile: string | null;
}

interface TestPlayoutRunSummary {
  id: string;
  status: 'running' | 'completed' | 'failed';
  outputMode: string;
  outputPath: string;
  monitoring: {
    output: {
      exists: boolean;
      hlsSegmentCount: number | null;
      hlsHealthy?: boolean | null;
      hlsStale?: boolean;
      hlsIndexAgeSeconds?: number | null;
    };
  };
}

export default function DashboardPage() {
  const [broadcastState, setBroadcastState] = useState<BroadcastStatus | null>(null);
  const [nowPlaying, setNowPlaying] = useState<{ current: PlaylistItem | null; next: PlaylistItem | null }>({ current: null, next: null });

  const { data: serverStatus } = useQuery({
    queryKey: ['server-status'],
    queryFn: () => systemApi.status().then(r => r.data as ServerStatus),
    refetchInterval: 10000,
  });

  useQuery({
    queryKey: ['broadcast-status'],
    queryFn: () => broadcastApi.status().then(r => {
      setBroadcastState(r.data as BroadcastStatus);
      return r.data;
    }),
    refetchInterval: 5000,
  });

  const { data: normalizationData } = useQuery({
    queryKey: ['dashboard-normalization'],
    queryFn: async () => {
      const [statusResponse, runsResponse] = await Promise.all([
        schedulerFoundationApi.normalizationStatus(),
        schedulerFoundationApi.listNormalizationRuns(),
      ]);
      return {
        status: statusResponse.data as { latestPlan: { summary: { total: number; failed: number; fullTranscode: number; audioOnly: number; remux: number } } | null },
        runs: (runsResponse.data as { runs: NormalizationRunSummary[] }).runs,
      };
    },
    refetchInterval: 15000,
  });

  const { data: testPlayoutData } = useQuery({
    queryKey: ['dashboard-test-playout'],
    queryFn: () => schedulerFoundationApi.listTestPlayoutRuns().then(r => r.data as { runs: TestPlayoutRunSummary[] }),
    refetchInterval: 15000,
  });

  useQuery({
    queryKey: ['now-playing'],
    queryFn: () => broadcastApi.now().then(r => {
      const d = r.data as { current: PlaylistItem | null; next: PlaylistItem | null };
      setNowPlaying({ current: d.current, next: d.next });
      return r.data;
    }),
    refetchInterval: 10000,
  });

  const handleWs = useCallback((msg: { type: string; data?: unknown }) => {
    if (msg.type === 'broadcast_status') setBroadcastState(msg.data as BroadcastStatus);
    if (msg.type === 'now_playing') setNowPlaying(msg.data as { current: PlaylistItem | null; next: PlaylistItem | null });
  }, []);

  useWebSocket(handleWs);

  const statusColor =
    broadcastState?.status === 'running'   ? '#22c55e' :
    broadcastState?.status === 'emergency' ? '#f59e0b' :
    broadcastState?.status === 'error'     ? '#ef4444' : '#8b8fa8';

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">لوحة التحكم</h2>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Server size={18} style={{ color: 'var(--accent)' }} />
            <h3 className="font-bold text-base">حالة السيرفر الآن</h3>
          </div>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            آخر تحديث: {serverStatus ? dayjs(serverStatus.timestamp).format('HH:mm:ss') : '—'}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
          <StatCard
            icon={<Server size={20} />}
            label="الخدمة"
            value={serverStatus?.ok ? 'online' : '—'}
            valueColor={serverStatus?.ok ? '#22c55e' : undefined}
            sub={serverStatus ? `${serverStatus.host.hostname} · PID ${serverStatus.process.pid}` : undefined}
          />
          <StatCard
            icon={<Cpu size={20} />}
            label="المعالج"
            value={serverStatus ? `${serverStatus.cpu.loadPercent}%` : '—'}
            valueColor={serverStatus && serverStatus.cpu.loadPercent > 85 ? '#ef4444' : undefined}
            sub={serverStatus ? `load ${serverStatus.cpu.load1} / ${serverStatus.cpu.count} cores` : undefined}
          />
          <StatCard
            icon={<Cpu size={20} />}
            label="الذاكرة"
            value={serverStatus ? `${serverStatus.memory.percent}%` : '—'}
            valueColor={serverStatus && serverStatus.memory.percent > 90 ? '#ef4444' : undefined}
            sub={serverStatus ? `${serverStatus.memory.usedStr} / ${serverStatus.memory.totalStr}` : undefined}
          />
          <StatCard
            icon={<HardDrive size={20} />}
            label="قرص الوسائط"
            value={serverStatus ? `${serverStatus.disks.media.percent}%` : '—'}
            valueColor={serverStatus && serverStatus.disks.media.percent > 85 ? '#ef4444' : undefined}
            sub={serverStatus ? `${serverStatus.disks.media.usedStr} / ${serverStatus.disks.media.totalStr}` : undefined}
          />
          <StatCard
            icon={<Wifi size={20} />}
            label="اتصالات اللوحة"
            value={serverStatus ? String(serverStatus.wsClients) : '—'}
            sub="WebSocket"
          />
          <StatCard
            icon={<Clock size={20} />}
            label="مدة التشغيل"
            value={serverStatus ? formatDurationSeconds(serverStatus.process.uptimeSeconds) : '—'}
            sub={serverStatus ? serverStatus.process.nodeVersion : undefined}
          />
        </div>
      </div>

      {/* Now Playing + Next */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Play size={16} style={{ color: 'var(--accent)' }} />
            <span className="font-medium text-sm">يُعرض الآن</span>
          </div>
          {nowPlaying.current ? (
            <div>
              <p className="font-bold text-base">{nowPlaying.current.title_ar ?? nowPlaying.current.title}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {dayjs(nowPlaying.current.start_time_ms).format('HH:mm')} — {dayjs(nowPlaying.current.end_time_ms).format('HH:mm')}
                <span className="badge badge-info mr-2">{nowPlaying.current.type}</span>
              </p>
              <NowPlayingProgress item={nowPlaying.current} />
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)' }} className="text-sm">لا يوجد بث نشط</p>
          )}
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={16} style={{ color: 'var(--text-muted)' }} />
            <span className="font-medium text-sm">التالي</span>
          </div>
          {nowPlaying.next ? (
            <div>
              <p className="font-bold text-base">{nowPlaying.next.title_ar ?? nowPlaying.next.title}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {dayjs(nowPlaying.next.start_time_ms).format('HH:mm')}
                <span className="badge badge-pending mr-2">{nowPlaying.next.type}</span>
              </p>
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)' }} className="text-sm">—</p>
          )}
        </div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<Radio size={20} />}
          label="البث"
          value={broadcastState?.status ?? 'idle'}
          valueColor={statusColor}
        />
        <StatCard
          icon={<HardDrive size={20} />}
          label="التخزين"
          value={serverStatus ? `${serverStatus.disks.media.percent}%` : '—'}
          valueColor={serverStatus && serverStatus.disks.media.percent > 85 ? '#ef4444' : undefined}
          sub={serverStatus ? `${serverStatus.disks.media.usedStr} / ${serverStatus.disks.media.totalStr}` : undefined}
        />
        <StatCard
          icon={<Cpu size={20} />}
          label="الذاكرة"
          value={serverStatus ? `${serverStatus.memory.percent}%` : '—'}
          valueColor={serverStatus && serverStatus.memory.percent > 90 ? '#ef4444' : undefined}
        />
        <StatCard
          icon={broadcastState?.hls?.ok ? <Radio size={20} style={{ color: '#22c55e' }} /> : <AlertTriangle size={20} style={{ color: '#ef4444' }} />}
          label="HLS"
          value={broadcastState?.hls?.ok ? 'مباشر' : 'متوقف'}
          valueColor={broadcastState?.hls?.ok ? '#22c55e' : '#ef4444'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <FileCog size={16} style={{ color: 'var(--accent)' }} />
            <span className="font-medium text-sm">Normalization</span>
          </div>
          {normalizationData?.runs[0] ? (
            <div className="space-y-2">
              <StatusLine
                label="آخر تشغيل"
                value={`${normalizationData.runs[0].status} ${normalizationData.runs[0].completedCount}/${normalizationData.runs[0].totalCount}`}
                tone={normalStatusTone(normalizationData.runs[0].status)}
              />
              <StatusLine label="failed" value={String(normalizationData.runs[0].failedCount)} tone={normalizationData.runs[0].failedCount === 0 ? 'ready' : 'error'} />
              <p className="text-xs ltr-text break-all" style={{ color: 'var(--text-muted)' }}>
                {normalizationData.runs[0].currentFile ?? 'لا يوجد ملف قيد التشغيل'}
              </p>
            </div>
          ) : normalizationData?.status.latestPlan ? (
            <div className="space-y-2">
              <StatusLine label="latest plan" value={`${normalizationData.status.latestPlan.summary.total} files`} tone="info" />
              <StatusLine label="failed" value={String(normalizationData.status.latestPlan.summary.failed)} tone={normalizationData.status.latestPlan.summary.failed === 0 ? 'ready' : 'error'} />
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                transcode {normalizationData.status.latestPlan.summary.fullTranscode}, audio {normalizationData.status.latestPlan.summary.audioOnly}, remux {normalizationData.status.latestPlan.summary.remux}
              </p>
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)' }} className="text-sm">لا توجد خطة normalization بعد</p>
          )}
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <ListChecks size={16} style={{ color: 'var(--accent)' }} />
            <span className="font-medium text-sm">Test Playout</span>
          </div>
          {testPlayoutData?.runs[0] ? (
            <div className="space-y-2">
              <StatusLine
                label="آخر اختبار"
                value={testPlayoutData.runs[0].status}
                tone={testPlayoutData.runs[0].status === 'completed' ? 'ready' : testPlayoutData.runs[0].status === 'failed' ? 'error' : 'warning'}
              />
              <StatusLine label="output" value={testPlayoutOutputLabel(testPlayoutData.runs[0])} tone={testPlayoutOutputTone(testPlayoutData.runs[0])} />
              <p className="text-xs ltr-text break-all" style={{ color: 'var(--text-muted)' }}>
                {testPlayoutData.runs[0].outputPath}
              </p>
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)' }} className="text-sm">لا يوجد اختبار تشغيل بعد</p>
          )}
        </div>
      </div>

      {/* Emergency warning */}
      {broadcastState?.isEmergency && (
        <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: '#451a03', border: '1px solid #f59e0b' }}>
          <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
          <span className="text-sm font-medium" style={{ color: '#fbbf24' }}>
            النظام يعمل بالبث الطارئ
          </span>
        </div>
      )}
    </div>
  );
}

function StatusLine({ label, value, tone }: { label: string; value: string; tone: 'ready' | 'warning' | 'error' | 'info' }) {
  const cls = tone === 'ready' ? 'badge-ready' : tone === 'warning' ? 'badge-warning' : tone === 'error' ? 'badge-error' : 'badge-info';
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className={`badge ${cls}`}>{value}</span>
    </div>
  );
}

function normalStatusTone(status: NormalizationRunSummary['status']): 'ready' | 'warning' | 'error' | 'info' {
  if (status === 'completed') return 'ready';
  if (status === 'failed') return 'error';
  if (status === 'stopped') return 'warning';
  return 'info';
}

function testPlayoutOutputLabel(run: TestPlayoutRunSummary): string {
  const output = run.monitoring.output;
  if (output.hlsStale) return `HLS stale ${output.hlsIndexAgeSeconds ?? '?'}s`;
  if (output.hlsHealthy === true) return 'HLS healthy';
  return output.exists ? 'exists' : 'missing';
}

function testPlayoutOutputTone(run: TestPlayoutRunSummary): 'ready' | 'warning' | 'error' | 'info' {
  const output = run.monitoring.output;
  if (output.hlsStale) return 'error';
  if (output.hlsHealthy === true || output.exists) return 'ready';
  return 'warning';
}

function formatDurationSeconds(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function NowPlayingProgress({ item }: { item: PlaylistItem }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceUpdate(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const elapsed = Math.max(0, now - item.start_time_ms);
  const total = item.end_time_ms - item.start_time_ms;
  const pct = Math.min(100, (elapsed / total) * 100);
  const remaining = Math.max(0, Math.round((item.end_time_ms - now) / 1000));
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;

  return (
    <div className="mt-2">
      <div className="w-full rounded-full h-1.5" style={{ background: 'var(--bg-border)' }}>
        <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        متبقي: {mm}:{String(ss).padStart(2, '0')}
      </p>
    </div>
  );
}

function StatCard({ icon, label, value, valueColor, sub }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueColor?: string;
  sub?: string;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span style={{ color: 'var(--text-muted)' }}>{icon}</span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <p className="text-xl font-bold" style={{ color: valueColor ?? 'var(--text-primary)' }}>{value}</p>
      {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
    </div>
  );
}
