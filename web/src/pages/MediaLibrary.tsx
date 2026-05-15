import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { mediaApi } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { RefreshCw, Search } from 'lucide-react';

const STATUS_LABELS: Record<string, string> = {
  ready: 'جاهز', needs_transcode: 'يحتاج تحويل', missing: 'مفقود',
  invalid: 'خطأ', duplicate: 'مكرر', unsupported: 'غير مدعوم', pending: 'معلق',
};
const STATUS_BADGE: Record<string, string> = {
  ready: 'badge-ready', needs_transcode: 'badge-warning', missing: 'badge-error',
  invalid: 'badge-error', duplicate: 'badge-warning', unsupported: 'badge-error', pending: 'badge-pending',
};

interface MediaFile {
  id: string; filename: string; type: string; status: string;
  duration_sec: number | null; file_size: number | null;
  width: number | null; height: number | null; fps: number | null;
  video_codec: string | null; audio_codec: string | null;
}

interface ScanProgress { total: number; scanned: number; errors: number; currentFile: string; phase: string; }

export default function MediaLibraryPage() {
  const qc = useQueryClient();
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  const { data } = useQuery({
    queryKey: ['media-files', statusFilter, page],
    queryFn: () => mediaApi.files({ status: statusFilter || undefined, page: String(page), limit: '50' } as Record<string, string>).then(r => r.data as { files: MediaFile[]; total: number }),
  });

  const { data: statsData } = useQuery({
    queryKey: ['media-stats'],
    queryFn: () => mediaApi.stats().then(r => r.data as { stats: Array<{ status: string; count: number; total_size: number }> }),
    refetchInterval: 15000,
  });

  const handleWs = useCallback((msg: { type: string; data?: unknown }) => {
    if (msg.type === 'scan_progress') setScanProgress(msg.data as ScanProgress);
    if (msg.type === 'scan_complete') {
      setScanning(false);
      setScanProgress(null);
      void qc.invalidateQueries({ queryKey: ['media-files'] });
      void qc.invalidateQueries({ queryKey: ['media-stats'] });
    }
  }, [qc]);

  useWebSocket(handleWs);

  const handleScan = async () => {
    setScanning(true);
    setScanProgress(null);
    await mediaApi.scan().catch(() => setScanning(false));
  };

  const filtered = (data?.files ?? []).filter(f =>
    !search || f.filename.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">مكتبة الوسائط</h2>
        <button onClick={handleScan} disabled={scanning} className="btn-primary flex items-center gap-2">
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? 'جارٍ الفحص...' : 'فحص المكتبة'}
        </button>
      </div>

      {/* Scan progress */}
      {scanProgress && (
        <div className="card">
          <div className="flex justify-between text-sm mb-1">
            <span>{scanProgress.currentFile || scanProgress.phase}</span>
            <span style={{ color: 'var(--text-muted)' }}>{scanProgress.scanned}/{scanProgress.total}</span>
          </div>
          <div className="w-full h-1.5 rounded-full" style={{ background: 'var(--bg-border)' }}>
            <div className="h-1.5 rounded-full transition-all" style={{
              width: scanProgress.total > 0 ? `${(scanProgress.scanned / scanProgress.total) * 100}%` : '0%',
              background: 'var(--accent)'
            }} />
          </div>
          {scanProgress.errors > 0 && (
            <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{scanProgress.errors} أخطاء</p>
          )}
        </div>
      )}

      {/* Stats */}
      {statsData && (
        <div className="flex flex-wrap gap-2">
          {statsData.stats.map(s => (
            <span key={s.status} className={`badge ${STATUS_BADGE[s.status] ?? 'badge-info'}`}>
              {STATUS_LABELS[s.status] ?? s.status}: {s.count}
            </span>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute top-2.5 right-2.5" style={{ color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث باسم الملف..."
            className="w-full pr-8 pl-3 py-2 rounded-md text-sm"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-md text-sm"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
        >
          <option value="">جميع الحالات</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['اسم الملف', 'النوع', 'الحالة', 'المدة', 'الدقة', 'الكودك'].map(h => (
                <th key={h} className="text-right px-4 py-3 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((f, i) => (
              <tr key={f.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
                <td className="px-4 py-2.5 font-mono text-xs max-w-xs truncate">{f.filename}</td>
                <td className="px-4 py-2.5"><span className="badge badge-info">{f.type}</span></td>
                <td className="px-4 py-2.5">
                  <span className={`badge ${STATUS_BADGE[f.status] ?? ''}`}>{STATUS_LABELS[f.status] ?? f.status}</span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {f.duration_sec ? formatDuration(f.duration_sec) : '—'}
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {f.width && f.height ? `${f.width}×${f.height}` : '—'}
                </td>
                <td className="px-4 py-2.5 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                  {f.video_codec ?? '—'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>لا توجد ملفات</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {data?.total ?? 0} ملف إجمالاً
        </span>
        <div className="flex gap-2">
          <button className="btn-ghost text-xs px-3 py-1.5" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>السابق</button>
          <span className="px-3 py-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>صفحة {page}</span>
          <button className="btn-ghost text-xs px-3 py-1.5" onClick={() => setPage(p => p + 1)} disabled={(data?.files.length ?? 0) < 50}>التالي</button>
        </div>
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
