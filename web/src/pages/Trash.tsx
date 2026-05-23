import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RotateCcw, Trash2, X } from 'lucide-react';
import { mediaApi } from '../api/client';

interface TrashItem {
  kind: 'file' | 'folder';
  id: string;
  title: string;
  path: string;
  filename?: string | null;
  duration_sec?: number | null;
  duration_ms?: number | null;
  file_size?: number | null;
  file_count?: number | null;
  total_duration_ms?: number | null;
  longest_file_duration_ms?: number | null;
  status: string;
  trashed_at: string | null;
  trash_reason?: string | null;
  trashed_by_email?: string | null;
  folder_name_ar?: string | null;
  root_key?: string | null;
}

export default function TrashPage() {
  const qc = useQueryClient();
  const [deleteItem, setDeleteItem] = useState<TrashItem | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['media-trash'],
    queryFn: () => mediaApi.trash().then(r => r.data as { items: TrashItem[] }),
  });

  const items = data?.items ?? [];

  const restoreItem = async (item: TrashItem) => {
    setActionError(null);
    setBusyId(item.id);
    try {
      await mediaApi.restoreTrashItem(item.kind, item.id);
      await invalidateTrash(qc);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const permanentlyDelete = async () => {
    if (!deleteItem) return;
    setActionError(null);
    setBusyId(deleteItem.id);
    try {
      await mediaApi.deleteTrashItem(deleteItem.kind, deleteItem.id, adminPassword);
      setDeleteItem(null);
      setAdminPassword('');
      await invalidateTrash(qc);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">سلة المحذوفات</h2>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          العناصر هنا مخفية من مكتبة الوسائط. الحذف النهائي يتطلب كلمة مرور المدير.
        </p>
      </div>

      {actionError && (
        <div className="card flex items-center justify-between gap-3" style={{ borderColor: 'var(--danger)' }}>
          <span className="text-sm" style={{ color: 'var(--danger)' }}>{actionError}</span>
          <button className="btn-ghost px-2 py-1" onClick={() => setActionError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['العنصر', 'النوع', 'المدة / العدد', 'الجذر', 'أرسل للسلة بواسطة', 'تاريخ الإرسال', 'إجراءات'].map(h => (
                <th key={h} className="text-right px-4 py-3 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={`${item.kind}-${item.id}`} style={{ borderBottom: index < items.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
                <td className="px-4 py-2.5 max-w-sm">
                  <div className="font-medium truncate">{item.title}</div>
                  <div className="text-xs ltr-text truncate" style={{ color: 'var(--text-muted)' }}>{item.path}</div>
                  {item.trash_reason && (
                    <div className="text-xs mt-1" style={{ color: 'var(--warning)' }}>{item.trash_reason}</div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span className="badge badge-info">{item.kind === 'folder' ? 'برنامج' : 'حلقة'}</span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{durationOrCount(item)}</td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{item.root_key ?? '—'}</td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{item.trashed_by_email ?? '—'}</td>
                <td className="px-4 py-2.5 text-xs ltr-text" style={{ color: 'var(--text-muted)' }}>
                  {item.trashed_at ?? '—'}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      title="استرجاع"
                      disabled={busyId === item.id}
                      className="btn-ghost px-2 py-1.5"
                      onClick={() => void restoreItem(item)}
                    >
                      <RotateCcw size={14} />
                    </button>
                    <button
                      type="button"
                      title="حذف نهائي"
                      disabled={busyId === item.id}
                      className="btn-ghost px-2 py-1.5"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => {
                        setDeleteItem(item);
                        setAdminPassword('');
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!isLoading && items.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>السلة فارغة</td></tr>
            )}
            {isLoading && (
              <tr><td colSpan={7} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>جارٍ التحميل...</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {deleteItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-5" style={{ background: 'rgba(0,0,0,0.72)' }}>
          <form
            className="w-full max-w-lg rounded-lg overflow-hidden"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--bg-border)' }}
            onSubmit={event => {
              event.preventDefault();
              void permanentlyDelete();
            }}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--bg-border)' }}>
              <div className="flex items-center gap-2 font-medium">
                <KeyRound size={16} />
                حذف نهائي
              </div>
              <button className="btn-ghost px-2 py-2" type="button" onClick={() => setDeleteItem(null)} title="إغلاق">
                <X size={16} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                سيتم حذف {deleteItem.kind === 'folder' ? 'مجلد البرنامج وكل ملفاته' : 'الحلقة'} من القرص ومن قاعدة البيانات.
              </p>
              <div className="rounded-md p-3 ltr-text text-xs truncate" style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)' }}>
                {deleteItem.path}
              </div>
              <input
                type="password"
                value={adminPassword}
                onChange={event => setAdminPassword(event.target.value)}
                placeholder="كلمة مرور المدير"
                className="w-full px-3 py-2 rounded-md text-sm"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--bg-border)' }}>
              <button type="button" className="btn-ghost" onClick={() => setDeleteItem(null)}>إلغاء</button>
              <button type="submit" className="btn-danger flex items-center gap-2" disabled={!adminPassword || busyId === deleteItem.id}>
                <Trash2 size={14} />
                حذف نهائي
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function durationOrCount(item: TrashItem): string {
  if (item.kind === 'folder') {
    return `${item.file_count ?? 0} حلقة · أطول: ${formatDurationMs(item.longest_file_duration_ms)}`;
  }
  if (item.duration_ms !== undefined && item.duration_ms !== null) {
    return formatDurationMs(item.duration_ms);
  }
  if (item.duration_sec !== undefined && item.duration_sec !== null) {
    return formatDurationMs(Math.round(item.duration_sec * 1000));
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

async function invalidateTrash(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['media-trash'] }),
    qc.invalidateQueries({ queryKey: ['media-files'] }),
    qc.invalidateQueries({ queryKey: ['media-program-folders'] }),
    qc.invalidateQueries({ queryKey: ['media-folder-episodes'] }),
    qc.invalidateQueries({ queryKey: ['media-stats'] }),
  ]);
}
