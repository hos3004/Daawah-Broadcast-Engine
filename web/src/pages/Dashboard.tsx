import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { broadcastApi, systemApi } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { Radio, HardDrive, Cpu, AlertTriangle, Play, Clock } from 'lucide-react';
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

export default function DashboardPage() {
  const [broadcastState, setBroadcastState] = useState<BroadcastStatus | null>(null);
  const [nowPlaying, setNowPlaying] = useState<{ current: PlaylistItem | null; next: PlaylistItem | null }>({ current: null, next: null });

  const { data: diskData } = useQuery({
    queryKey: ['disk'],
    queryFn: () => systemApi.disk().then(r => r.data as { mem: { percent: number }; cpu: number[]; media: { percent: number; usedStr: string; totalStr: string }; hls: { percent: number } }),
    refetchInterval: 30000,
  });

  useQuery({
    queryKey: ['broadcast-status'],
    queryFn: () => broadcastApi.status().then(r => {
      setBroadcastState(r.data as BroadcastStatus);
      return r.data;
    }),
    refetchInterval: 5000,
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
          value={diskData ? `${diskData.media.percent}%` : '—'}
          valueColor={diskData && diskData.media.percent > 85 ? '#ef4444' : undefined}
          sub={diskData ? `${diskData.media.usedStr} / ${diskData.media.totalStr}` : undefined}
        />
        <StatCard
          icon={<Cpu size={20} />}
          label="الذاكرة"
          value={diskData ? `${diskData.mem.percent}%` : '—'}
          valueColor={diskData && diskData.mem.percent > 90 ? '#ef4444' : undefined}
        />
        <StatCard
          icon={broadcastState?.hls?.ok ? <Radio size={20} style={{ color: '#22c55e' }} /> : <AlertTriangle size={20} style={{ color: '#ef4444' }} />}
          label="HLS"
          value={broadcastState?.hls?.ok ? 'مباشر' : 'متوقف'}
          valueColor={broadcastState?.hls?.ok ? '#22c55e' : '#ef4444'}
        />
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
