import { useState, useCallback, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { mediaApi } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { Eye, FolderOpen, ListVideo, RefreshCw, Search, Trash2, X } from 'lucide-react';

const STATUS_LABELS: Record<string, string> = {
  ready: 'جاهز',
  needs_transcode: 'يحتاج تحويل',
  missing: 'مفقود',
  invalid: 'خطأ',
  duplicate: 'مكرر',
  unsupported: 'غير مدعوم',
  pending: 'معلق',
  provisional: 'مؤقت',
  indexed: 'مفهرس',
  needs_review: 'يحتاج مراجعة',
};

const STATUS_BADGE: Record<string, string> = {
  ready: 'badge-ready',
  indexed: 'badge-ready',
  needs_transcode: 'badge-warning',
  needs_review: 'badge-warning',
  provisional: 'badge-pending',
  missing: 'badge-error',
  invalid: 'badge-error',
  duplicate: 'badge-warning',
  unsupported: 'badge-error',
  pending: 'badge-pending',
};

type TabKey = 'files' | 'folders' | 'folderEpisodes';

interface MediaFile {
  id: string;
  filename: string;
  original_filename?: string | null;
  display_title_ar?: string | null;
  type: string;
  status: string;
  duration_sec: number | null;
  duration_ms?: number | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  folder_name_ar?: string | null;
  root_key?: string | null;
}

interface ProgramFolder {
  id: string;
  root_key: string;
  original_relative_path: string;
  display_name_ar: string;
  safe_slug: string;
  active_file_count: number;
  active_total_duration_ms: number | null;
  active_longest_file_duration_ms: number | null;
  file_count: number;
  total_duration_ms: number | null;
  longest_file_duration_ms: number | null;
  status: string;
}

interface ScanProgress {
  total: number;
  scanned: number;
  errors: number;
  currentFile: string;
  phase: string;
}

export default function MediaLibraryPage() {
  const qc = useQueryClient();
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<TabKey>('files');
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [previewFile, setPreviewFile] = useState<MediaFile | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['media-files', statusFilter, page],
    queryFn: () => mediaApi.files({
      status: statusFilter || undefined,
      page: String(page),
      limit: '100',
    } as Record<string, string>).then(r => r.data as { files: MediaFile[]; total: number }),
  });

  const { data: foldersData } = useQuery({
    queryKey: ['media-program-folders'],
    queryFn: () => mediaApi.programFolders().then(r => r.data as { folders: ProgramFolder[] }),
  });

  const { data: folderEpisodesData } = useQuery({
    queryKey: ['media-folder-episodes', selectedFolderId],
    queryFn: () => mediaApi.programFolderEpisodes(selectedFolderId).then(r => r.data as { episodes: MediaFile[] }),
    enabled: !!selectedFolderId,
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
      void invalidateMedia(qc);
    }
  }, [qc]);

  useWebSocket(handleWs);

  const handleScan = async () => {
    setScanning(true);
    setScanProgress(null);
    setActionError(null);
    await mediaApi.scan().catch(() => setScanning(false));
  };

  const handleOpenFolder = (folderId: string) => {
    setSelectedFolderId(folderId);
    setActiveTab('folderEpisodes');
  };

  const handleTrashFile = async (file: MediaFile) => {
    const title = mediaTitle(file);
    if (!window.confirm(`إرسال الحلقة/الملف إلى سلة المحذوفات؟\n${title}`)) return;
    setActionError(null);
    try {
      await mediaApi.trashFile(file.id);
      if (previewFile?.id === file.id) setPreviewFile(null);
      await invalidateMedia(qc);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const handleTrashFolder = async (folder: ProgramFolder) => {
    if (!window.confirm(`إرسال مجلد البرنامج وكل حلقاته إلى سلة المحذوفات؟\n${folder.display_name_ar}`)) return;
    setActionError(null);
    try {
      await mediaApi.trashProgramFolder(folder.id);
      if (selectedFolderId === folder.id) setSelectedFolderId('');
      await invalidateMedia(qc);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const files = data?.files ?? [];
  const folders = foldersData?.folders ?? [];
  const selectedFolder = folders.find(folder => folder.id === selectedFolderId) ?? null;
  const folderEpisodes = folderEpisodesData?.episodes ?? [];
  const filteredFiles = files.filter(file => matchesSearch(mediaTitle(file), search));
  const filteredFolders = folders.filter(folder =>
    matchesSearch(folder.display_name_ar, search) || matchesSearch(folder.original_relative_path, search)
  );
  const filteredFolderEpisodes = folderEpisodes.filter(file => matchesSearch(mediaTitle(file), search));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">مكتبة الوسائط</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            إدارة الحلقات ومجلدات البرامج والمعاينة قبل التشغيل.
          </p>
        </div>
        <button onClick={handleScan} disabled={scanning} className="btn-primary flex items-center gap-2">
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? 'جارٍ الفحص...' : 'فحص المكتبة'}
        </button>
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

      {statsData && (
        <div className="flex flex-wrap gap-2">
          {statsData.stats.map(s => (
            <span key={s.status} className={`badge ${STATUS_BADGE[s.status] ?? 'badge-info'}`}>
              {STATUS_LABELS[s.status] ?? s.status}: {s.count}
            </span>
          ))}
        </div>
      )}

      {actionError && (
        <div className="card flex items-center justify-between gap-3" style={{ borderColor: 'var(--danger)' }}>
          <span className="text-sm" style={{ color: 'var(--danger)' }}>{actionError}</span>
          <button className="btn-ghost px-2 py-1" onClick={() => setActionError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--bg-border)' }}>
          <TabButton active={activeTab === 'files'} onClick={() => setActiveTab('files')} icon={<ListVideo size={14} />} label="الحلقات" />
          <TabButton active={activeTab === 'folders'} onClick={() => setActiveTab('folders')} icon={<FolderOpen size={14} />} label="مجلدات البرامج" />
          <TabButton
            active={activeTab === 'folderEpisodes'}
            onClick={() => setActiveTab('folderEpisodes')}
            icon={<ListVideo size={14} />}
            label="حلقات المجلد"
          />
        </div>

        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute top-2.5 right-2.5" style={{ color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث..."
            className="w-full pr-8 pl-3 py-2 rounded-md text-sm"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
          />
        </div>

        {activeTab === 'files' && (
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 rounded-md text-sm"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
          >
            <option value="">جميع الحالات</option>
            {Object.entries(STATUS_LABELS)
              .filter(([key]) => !['provisional', 'indexed', 'needs_review'].includes(key))
              .map(([key, value]) => (
                <option key={key} value={key}>{value}</option>
              ))}
          </select>
        )}
      </div>

      {activeTab === 'files' && (
        <>
          <MediaFilesTable
            files={filteredFiles}
            onPreview={setPreviewFile}
            onTrash={handleTrashFile}
            emptyText="لا توجد حلقات أو ملفات"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {data?.total ?? 0} ملف إجمالاً
            </span>
            <div className="flex gap-2">
              <button className="btn-ghost text-xs px-3 py-1.5" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>السابق</button>
              <span className="px-3 py-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>صفحة {page}</span>
              <button className="btn-ghost text-xs px-3 py-1.5" onClick={() => setPage(p => p + 1)} disabled={(data?.files.length ?? 0) < 100}>التالي</button>
            </div>
          </div>
        </>
      )}

      {activeTab === 'folders' && (
        <ProgramFoldersTable folders={filteredFolders} onOpen={handleOpenFolder} onTrash={handleTrashFolder} />
      )}

      {activeTab === 'folderEpisodes' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedFolderId}
              onChange={e => setSelectedFolderId(e.target.value)}
              className="px-3 py-2 rounded-md text-sm min-w-[260px]"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
            >
              <option value="">اختر مجلد برنامج</option>
              {folders.map(folder => (
                <option key={folder.id} value={folder.id}>{folder.display_name_ar}</option>
              ))}
            </select>
            {selectedFolder && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                أطول حلقة: {formatDurationMs(selectedFolder.active_longest_file_duration_ms)}
              </span>
            )}
          </div>
          <MediaFilesTable
            files={filteredFolderEpisodes}
            onPreview={setPreviewFile}
            onTrash={handleTrashFile}
            emptyText={selectedFolderId ? 'لا توجد حلقات داخل هذا المجلد' : 'اختر مجلد برنامج لعرض حلقاته'}
          />
        </div>
      )}

      {previewFile && (
        <VideoPreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onTrash={handleTrashFile} />
      )}
    </div>
  );
}

