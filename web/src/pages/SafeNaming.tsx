import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  Eye,
  FolderOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Tag,
  Upload,
  XCircle,
} from 'lucide-react';
import { schedulerFoundationApi } from '../api/client';

// ── Types ────────────────────────────────────────────────────────────────────

interface RegistryRoot {
  root_key: string;
  absolute_path: string;
  exists: boolean;
  is_readonly: number;
  folderCount: number;
  fileCount: number;
}

interface RegistryStatus {
  roots: RegistryRoot[];
  totals: {
    roots: number;
    folders: number;
    files: number;
    provisionalFiles: number;
    candidates: number;
  };
}

interface SafeNamingRow {
  id: string;
  originalArabicName: string;
  originalPath: string;
  displayName: string;
  normalizedName: string;
  safeSlug: string;
  root: string;
  reviewStatus: 'approved' | 'pending' | 'needs_review' | 'rejected';
  schedulingStatus: string;
  archiveStatus: string;
  collisionGroup: string | null;
}

interface SafeNamingImportEntry extends SafeNamingRow {
  candidateType: string;
  reason: string;
}

interface ControlPanel {
  mode: 'control-panel';
  rows: SafeNamingRow[];
  needsReview: SafeNamingRow[];
  slugCollisions: Array<{ safeSlug: string; entries: SafeNamingRow[] }>;
}

interface ImportPreview {
  mode: 'preview';
  entryCount: number;
  entries: SafeNamingImportEntry[];
  needsReview: SafeNamingImportEntry[];
  slugCollisions: Array<{ safeSlug: string; entries: SafeNamingImportEntry[] }>;
}

interface ApplyResult {
  mode: 'dry_run' | 'applied';
  entriesConsidered?: number;
  safeNameMappingsWritten: number;
  safeNameMappingsSkipped?: number;
}

interface ProgramCandidate {
  folder_id: string;
  suggested_program_key: string;
  display_name_ar: string;
  safe_slug: string;
  episode_count: number;
  play_mode_suggestion: string;
  slot_mode_suggestion: string;
  confidence_score: number;
  needs_review: boolean;
}

interface QuickMapping {
  originalName: string;
  normalizedName: string;
  safeSlug: string;
  collisionGroup: string | null;
}

type TabKey = 'panel' | 'candidates' | 'import' | 'quick';

