import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { systemApi } from '../api/client';
import { RefreshCw } from 'lucide-react';

const LOG_TYPES = [
  { value: 'app',    label: 'سجل التطبيق' },
  { value: 'ffmpeg', label: 'سجل FFmpeg' },
];

export default function LogsPage() {
  const [logType, setLogType] = useState('app');
  const [lines, setLines] = useState(100);

  const { data, refetch, isFetching } = useQuery({
    queryKey: ['logs', logType, lines],
    queryFn: () => systemApi.logs(logType, lines).then(r => r.data as { lines: string[]; total: number; file: string }),
    refetchInterval: 10000,
  });

  const { data: auditData } = useQuery({
    queryKey: ['audit'],
    queryFn: () => systemApi.audit().then(r => r.data as { entries: Array<Record<string, unknown>>; total: number }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">السجلات</h2>
        <button className="btn-ghost flex items-center gap-2 text-sm" onClick={() => refetch()}>
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          تحديث
        </button>
      </div>

      {/* System Logs */}
      <div className="card">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex gap-2">
            {LOG_TYPES.map(t => (
              <button
                key={t.value}
                className={`text-xs px-3 py-1.5 rounded-md ${logType === t.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setLogType(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <select
            value={lines}
            onChange={e => setLines(Number(e.target.value))}
            className="px-2 py-1.5 rounded-md text-xs mr-auto"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
          >
            {[50, 100, 200, 500].map(n => (
              <option key={n} value={n}>{n} سطر</option>
            ))}
          </select>
        </div>
        <div
          className="font-mono text-xs overflow-auto max-h-80 space-y-0.5"
          dir="ltr"
          style={{ background: 'var(--bg-primary)', padding: '12px', borderRadius: '6px' }}
        >
          {(data?.lines ?? []).map((line, i) => (
            <div
              key={i}
              style={{
                color: line.includes('ERROR') ? '#f87171'
                  : line.includes('WARN') ? '#fbbf24'
                  : 'var(--text-muted)',
              }}
            >
              {line}
            </div>
          ))}
          {(data?.lines ?? []).length === 0 && (
            <p style={{ color: 'var(--text-muted)' }}>لا توجد سجلات</p>
          )}
        </div>
      </div>

      {/* Audit Log */}
      <div className="card">
        <h3 className="font-medium mb-3">سجل المراجعة</h3>
        <div className="space-y-1 max-h-60 overflow-auto">
          {(auditData?.entries ?? []).map((entry, i) => (
            <div key={i} className="flex items-start gap-3 text-xs py-1.5 border-b" style={{ borderColor: 'var(--bg-border)' }}>
              <span className="font-mono whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                {String(entry['created_at'] ?? '').slice(0, 16)}
              </span>
              <span className="badge badge-info">{String(entry['action'] ?? '')}</span>
              <span style={{ color: 'var(--text-muted)' }}>{String(entry['user_email'] ?? '—')}</span>
              {Boolean(entry['detail']) && <span className="truncate">{String(entry['detail'])}</span>}
            </div>
          ))}
          {(auditData?.entries ?? []).length === 0 && (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>لا توجد أحداث</p>
          )}
        </div>
      </div>
    </div>
  );
}
