import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronLeft,
  Copy,
  FileVideo,
  Files,
  Folder,
  FolderTree,
  HardDrive,
  Home,
  RefreshCw,
  Search,
} from 'lucide-react';
import { mediaApi } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';

interface BrowserRoot {
  id: string;
  label: string;
  path: string;
  relativePath: string;
  exists: boolean;
  fileCount: number;
  mp4Count: number;
  sizeBytes: number;
  truncated: boolean;
}

interface BrowserEntry {
  name: string;
  type: 'directory' | 'file';
  fullPath: string;
  relativePath: string;
  extension: string | null;
  modifiedAt: string | null;
  fileCount: number;
  mp4Count: number;
  sizeBytes: number;
  truncated: boolean;
}

interface BrowserListResponse {
  root: BrowserRoot;
  current: {
    rootId: string;
    fullPath: string;
    relativePath: string;
    breadcrumbs: Array<{ label: string; relativePath: string }>;
  };
  entries: BrowserEntry[];
  total: number;
  page: number;
  limit: number;
}

interface ScanProgress {
  total: number;
  scanned: number;
  errors: number;
  currentFile: string;
  phase: string;
}

export default function MediaBrowserPage() {
  const queryClient = useQueryClient();
  const [rootId, setRootId] = useState('');
  const [relativePath, setRelativePath] = useState('');
  const [search, setSearch] = useState('');
  const [mp4Only, setMp4Only] = useState(false);
  const [page, setPage] = useState(1);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [copiedPath, setCopiedPath] = useState('');

  const { data: rootsData } = useQuery({
    queryKey: ['media-browser-roots'],
    queryFn: () => mediaApi.browserRoots().then(r => r.data as { roots: BrowserRoot[] }),
    refetchInterval: 30000,
  });

  const roots = rootsData?.roots ?? [];

  useEffect(() => {
    if (!rootId && roots.length > 0) {
      const firstExisting = roots.find(root => root.exists) ?? roots[0];
      if (firstExisting) setRootId(firstExisting.id);
    }
  }, [rootId, roots]);

  const { data, isFetching, error } = useQuery({
    queryKey: ['media-browser-list', rootId, relativePath, search, mp4Only, page],
    enabled: Boolean(rootId),
    queryFn: () => mediaApi.browserList({
      rootId,
      path: relativePath,
      search,
      mp4Only: String(mp4Only),
      page: String(page),
      limit: '100',
    }).then(r => r.data as BrowserListResponse),
  });

  const handleWs = useCallback((msg: { type: string; data?: unknown }) => {
    if (msg.type === 'scan_progress') setScanProgress(msg.data as ScanProgress);
    if (msg.type === 'scan_complete' || msg.type === 'scan_error') {
      setScanning(false);
      setScanProgress(null);
      void queryClient.invalidateQueries({ queryKey: ['media-browser-roots'] });
      void queryClient.invalidateQueries({ queryKey: ['media-browser-list'] });
    }
  }, [queryClient]);

  useWebSocket(handleWs);

  const openRoot = (nextRootId: string) => {
    setRootId(nextRootId);
    setRelativePath('');
    setPage(1);
  };

  const openPath = (nextPath: string) => {
    setRelativePath(nextPath);
    setPage(1);
  };

  const currentPath = data?.current.fullPath ?? roots.find(root => root.id === rootId)?.path ?? '';
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const copyPath = async (pathValue: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(pathValue);
      } else {
        fallbackCopy(pathValue);
      }
      setCopiedPath(pathValue);
      window.setTimeout(() => setCopiedPath(''), 1500);
    } catch {
      fallbackCopy(pathValue);
      setCopiedPath(pathValue);
      window.setTimeout(() => setCopiedPath(''), 1500);
    }
  };

  const scanSelectedFolder = async () => {
    if (!rootId) return;
    setScanning(true);
    setScanProgress(null);
    await mediaApi.scanBrowserFolder(rootId, data?.current.relativePath ?? relativePath)
      .catch(() => setScanning(false));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <FolderTree size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xl font-bold">متصفح الوسائط</h2>
            <span className="badge badge-info">قراءة فقط</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            {currentPath || 'اختر جذرًا مسموحًا'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void copyPath(currentPath)}
            disabled={!currentPath}
            className="btn-ghost flex items-center gap-2 text-sm"
            title="نسخ المسار الكامل"
          >
            {copiedPath === currentPath ? <Check size={14} /> : <Copy size={14} />}
            نسخ المسار
          </button>
          <button
            onClick={scanSelectedFolder}
            disabled={!rootId || scanning}
            className="btn-primary flex items-center gap-2 text-sm"
            title="فحص المجلد المحدد"
          >
            <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'جارٍ الفحص...' : 'فحص المجلد'}
          </button>
        </div>
      </div>

      {scanProgress && (
        <div className="card">
          <div className="flex justify-between text-sm mb-1">
            <span>{scanProgress.currentFile || scanProgress.phase}</span>
            <span style={{ color: 'var(--text-muted)' }}>{scanProgress.scanned}/{scanProgress.total}</span>
          </div>
          <div className="w-full h-1.5 rounded-full" style={{ background: 'var(--bg-border)' }}>
            <div
              className="h-1.5 rounded-full transition-all"
              style={{
                width: scanProgress.total > 0 ? `${(scanProgress.scanned / scanProgress.total) * 100}%` : '0%',
                background: 'var(--accent)',
              }}
            />
          </div>
          {scanProgress.errors > 0 && (
            <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{scanProgress.errors} أخطاء</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {roots.map(root => (
          <button
            key={root.id}
            onClick={() => openRoot(root.id)}
            className="px-3 py-2 rounded-md border text-right min-w-44"
            style={{
              background: root.id === rootId ? 'rgba(232,160,32,0.12)' : 'var(--bg-card)',
              borderColor: root.id === rootId ? 'var(--accent)' : 'var(--bg-border)',
              color: root.exists ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <HardDrive size={14} />
              {root.label}
            </span>
            <span className="block text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {formatBytes(root.sizeBytes)} · {root.fileCount}{root.truncated ? '+' : ''} ملف · {root.mp4Count} MP4
            </span>
          </button>
        ))}
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-64">
            <Search size={14} className="absolute top-2.5 right-2.5" style={{ color: 'var(--text-muted)' }} />
            <input
              value={search}
              onChange={event => { setSearch(event.target.value); setPage(1); }}
              placeholder="بحث باسم عربي أو إنجليزي..."
              className="w-full pr-8 pl-3 py-2 rounded-md text-sm"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
            />
          </div>
          <label className="flex items-center gap-2 px-3 py-2 rounded-md text-sm" style={{ border: '1px solid var(--bg-border)' }}>
            <input
              type="checkbox"
              checked={mp4Only}
              onChange={event => { setMp4Only(event.target.checked); setPage(1); }}
            />
            MP4 فقط
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button onClick={() => openPath('')} className="btn-ghost px-2 py-1 flex items-center gap-1">
            <Home size={13} />
            الجذر
          </button>
          {data?.current.breadcrumbs.map(crumb => (
            <button
              key={crumb.relativePath}
              onClick={() => openPath(crumb.relativePath)}
              className="btn-ghost px-2 py-1 flex items-center gap-1"
            >
              <ChevronLeft size={12} />
              {crumb.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['الاسم', 'النوع', 'الحجم', 'عدد الملفات', 'MP4', 'آخر تعديل', 'المسار'].map(header => (
                <th key={header} className="text-right px-4 py-3 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.entries.map((entry, index) => (
              <tr key={entry.relativePath} style={{ borderBottom: index < data.entries.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
                <td className="px-4 py-2.5">
                  {entry.type === 'directory' ? (
                    <button onClick={() => openPath(entry.relativePath)} className="flex items-center gap-2 font-medium">
                      <Folder size={15} style={{ color: 'var(--accent)' }} />
                      <span className="truncate max-w-xs">{entry.name}</span>
                    </button>
                  ) : (
                    <span className="flex items-center gap-2 font-mono text-xs">
                      <FileVideo size={14} style={{ color: 'var(--text-muted)' }} />
                      <span className="truncate max-w-xs">{entry.name}</span>
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span className="badge badge-info">{entry.type === 'directory' ? 'مجلد' : entry.extension || 'ملف'}</span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{formatBytes(entry.sizeBytes)}</td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span className="inline-flex items-center gap-1">
                    <Files size={12} />
                    {entry.fileCount}{entry.truncated ? '+' : ''}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{entry.mp4Count}</td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{formatDate(entry.modifiedAt)}</td>
                <td className="px-4 py-2.5">
                  <button
                    onClick={() => void copyPath(entry.fullPath)}
                    className="btn-ghost px-2 py-1 flex items-center gap-1 text-xs max-w-64"
                    title={entry.fullPath}
                  >
                    {copiedPath === entry.fullPath ? <Check size={12} /> : <Copy size={12} />}
                    <span className="truncate ltr-text">{entry.fullPath}</span>
                  </button>
                </td>
              </tr>
            ))}
            {!isFetching && data?.entries.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>لا توجد عناصر</td>
              </tr>
            )}
            {isFetching && (
              <tr>
                <td colSpan={7} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>جارٍ التحميل...</td>
              </tr>
            )}
            {error && (
              <tr>
                <td colSpan={7} className="text-center py-8" style={{ color: 'var(--danger)' }}>تعذر تحميل هذا المسار</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {data?.total ?? 0} عنصر
        </span>
        <div className="flex gap-2">
          <button className="btn-ghost text-xs px-3 py-1.5" onClick={() => setPage(value => Math.max(1, value - 1))} disabled={page === 1}>
            السابق
          </button>
          <span className="px-3 py-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>صفحة {page} / {totalPages}</span>
          <button className="btn-ghost text-xs px-3 py-1.5" onClick={() => setPage(value => value + 1)} disabled={page >= totalPages}>
            التالي
          </button>
        </div>
      </div>
    </div>
  );
}

function fallbackCopy(value: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ar');
}
