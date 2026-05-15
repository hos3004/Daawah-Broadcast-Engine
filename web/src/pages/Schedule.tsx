import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { scheduleApi } from '../api/client';
import { Upload, CheckCircle, Globe, AlertTriangle } from 'lucide-react';
import dayjs from 'dayjs';

const STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة', validated: 'تم التحقق', published: 'منشور', archived: 'مؤرشف',
};
const STATUS_BADGE: Record<string, string> = {
  draft: 'badge-pending', validated: 'badge-info', published: 'badge-ready', archived: 'badge-warning',
};

interface Schedule {
  id: string; name: string; status: string; start_date: string; end_date: string;
  imported_by_email: string | null; published_by_email: string | null; published_at: string | null;
  item_count?: number; validation_report?: string;
}

export default function SchedulePage() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<Record<string, unknown> | null>(null);

  const { data } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => scheduleApi.list().then(r => r.data as { schedules: Schedule[] }),
  });

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      await scheduleApi.import(file, `جدول ${dayjs().format('YYYY-MM-DD HH:mm')}`);
      await qc.invalidateQueries({ queryKey: ['schedules'] });
    } catch (err) {
      alert(`فشل الاستيراد: ${String(err)}`);
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  const handleValidate = async (id: string) => {
    setActionId(id);
    try {
      const r = await scheduleApi.validate(id);
      setValidationResult(r.data as Record<string, unknown>);
      await qc.invalidateQueries({ queryKey: ['schedules'] });
    } catch (err) {
      alert(`فشل التحقق: ${String(err)}`);
    } finally {
      setActionId(null);
    }
  };

  const handlePublish = async (id: string) => {
    if (!confirm('تأكيد نشر هذا الجدول؟ سيصبح الجدول النشط للنظام.')) return;
    setActionId(id);
    try {
      await scheduleApi.publish(id);
      await qc.invalidateQueries({ queryKey: ['schedules'] });
    } catch (err) {
      alert(`فشل النشر: ${String(err)}`);
    } finally {
      setActionId(null);
    }
  };

  const schedules = data?.schedules ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">إدارة الجدول</h2>
        <div>
          <input ref={fileRef} type="file" accept=".json,.csv,.xlsx" className="hidden" onChange={handleImport} />
          <button className="btn-primary flex items-center gap-2" disabled={importing} onClick={() => fileRef.current?.click()}>
            <Upload size={14} />
            {importing ? 'جارٍ الاستيراد...' : 'استيراد جدول'}
          </button>
        </div>
      </div>

      {/* Validation result */}
      {validationResult && (
        <ValidationReport report={validationResult} onClose={() => setValidationResult(null)} />
      )}

      {/* Schedules table */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['الاسم', 'الفترة', 'الحالة', 'المستورد', 'إجراءات'].map(h => (
                <th key={h} className="text-right px-4 py-3 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {schedules.map((s, i) => (
              <tr key={s.id} style={{ borderBottom: i < schedules.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
                <td className="px-4 py-3 font-medium">{s.name}</td>
                <td className="px-4 py-3 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                  {s.start_date} → {s.end_date}
                </td>
                <td className="px-4 py-3">
                  <span className={`badge ${STATUS_BADGE[s.status] ?? ''}`}>{STATUS_LABELS[s.status] ?? s.status}</span>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {s.imported_by_email ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      className="btn-ghost text-xs px-2 py-1 flex items-center gap-1"
                      disabled={actionId === s.id}
                      onClick={() => handleValidate(s.id)}
                    >
                      <CheckCircle size={12} />
                      تحقق
                    </button>
                    {s.status === 'validated' || s.status === 'draft' ? (
                      <button
                        className="btn-primary text-xs px-2 py-1 flex items-center gap-1"
                        disabled={actionId === s.id}
                        onClick={() => handlePublish(s.id)}
                      >
                        <Globe size={12} />
                        نشر
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {schedules.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>لا يوجد جداول مستوردة بعد</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ValidationReport({ report, onClose }: { report: Record<string, unknown>; onClose: () => void }) {
  const issues = report['issues'] as Array<{ severity: string; code: string; message: string; date?: string }> ?? [];
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {report['isValid'] ? (
            <CheckCircle size={16} style={{ color: '#22c55e' }} />
          ) : (
            <AlertTriangle size={16} style={{ color: '#ef4444' }} />
          )}
          <span className="font-medium">
            {report['isValid'] ? 'الجدول صالح للنشر' : `${String(report['errors'])} أخطاء، ${String(report['warnings'])} تحذيرات`}
          </span>
        </div>
        <button className="btn-ghost text-xs px-2 py-1" onClick={onClose}>إغلاق</button>
      </div>

      {issues.length > 0 && (
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {errors.map((issue, i) => (
            <div key={i} className="text-xs p-2 rounded" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
              [{issue.date ?? ''}] {issue.message}
            </div>
          ))}
          {warnings.map((issue, i) => (
            <div key={i} className="text-xs p-2 rounded" style={{ background: 'rgba(245,158,11,0.1)', color: '#fbbf24' }}>
              [{issue.date ?? ''}] {issue.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