const CONFIRM_TEXT = 'IMPORT SAFE NAMING';

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SafeNamingPage() {
  const [tab, setTab] = useState<TabKey>('panel');
  const fileRef = useRef<HTMLInputElement>(null);

  // Registry
  const [registry, setRegistry] = useState<RegistryStatus | null>(null);

  // Control panel
  const [panel, setPanel] = useState<ControlPanel | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [panelFilter, setPanelFilter] = useState('');
  const [showNeedsReview, setShowNeedsReview] = useState(false);

  // Program candidates
  const [candidates, setCandidates] = useState<ProgramCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState('');

  // CSV import
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [importError, setImportError] = useState('');

  // Quick preview
  const [quickInput, setQuickInput] = useState('');
  const [quickMappings, setQuickMappings] = useState<QuickMapping[]>([]);
  const [quickLoading, setQuickLoading] = useState(false);

  useEffect(() => {
    void loadRegistry();
    void loadPanel();
  }, []);

  // ── Loaders ──────────────────────────────────────────────────────────────

  const loadRegistry = async () => {
    try {
      const res = await schedulerFoundationApi.registryStatus();
      setRegistry(res.data as RegistryStatus);
    } catch {
      // non-fatal — registry card shows zeros
    }
  };

  const loadPanel = async () => {
    setPanelLoading(true);
    setPanelError('');
    try {
      const res = await schedulerFoundationApi.safeNamingControlPanel();
      setPanel(res.data as ControlPanel);
    } catch {
      setPanelError('تعذر تحميل لوحة المراقبة.');
    } finally {
      setPanelLoading(false);
    }
  };

  const loadCandidates = async () => {
    if (candidates.length > 0) return;
    setCandidatesLoading(true);
    setCandidatesError('');
    try {
      const res = await schedulerFoundationApi.programCandidates();
      const body = res.data as { candidates: ProgramCandidate[] };
      setCandidates(body.candidates ?? []);
    } catch {
      setCandidatesError('تعذر تحميل مرشحي البرامج.');
    } finally {
      setCandidatesLoading(false);
    }
  };

  // ── Import handlers ───────────────────────────────────────────────────────

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setImportFile(file);
    setImportPreview(null);
    setApplyResult(null);
    setImportError('');
    setConfirmText('');
  };

  const runPreview = async () => {
    if (!importFile) return;
    setPreviewLoading(true);
    setImportError('');
    setImportPreview(null);
    setApplyResult(null);
    try {
      const res = await schedulerFoundationApi.safeNamingImportPreviewFile(importFile);
      setImportPreview(res.data as ImportPreview);
    } catch (err: unknown) {
      const msg = extractError(err);
      setImportError(msg || 'تعذر معاينة ملف CSV.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const runApply = async (dryRun: boolean) => {
    if (!importFile) return;
    if (!dryRun && confirmText !== CONFIRM_TEXT) return;
    setApplying(true);
    setImportError('');
    try {
      const res = await schedulerFoundationApi.safeNamingImportApplyFile(importFile, confirmText, dryRun);
      setApplyResult(res.data as ApplyResult);
      if (!dryRun) {
        void loadPanel();
        void loadRegistry();
      }
    } catch (err: unknown) {
      const msg = extractError(err);
      setImportError(msg || 'تعذر تطبيق الاستيراد.');
    } finally {
      setApplying(false);
    }
  };

  // ── Quick preview ─────────────────────────────────────────────────────────

  const runQuickPreview = async () => {
    const names = quickInput
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    setQuickLoading(true);
    try {
      const res = await schedulerFoundationApi.safeNamingPreview(names);
      const body = res.data as { mappings: QuickMapping[] };
      setQuickMappings(body.mappings ?? []);
    } catch {
      setQuickMappings([]);
    } finally {
      setQuickLoading(false);
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const filteredRows = (panel?.rows ?? []).filter(row =>
    !panelFilter ||
    row.originalArabicName.includes(panelFilter) ||
    row.safeSlug.includes(panelFilter) ||
    row.root.includes(panelFilter)
  );

  const displayRows = showNeedsReview ? (panel?.needsReview ?? []) : filteredRows;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Tag size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xl font-bold">نظام التسمية الآمنة</h2>
            <span className="badge badge-info">read-only DB view</span>
            <span className="badge badge-info">no media rename</span>
            <span className="badge badge-info">no file moves</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            عرض الأسماء العربية وتحويلها إلى slugs آمنة — الأسماء الأصلية محفوظة دائمًا.
          </p>
        </div>
        <button
          className="btn-ghost flex items-center gap-2 text-sm"
          onClick={() => { void loadRegistry(); void loadPanel(); }}
        >
          <RefreshCw size={14} />
          تحديث
        </button>
      </section>

      {/* Registry stats */}
      {registry && (
        <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard label="الجذور" value={registry.totals.roots} />
          <StatCard label="المجلدات" value={registry.totals.folders} />
          <StatCard label="الملفات" value={registry.totals.files} />
          <StatCard label="المرشحون" value={registry.totals.candidates} tone="ready" />
          <StatCard label="تحتاج مراجعة" value={panel?.needsReview.length ?? 0} tone="warning" />
        </section>
      )}

      {/* Tabs */}
      <section className="flex flex-wrap gap-2">
        {([
          { key: 'panel',      label: 'لوحة المراقبة', icon: Database },
          { key: 'candidates', label: 'مرشحو البرامج', icon: FolderOpen },
          { key: 'import',     label: 'استيراد CSV',   icon: Upload },
          { key: 'quick',      label: 'معاينة الأسماء', icon: Search },
        ] as Array<{ key: TabKey; label: string; icon: React.ElementType }>).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className="btn-ghost flex items-center gap-2 text-sm px-3 py-2"
            style={{
              background: tab === key ? 'rgba(232,160,32,0.12)' : undefined,
              color: tab === key ? 'var(--accent)' : undefined,
            }}
            onClick={() => {
              setTab(key);
              if (key === 'candidates') void loadCandidates();
            }}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </section>

      {/* ── Control Panel Tab ── */}
      {tab === 'panel' && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">الأسماء الآمنة الحالية في قاعدة البيانات</h3>
              {panel && (
                <span className="badge badge-info">{panel.rows.length} سجل</span>
              )}
              {panel && panel.slugCollisions.length > 0 && (
                <span className="badge badge-error">{panel.slugCollisions.length} تعارض</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <button
                className={`btn-ghost text-xs px-2 py-1 ${showNeedsReview ? '' : 'opacity-50'}`}
                style={{ color: showNeedsReview ? 'var(--warning)' : undefined }}
                onClick={() => setShowNeedsReview(v => !v)}
              >
                <AlertTriangle size={12} className="inline ml-1" />
                تحتاج مراجعة ({panel?.needsReview.length ?? 0})
              </button>
            </div>
          </div>

          {!showNeedsReview && (
            <div className="flex items-center gap-2 rounded-md border px-3 py-2" style={{ borderColor: 'var(--bg-border)' }}>
              <Search size={14} style={{ color: 'var(--text-muted)' }} />
              <input
                className="flex-1 bg-transparent text-sm outline-none"
                placeholder="بحث: اسم عربي، slug، أو root..."
                value={panelFilter}
                onChange={e => setPanelFilter(e.target.value)}
              />
            </div>
          )}

          {panelError && <p className="text-xs" style={{ color: 'var(--danger)' }}>{panelError}</p>}

          <SafeNamingTable
            rows={displayRows}
            loading={panelLoading}
            emptyMsg={panelLoading ? 'جارٍ التحميل...' : 'لا توجد سجلات'}
          />

          {panel && panel.slugCollisions.length > 0 && (
            <div className="card space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--danger)' }}>
                <XCircle size={15} />
                تعارضات في الـ Slug
              </div>
              {panel.slugCollisions.map(col => (
                <div key={col.safeSlug} className="text-xs rounded-md border px-3 py-2" style={{ borderColor: 'var(--danger)' }}>
                  <span className="font-mono" style={{ color: 'var(--danger)' }}>{col.safeSlug}</span>
                  {' — '}
                  {col.entries.map(e => e.originalArabicName || e.originalPath).join(' | ')}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Program Candidates Tab ── */}
      {tab === 'candidates' && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">مرشحو البرامج من المجلدات</h3>
            {candidates.length > 0 && <span className="badge badge-info">{candidates.length} مرشح</span>}
          </div>
          {candidatesError && <p className="text-xs" style={{ color: 'var(--danger)' }}>{candidatesError}</p>}
          <div className="card p-0 overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
                  {['الاسم العربي', 'safe_slug', 'program_key المقترح', 'الحلقات', 'play_mode', 'slot_mode', 'الثقة', 'مراجعة'].map(h => (
                    <th key={h} className="text-right px-4 py-3 font-medium text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {candidatesLoading ? (
                  <tr><td colSpan={8} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>جارٍ التحميل...</td></tr>
                ) : candidates.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>لا توجد مرشحات</td></tr>
                ) : candidates.map((c, i) => (
                  <tr key={c.folder_id} style={{ borderBottom: i < candidates.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
                    <td className="px-4 py-3">{c.display_name_ar}</td>
                    <td className="px-4 py-3 font-mono text-xs">{c.safe_slug}</td>
                    <td className="px-4 py-3 font-mono text-xs">{c.suggested_program_key}</td>
                    <td className="px-4 py-3">{c.episode_count}</td>
                    <td className="px-4 py-3 text-xs">{c.play_mode_suggestion}</td>
                    <td className="px-4 py-3 text-xs">{c.slot_mode_suggestion}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${c.confidence_score >= 0.7 ? 'badge-ready' : c.confidence_score >= 0.4 ? 'badge-warning' : 'badge-error'}`}>
                        {Math.round(c.confidence_score * 100)}%
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {c.needs_review
                        ? <span className="badge badge-warning">يحتاج مراجعة</span>
                        : <span className="badge badge-ready">جاهز</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Import CSV Tab ── */}
      {tab === 'import' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">استيراد CSV للأسماء الآمنة</h3>
            <span className="badge badge-warning">يتطلب تأكيدًا نصيًا</span>
            <span className="badge badge-info">لا تعديل على الملفات</span>
          </div>

          {/* Safety */}
          <div className="rounded-md border p-3" style={{ borderColor: 'var(--bg-border)', background: 'rgba(232,160,32,0.06)' }}>
            <div className="flex items-center gap-2 text-xs font-medium mb-2">
              <ShieldCheck size={13} style={{ color: 'var(--accent)' }} />
              ضمانات الأمان
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {['لا إعادة تسمية للملفات', 'لا نقل', 'لا حذف', 'الأسماء الأصلية محفوظة', 'لا تغيير في البث المباشر'].map(g => (
                <span key={g} className="badge badge-info">{g}</span>
              ))}
            </div>
          </div>

          {/* File pick */}
          <div className="rounded-md border p-4 space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <Upload size={15} style={{ color: 'var(--accent)' }} />
                <span>{importFile ? importFile.name : 'لم يتم اختيار ملف CSV بعد'}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-ghost text-sm" onClick={() => fileRef.current?.click()}>
                  اختر ملف CSV
                </button>
                <button
                  className="btn-primary flex items-center gap-2 text-sm"
                  disabled={!importFile || previewLoading}
                  onClick={() => void runPreview()}
                >
                  <Eye size={14} />
                  {previewLoading ? 'جارٍ المعاينة...' : 'معاينة'}
                </button>
              </div>
            </div>
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
            {importError && <p className="text-xs" style={{ color: 'var(--danger)' }}>{importError}</p>}
          </div>

          {/* Preview results */}
          {importPreview && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="إجمالي السجلات" value={importPreview.entryCount} />
                <StatCard label="جاهز للاستيراد" value={importPreview.entries.length - importPreview.needsReview.length} tone="ready" />
                <StatCard label="يحتاج مراجعة" value={importPreview.needsReview.length} tone="warning" />
                <StatCard label="تعارضات Slug" value={importPreview.slugCollisions.length} tone={importPreview.slugCollisions.length > 0 ? 'error' : undefined} />
              </div>

              {importPreview.slugCollisions.length > 0 && (
                <div className="card" style={{ border: '1px solid var(--danger)' }}>
                  <p className="text-xs font-medium mb-2" style={{ color: 'var(--danger)' }}>
                    يجب حل التعارضات قبل التطبيق:
                  </p>
                  {importPreview.slugCollisions.map(col => (
                    <div key={col.safeSlug} className="text-xs mb-1">
                      <span className="font-mono" style={{ color: 'var(--danger)' }}>{col.safeSlug}</span>
                      {' — '}
                      {col.entries.map(e => e.originalArabicName || e.originalPath).join(' | ')}
                    </div>
                  ))}
                </div>
              )}

              <ImportEntriesTable entries={importPreview.entries.slice(0, 50)} />
              {importPreview.entries.length > 50 && (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  معروضة أول 50 من {importPreview.entryCount} — افحص الملف لرؤية الباقي
                </p>
              )}

              {/* Dry run + Apply */}
              <div className="rounded-md border p-4 space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
                <p className="text-sm font-medium">تطبيق الاستيراد</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn-ghost flex items-center gap-2 text-sm"
                    disabled={applying}
                    onClick={() => void runApply(true)}
                  >
                    <ShieldCheck size={14} />
                    {applying ? 'جارٍ...' : 'اختبار جاف (Dry Run)'}
                  </button>
                </div>
                {importPreview.slugCollisions.length === 0 && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        اكتب النص التالي بالضبط للتأكيد:
                        <span className="font-mono mr-1" style={{ color: 'var(--accent)' }}>{CONFIRM_TEXT}</span>
                      </label>
                      <input
                        className="w-full rounded-md border px-3 py-2 bg-transparent text-sm"
                        style={{ borderColor: 'var(--bg-border)' }}
                        placeholder={CONFIRM_TEXT}
                        value={confirmText}
                        onChange={e => setConfirmText(e.target.value)}
                      />
                    </div>
                    <button
                      className="btn-primary flex items-center gap-2 text-sm"
                      disabled={confirmText !== CONFIRM_TEXT || applying}
                      onClick={() => void runApply(false)}
                    >
                      <CheckCircle2 size={14} />
                      {applying ? 'جارٍ التطبيق...' : 'تطبيق الاستيراد'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Apply result */}
          {applyResult && (
            <div
              className="card"
              style={{ border: `1px solid ${applyResult.mode === 'applied' ? 'var(--success)' : 'var(--accent)'}` }}
            >
              <div className="flex items-center gap-2 font-medium text-sm mb-2" style={{ color: applyResult.mode === 'applied' ? 'var(--success)' : 'var(--accent)' }}>
                <CheckCircle2 size={15} />
                {applyResult.mode === 'applied' ? 'تم التطبيق بنجاح' : 'نتيجة الاختبار الجاف'}
              </div>
              <div className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
                <div>السجلات المُكتبة: <strong>{applyResult.safeNameMappingsWritten}</strong></div>
                {applyResult.entriesConsidered !== undefined && (
                  <div>السجلات المُعالجة: <strong>{applyResult.entriesConsidered}</strong></div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Quick Preview Tab ── */}
      {tab === 'quick' && (
        <section className="space-y-4">
          <h3 className="font-semibold">معاينة الأسماء الآمنة</h3>
          <div className="rounded-md border p-4 space-y-3" style={{ borderColor: 'var(--bg-border)' }}>
            <label className="text-xs space-y-1 block" style={{ color: 'var(--text-muted)' }}>
              أدخل أسماء عربية (سطر لكل اسم):
            </label>
            <textarea
              className="w-full rounded-md border px-3 py-2 bg-transparent text-sm"
              style={{ borderColor: 'var(--bg-border)', minHeight: '120px', fontFamily: 'inherit' }}
              placeholder={'برنامج التفسير\nقصص الأنبياء\nنور الإسلام'}
              value={quickInput}
              onChange={e => setQuickInput(e.target.value)}
            />
            <button
              className="btn-primary flex items-center gap-2 text-sm"
              disabled={!quickInput.trim() || quickLoading}
              onClick={() => void runQuickPreview()}
            >
              <Search size={14} />
              {quickLoading ? 'جارٍ الحساب...' : 'احسب الـ Slugs'}
            </button>
          </div>

          {quickMappings.length > 0 && (
            <div className="card p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
                    {['الاسم الأصلي', 'الاسم المُعيَّر', 'Safe Slug', 'تعارض'].map(h => (
                      <th key={h} className="text-right px-4 py-3 font-medium text-xs" style={{ color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {quickMappings.map((m, i) => (
                    <tr key={i} style={{ borderBottom: i < quickMappings.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
                      <td className="px-4 py-3">{m.originalName}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{m.normalizedName}</td>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--accent)' }}>{m.safeSlug}</td>
                      <td className="px-4 py-3">
                        {m.collisionGroup
                          ? <span className="badge badge-warning">{m.collisionGroup}</span>
                          : <span className="badge badge-ready">لا تعارض</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'ready' | 'warning' | 'error' }) {
  const color =
    tone === 'ready'   ? 'var(--success)' :
    tone === 'warning' ? 'var(--warning)' :
    tone === 'error'   ? 'var(--danger)'  :
    'var(--text-primary)';
  return (
    <div className="card">
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-2xl font-bold mt-1" style={{ color }}>{value}</div>
    </div>
  );
}

function ReviewBadge({ status }: { status: string }) {
  if (status === 'approved') return <span className="badge badge-ready">معتمد</span>;
  if (status === 'needs_review') return <span className="badge badge-warning">يحتاج مراجعة</span>;
  if (status === 'rejected') return <span className="badge badge-error">مرفوض</span>;
  return <span className="badge badge-pending">معلّق</span>;
}

function SafeNamingTable({ rows, loading, emptyMsg }: { rows: SafeNamingRow[]; loading: boolean; emptyMsg: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm min-w-[900px]">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
            {['الاسم العربي', 'Safe Slug', 'Root', 'الحالة', 'تعارض', 'تفاصيل'].map(h => (
              <th key={h} className="text-right px-4 py-3 font-medium text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={6} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>جارٍ التحميل...</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={6} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>{emptyMsg}</td></tr>
          ) : rows.map(row => (
            <>
              <tr
                key={row.id}
                style={{ borderBottom: '1px solid var(--bg-border)', cursor: 'pointer' }}
                onClick={() => setExpanded(expanded === row.id ? null : row.id)}
              >
                <td className="px-4 py-3 max-w-xs truncate">{row.originalArabicName || row.displayName || '—'}</td>
                <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--accent)' }}>{row.safeSlug}</td>
                <td className="px-4 py-3 text-xs">{row.root || '—'}</td>
                <td className="px-4 py-3"><ReviewBadge status={row.reviewStatus} /></td>
                <td className="px-4 py-3">
                  {row.collisionGroup
                    ? <span className="badge badge-warning text-xs">{row.collisionGroup}</span>
                    : <span style={{ color: 'var(--text-muted)' }}>—</span>
                  }
                </td>
                <td className="px-4 py-3">
                  {expanded === row.id
                    ? <ChevronUp size={13} style={{ color: 'var(--text-muted)' }} />
                    : <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} />
                  }
                </td>
              </tr>
              {expanded === row.id && (
                <tr key={`${row.id}-detail`} style={{ borderBottom: '1px solid var(--bg-border)' }}>
                  <td colSpan={6} className="px-4 py-3 text-xs" style={{ background: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)' }}>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div><div className="font-medium mb-1">المسار الأصلي</div><div className="font-mono break-all">{row.originalPath || '—'}</div></div>
                      <div><div className="font-medium mb-1">الاسم المُعيَّر</div><div className="font-mono break-all">{row.normalizedName || '—'}</div></div>
                      <div><div className="font-medium mb-1">schedulingStatus</div><div>{row.schedulingStatus}</div></div>
                      <div><div className="font-medium mb-1">archiveStatus</div><div>{row.archiveStatus}</div></div>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportEntriesTable({ entries }: { entries: SafeNamingImportEntry[] }) {
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm min-w-[860px]">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bg-border)', background: 'rgba(255,255,255,0.02)' }}>
            {['الاسم العربي', 'Safe Slug', 'Root', 'النوع', 'الحالة', 'ملاحظة'].map(h => (
              <th key={h} className="text-right px-4 py-3 font-medium text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i} style={{ borderBottom: i < entries.length - 1 ? '1px solid var(--bg-border)' : undefined }}>
              <td className="px-4 py-3 max-w-xs truncate">{e.originalArabicName || e.displayName || '—'}</td>
              <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--accent)' }}>{e.safeSlug}</td>
              <td className="px-4 py-3 text-xs">{e.root || '—'}</td>
              <td className="px-4 py-3 text-xs">{e.candidateType || '—'}</td>
              <td className="px-4 py-3"><ReviewBadge status={e.reviewStatus} /></td>
              <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{e.reason || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function extractError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    return e.response?.data?.error ?? e.message ?? '';
  }
  return String(err);
}
