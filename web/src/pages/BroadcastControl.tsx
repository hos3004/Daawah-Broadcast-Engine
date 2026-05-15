import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { broadcastApi, scheduleApi } from '../api/client';
import { Play, Square, RefreshCw, AlertTriangle } from 'lucide-react';
import dayjs from 'dayjs';

export default function BroadcastPage() {
  const qc = useQueryClient();
  const [loading, setLoading] = useState<string | null>(null);
  const today = dayjs().format('YYYY-MM-DD');

  const { data: statusData, refetch } = useQuery({
    queryKey: ['broadcast-status-detail'],
    queryFn: () => broadcastApi.status().then(r => r.data as Record<string, unknown>),
    refetchInterval: 5000,
  });

  const { data: nowData } = useQuery({
    queryKey: ['now-detail'],
    queryFn: () => broadcastApi.now().then(r => r.data as Record<string, unknown>),
    refetchInterval: 5000,
  });

  const action = async (name: string, fn: () => Promise<unknown>) => {
    setLoading(name);
    try { await fn(); await refetch(); }
    catch (err) { alert(`فشل: ${String(err)}`); }
    finally { setLoading(null); }
  };

  const status = statusData?.['status'] as string ?? 'idle';
  const isRunning = status === 'running' || status === 'emergency';

  const statusColor =
    status === 'running'   ? '#22c55e' :
    status === 'emergency' ? '#f59e0b' :
    status === 'error'     ? '#ef4444' : '#8b8fa8';

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">التحكم بالبث</h2>

      {/* Status Card */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <span className="status-dot" style={{ background: statusColor, width: 10, height: 10 }} />
          <span className="font-bold text-lg" style={{ color: statusColor }}>{status}</span>
          {statusData?.['isEmergency'] && (
            <span className="badge badge-warning flex items-center gap-1">
              <AlertTriangle size={10} /> طارئ
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm mb-4">
          <div>
            <span style={{ color: 'var(--text-muted)' }}>PID: </span>
            <span className="font-mono">{String(statusData?.['pid'] ?? '—')}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>بدأ: </span>
            <span>{statusData?.['startedAt'] ? dayjs(statusData['startedAt'] as string).format('HH:mm:ss') : '—'}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>HLS: </span>
            <span style={{ color: (statusData?.['hls'] as Record<string, unknown>)?.['ok'] ? '#22c55e' : '#ef4444' }}>
              {(statusData?.['hls'] as Record<string, unknown>)?.['ok'] ? 'مباشر' : 'متوقف'}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>إعادة تشغيل: </span>
            <span>{String(statusData?.['restartCount'] ?? 0)}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap gap-3">
          <button
            className="btn-primary flex items-center gap-2"
            disabled={isRunning || loading !== null}
            onClick={() => action('start', broadcastApi.start)}
          >
            <Play size={14} />
            {loading === 'start' ? 'جارٍ التشغيل...' : 'تشغيل'}
          </button>
          <button
            className="btn-ghost flex items-center gap-2"
            disabled={!isRunning || loading !== null}
            onClick={() => action('restart', broadcastApi.restart)}
          >
            <RefreshCw size={14} className={loading === 'restart' ? 'animate-spin' : ''} />
            إعادة تشغيل
          </button>
          <button
            className="btn-danger flex items-center gap-2"
            disabled={!isRunning || loading !== null}
            onClick={() => { if (confirm('تأكيد إيقاف البث؟')) action('stop', broadcastApi.stop); }}
          >
            <Square size={14} />
            {loading === 'stop' ? 'جارٍ الإيقاف...' : 'إيقاف'}
          </button>
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-md font-medium"
            style={{ background: '#451a03', color: '#fbbf24', border: '1px solid #f59e0b' }}
            disabled={loading !== null}
            onClick={() => { if (confirm('تفعيل البث الطارئ؟')) action('emergency', broadcastApi.emergency); }}
          >
            <AlertTriangle size={14} />
            بث طارئ
          </button>
        </div>
      </div>

      {/* Now Playing */}
      <div className="card">
        <h3 className="font-medium mb-3">الآن على الهواء</h3>
        {nowData?.['current'] ? (
          <NowPlayingCard item={nowData['current'] as Record<string, unknown>} />
        ) : (
          <p style={{ color: 'var(--text-muted)' }} className="text-sm">لا يوجد بث نشط</p>
        )}
        {nowData?.['next'] && (
          <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--bg-border)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>التالي:</p>
            <p className="font-medium">{String((nowData['next'] as Record<string, unknown>)?.['title_ar'] ?? (nowData['next'] as Record<string, unknown>)?.['title'] ?? '')}</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {dayjs(Number((nowData['next'] as Record<string, unknown>)?.['start_time_ms'])).format('HH:mm')}
            </p>
          </div>
        )}
      </div>

      {/* Playlist build */}
      <div className="card">
        <h3 className="font-medium mb-3">تجهيز قائمة التشغيل اليومية</h3>
        <div className="flex gap-3 items-center">
          <input
            type="date"
            defaultValue={today}
            id="build-date"
            className="px-3 py-2 rounded-md text-sm"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
          />
          <button
            className="btn-primary"
            onClick={() => {
              const d = (document.getElementById('build-date') as HTMLInputElement).value;
              action('build', () => scheduleApi.buildPlaylist(d).then(() => {
                void qc.invalidateQueries({ queryKey: ['now-detail'] });
              }));
            }}
          >
            {loading === 'build' ? 'جارٍ البناء...' : 'بناء القائمة'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NowPlayingCard({ item }: { item: Record<string, unknown> }) {
  return (
    <div>
      <p className="font-bold">{String(item['title_ar'] ?? item['title'] ?? '')}</p>
      <div className="flex gap-2 mt-1">
        <span className="badge badge-info">{String(item['type'] ?? '')}</span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {dayjs(Number(item['start_time_ms'])).format('HH:mm')} — {dayjs(Number(item['end_time_ms'])).format('HH:mm')}
        </span>
      </div>
    </div>
  );
}