function TabButton(props: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex items-center gap-2 px-3 py-2 text-sm"
      style={{
        background: props.active ? 'rgba(232,160,32,0.12)' : 'transparent',
        color: props.active ? 'var(--accent)' : 'var(--text-muted)',
        borderLeft: '1px solid var(--bg-border)',
      }}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

function ProgramFoldersTable(props: {
  folders: ProgramFolder[];
  onOpen: (folderId: string) => void;
  onTrash: (folder: ProgramFolder) => void;
}) {
  return (
    <div className="card p-0 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
            {['مجلد البرنامج', 'الجذر', 'عدد الحلقات', 'مدة أطول حلقة', 'إجمالي المدة', 'الحالة', 'إجراءات'].map(h => (
              <th key={h} className="text-right px-4 py-3 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.folders.map((folder, index) => (
            <tr key={folder.id} style={{ borderBottom: index < props.folders.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
              <td className="px-4 py-2.5">
                <div className="font-medium">{folder.display_name_ar}</div>
                <div className="text-xs ltr-text truncate max-w-md" style={{ color: 'var(--text-muted)' }}>{folder.original_relative_path}</div>
              </td>
              <td className="px-4 py-2.5"><span className="badge badge-info">{folder.root_key}</span></td>
              <td className="px-4 py-2.5">{folder.active_file_count ?? folder.file_count}</td>
              <td className="px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>{formatDurationMs(folder.active_longest_file_duration_ms)}</td>
              <td className="px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>{formatDurationMs(folder.active_total_duration_ms)}</td>
              <td className="px-4 py-2.5">
                <span className={`badge ${STATUS_BADGE[folder.status] ?? 'badge-info'}`}>{STATUS_LABELS[folder.status] ?? folder.status}</span>
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <IconButton title="عرض الحلقات" onClick={() => props.onOpen(folder.id)} icon={<FolderOpen size={14} />} />
                  <IconButton title="إرسال إلى السلة" danger onClick={() => props.onTrash(folder)} icon={<Trash2 size={14} />} />
                </div>
              </td>
            </tr>
          ))}
          {props.folders.length === 0 && (
            <tr><td colSpan={7} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>لا توجد مجلدات برامج</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function MediaFilesTable(props: {
  files: MediaFile[];
  onPreview: (file: MediaFile) => void;
  onTrash: (file: MediaFile) => void;
  emptyText: string;
}) {
  return (
    <div className="card p-0 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
            {['الحلقة / الملف', 'المجلد', 'النوع', 'الحالة', 'مدة الحلقة', 'الدقة', 'الكودك', 'إجراءات'].map(h => (
              <th key={h} className="text-right px-4 py-3 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.files.map((file, index) => (
            <tr key={file.id} style={{ borderBottom: index < props.files.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
              <td className="px-4 py-2.5 max-w-sm">
                <div className="font-medium truncate">{mediaTitle(file)}</div>
                <div className="text-xs ltr-text truncate" style={{ color: 'var(--text-muted)' }}>{file.filename}</div>
              </td>
              <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{file.folder_name_ar ?? file.root_key ?? '—'}</td>
              <td className="px-4 py-2.5"><span className="badge badge-info">{file.type}</span></td>
              <td className="px-4 py-2.5">
                <span className={`badge ${STATUS_BADGE[file.status] ?? ''}`}>{STATUS_LABELS[file.status] ?? file.status}</span>
              </td>
              <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                {formatFileDuration(file)}
              </td>
              <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                {file.width && file.height ? `${file.width}×${file.height}` : '—'}
              </td>
              <td className="px-4 py-2.5 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {file.video_codec ?? '—'}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <IconButton title="معاينة الفيديو" onClick={() => props.onPreview(file)} icon={<Eye size={14} />} />
                  <IconButton title="إرسال إلى السلة" danger onClick={() => props.onTrash(file)} icon={<Trash2 size={14} />} />
                </div>
              </td>
            </tr>
          ))}
          {props.files.length === 0 && (
            <tr><td colSpan={8} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>{props.emptyText}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function VideoPreviewModal(props: {
  file: MediaFile;
  onClose: () => void;
  onTrash: (file: MediaFile) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5" style={{ background: 'rgba(0,0,0,0.72)' }}>
      <div className="w-full max-w-4xl rounded-lg overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--bg-border)' }}>
        <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--bg-border)' }}>
          <div className="min-w-0">
            <div className="font-medium truncate">{mediaTitle(props.file)}</div>
            <div className="text-xs ltr-text truncate" style={{ color: 'var(--text-muted)' }}>
              {formatFileDuration(props.file)} · {props.file.filename}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-danger flex items-center gap-2 text-xs px-3 py-2" onClick={() => props.onTrash(props.file)}>
              <Trash2 size={14} />
              إلى السلة
            </button>
            <button className="btn-ghost px-2 py-2" onClick={props.onClose} title="إغلاق">
              <X size={16} />
            </button>
          </div>
        </div>
        <video
          controls
          autoPlay
          className="w-full bg-black"
          style={{ maxHeight: '70vh', direction: 'ltr' }}
          src={`/api/media/files/${props.file.id}/stream`}
        />
      </div>
    </div>
  );
}

function IconButton(props: { title: string; icon: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      className="btn-ghost px-2 py-1.5"
      style={props.danger ? { color: 'var(--danger)' } : undefined}
    >
      {props.icon}
    </button>
  );
}

function mediaTitle(file: MediaFile): string {
  return file.display_title_ar || file.original_filename || file.filename;
}

function matchesSearch(value: string, search: string): boolean {
  return !search || value.toLowerCase().includes(search.toLowerCase());
}

function formatFileDuration(file: MediaFile): string {
  if (file.duration_ms !== undefined && file.duration_ms !== null) {
    return formatDurationMs(file.duration_ms);
  }
  if (file.duration_sec !== null && file.duration_sec !== undefined) {
    return formatDurationMs(Math.round(file.duration_sec * 1000));
  }
  return '—';
}

function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function errorMessage(err: unknown): string {
  if (typeof err === 'object' && err && 'response' in err) {
    const maybe = err as { response?: { data?: { error?: string } } };
    return maybe.response?.data?.error ?? 'تعذر تنفيذ العملية';
  }
  return 'تعذر تنفيذ العملية';
}

async function invalidateMedia(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['media-files'] }),
    qc.invalidateQueries({ queryKey: ['media-stats'] }),
    qc.invalidateQueries({ queryKey: ['media-program-folders'] }),
    qc.invalidateQueries({ queryKey: ['media-folder-episodes'] }),
    qc.invalidateQueries({ queryKey: ['media-trash'] }),
  ]);
}
