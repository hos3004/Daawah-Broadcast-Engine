import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  Image,
  ListChecks,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Type,
} from 'lucide-react';
import { schedulerFoundationApi } from '../api/client';

type TabKey = 'logo' | 'ticker' | 'today' | 'preview';

interface SafeNamingRow {
  id: string;
  originalArabicName: string;
  originalPath: string;
  displayName: string;
  normalizedName: string;
  safeSlug: string;
  root: string;
  reviewStatus: string;
  schedulingStatus: string;
  archiveStatus: string;
  collisionGroup: string | null;
  manualSlugOverrideDraft: string | null;
}

interface SafeNamingPanel {
  rows: SafeNamingRow[];
  needsReview: SafeNamingRow[];
  slugCollisions: Array<{ safeSlug: string; entries: SafeNamingRow[] }>;
}

interface SafeNamingPreviewResponse {
  entries: SafeNamingRow[];
  needsReview: SafeNamingRow[];
  slugCollisions: Array<{ safeSlug: string; entries: SafeNamingRow[] }>;
}

interface LogoSettings {
  enabled: boolean;
  logoPath: string | null;
  logoAssetId: string | null;
  position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'custom';
  xMargin: number;
  yMargin: number;
  customX: number | null;
  customY: number | null;
  width: number | null;
  height: number | null;
  scale: number;
  opacity: number;
  safeArea: number;
}

interface TickerSettings {
  enabled: boolean;
  mode: 'manual' | 'today' | 'mixed';
  fontFamily: string;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  opacity: number;
  speedPixelsPerSecond: number;
  position: 'top' | 'bottom';
  safeArea: number;
  resolutionWidth: number;
  resolutionHeight: number;
  limitItems: number;
}

interface OverlaySettings {
  logo: LogoSettings;
  ticker: TickerSettings;
  updatedAt: string;
}

interface TodayScheduleItem {
  time: string;
  title: string;
  programKey: string | null;
}

interface TickerPreview {
  text: string;
  date: string;
  scheduleItems: TodayScheduleItem[];
  assPreview: string;
  tickerAssPath?: string;
  overlayManifestPath?: string;
}

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'logo', label: 'اللوجو' },
  { key: 'ticker', label: 'شريط الأخبار' },
  { key: 'today', label: 'تشاهدون اليوم' },
  { key: 'preview', label: 'معاينة التراكب' },
];

const defaultLogo: LogoSettings = {
  enabled: false,
  logoPath: null,
  logoAssetId: null,
  position: 'top-right',
  xMargin: 32,
  yMargin: 32,
  customX: null,
  customY: null,
  width: null,
  height: null,
  scale: 0.18,
  opacity: 0.9,
  safeArea: 24,
};

const defaultTicker: TickerSettings = {
  enabled: true,
  mode: 'today',
  fontFamily: 'Noto Sans Arabic',
  fontSize: 34,
  textColor: '#FFFFFF',
  backgroundColor: '#000000',
  backgroundOpacity: 0.68,
  opacity: 1,
  speedPixelsPerSecond: 90,
  position: 'bottom',
  safeArea: 36,
  resolutionWidth: 1280,
  resolutionHeight: 720,
  limitItems: 12,
};

export default function OverlaysPage() {
  const [tab, setTab] = useState<TabKey>('logo');
  const [safeNaming, setSafeNaming] = useState<SafeNamingPanel | null>(null);
  const [settings, setSettings] = useState<OverlaySettings>({ logo: defaultLogo, ticker: defaultTicker, updatedAt: '' });
  const [csvContent, setCsvContent] = useState('');
  const [safePreview, setSafePreview] = useState<SafeNamingPanel | null>(null);
  const [slugOverrides, setSlugOverrides] = useState<Record<string, string>>({});
  const [manualMessages, setManualMessages] = useState('تنويه هام للمشاهدين');
  const [todayDate, setTodayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [todayItems, setTodayItems] = useState<TodayScheduleItem[]>([]);
  const [tickerPreview, setTickerPreview] = useState<TickerPreview | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  const activeRows = safePreview?.needsReview.length ? safePreview.needsReview : safeNaming?.needsReview ?? [];
  const collisionRows = safePreview?.slugCollisions.length ? safePreview.slugCollisions : safeNaming?.slugCollisions ?? [];
  const overlayPreviewStyle = useMemo(() => ({
    opacity: settings.logo.opacity,
    transform: `scale(${Math.max(0.4, settings.logo.scale * 3)})`,
  }), [settings.logo.opacity, settings.logo.scale]);

  async function refresh() {
    setLoading('refresh');
    try {
      const [safe, overlay] = await Promise.all([
        schedulerFoundationApi.safeNamingControlPanel().then(r => r.data as SafeNamingPanel),
        schedulerFoundationApi.overlaySettings().then(r => r.data as OverlaySettings),
      ]);
      setSafeNaming(safe);
      setSettings({
        logo: overlay.logo ?? defaultLogo,
        ticker: overlay.ticker ?? defaultTicker,
        updatedAt: overlay.updatedAt,
      });
    } finally {
      setLoading(null);
    }
  }

  async function previewSafeNaming() {
    setLoading('safe-preview');
    setMessage('');
    try {
      const response = await schedulerFoundationApi.safeNamingImportPreview({
        csvContent,
        manualSlugOverrides: slugOverrides,
      });
      const preview = response.data as SafeNamingPreviewResponse;
      setSafePreview({
        rows: preview.entries,
        needsReview: preview.needsReview,
        slugCollisions: preview.slugCollisions,
      });
      setMessage('تم توليد معاينة الأسماء بدون أي تعديل على قاعدة البيانات أو الملفات.');
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setLoading(null);
    }
  }

  async function saveSettings() {
    setLoading('settings');
    setMessage('');
    try {
      const response = await schedulerFoundationApi.saveOverlaySettings(settings);
      setSettings(response.data as OverlaySettings);
      setMessage('تم حفظ إعدادات التراكب كملف إعدادات فقط.');
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setLoading(null);
    }
  }

  async function previewTicker(mode: 'manual' | 'today' | 'mixed') {
    setLoading(`ticker-${mode}`);
    setMessage('');
    try {
      const response = await schedulerFoundationApi.tickerPreview({
        mode,
        date: todayDate,
        messages: manualMessages.split('\n'),
        settings: settings.ticker,
      });
      setTickerPreview(response.data as TickerPreview);
      setTab('preview');
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setLoading(null);
    }
  }

  async function exportAss() {
    setLoading('export-ass');
    setMessage('');
    try {
      const response = await schedulerFoundationApi.tickerExportAss({
        mode: settings.ticker.mode,
        date: todayDate,
        messages: manualMessages.split('\n'),
        settings: settings.ticker,
      });
      setTickerPreview(response.data as TickerPreview);
      setTab('preview');
      setMessage('تم تصدير ملفات ASS والمعاينة داخل مجلد data فقط.');
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setLoading(null);
    }
  }

  async function loadTodaySchedule() {
    setLoading('today');
    try {
      const response = await schedulerFoundationApi.todayScheduleOverlay({
        date: todayDate,
        limit: settings.ticker.limitItems,
      });
      setTodayItems((response.data as { items: TodayScheduleItem[] }).items);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-bold">إعدادات الشاشة والبث</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="badge badge-info">Preview only</span>
            <span className="badge badge-ready">No OBS</span>
            <span className="badge badge-warning">No live activation</span>
          </div>
        </div>
        <button className="btn-ghost flex items-center gap-2" onClick={() => void refresh()} disabled={loading !== null}>
          <ListChecks size={16} />
          تحديث
        </button>
      </div>

      {message && (
        <div className="card flex items-start gap-2">
          <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
          <span>{message}</span>
        </div>
      )}

      <section className="card space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
            <h3 className="font-semibold">أسماء الملفات العربية</h3>
          </div>
          <span className="badge badge-info">{safeNaming?.rows.length ?? 0} سجل</span>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <textarea
              value={csvContent}
              onChange={event => setCsvContent(event.target.value)}
              rows={7}
              className="w-full rounded-md px-3 py-2 text-sm ltr-text"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
              placeholder="root,original_path,original_name,normalized_name,proposed_display_name,proposed_safe_slug..."
            />
            <button
              className="btn-primary flex items-center gap-2"
              disabled={loading !== null || csvContent.trim().length === 0}
              onClick={() => void previewSafeNaming()}
            >
              <Eye size={16} />
              معاينة الاستيراد
            </button>
          </div>

          <div className="space-y-3">
            <h4 className="font-medium">بحاجة مراجعة</h4>
            <div className="max-h-56 overflow-auto rounded-md border" style={{ borderColor: 'var(--bg-border)' }}>
              {activeRows.slice(0, 12).map(row => (
                <div key={`${row.originalPath}-${row.safeSlug}`} className="grid gap-2 border-b p-3 text-xs" style={{ borderColor: 'var(--bg-border)' }}>
                  <div className="font-medium">{row.originalArabicName}</div>
                  <div className="ltr-text" style={{ color: 'var(--text-muted)' }}>{row.originalPath}</div>
                  <input
                    value={slugOverrides[row.originalPath] ?? row.manualSlugOverrideDraft ?? ''}
                    onChange={event => setSlugOverrides(current => ({ ...current, [row.originalPath]: event.target.value }))}
                    className="rounded px-2 py-1 ltr-text"
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
                    placeholder={row.safeSlug}
                  />
                </div>
              ))}
              {activeRows.length === 0 && <div className="p-3 text-sm" style={{ color: 'var(--text-muted)' }}>لا توجد عناصر بحاجة مراجعة.</div>}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MiniTable title="Slug collisions" rows={collisionRows.map(item => ({
            key: item.safeSlug,
            value: `${item.entries.length} عناصر`,
            note: item.entries.map(entry => entry.originalArabicName).join('، '),
          }))} />
          <MiniTable title="حقول العرض" rows={(safePreview?.rows ?? safeNaming?.rows ?? []).slice(0, 8).map(row => ({
            key: row.displayName,
            value: row.safeSlug,
            note: `${row.root} • ${row.reviewStatus} • ${row.schedulingStatus}`,
          }))} />
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        {tabs.map(item => (
          <button
            key={item.key}
            className={tab === item.key ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'logo' && (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="card space-y-4">
            <PanelTitle icon={Image} title="إعدادات اللوجو" />
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.logo.enabled}
                onChange={event => setSettings(current => ({ ...current, logo: { ...current.logo, enabled: event.target.checked } }))}
              />
              تفعيل اللوجو في ملف الإعدادات
            </label>
            <InputRow label="مسار اللوجو">
              <input
                value={settings.logo.logoPath ?? ''}
                onChange={event => setSettings(current => ({ ...current, logo: { ...current.logo, logoPath: event.target.value || null } }))}
                className="w-full rounded px-3 py-2 ltr-text"
                style={inputStyle}
              />
            </InputRow>
            <InputRow label="الموضع">
              <select
                value={settings.logo.position}
                onChange={event => setSettings(current => ({ ...current, logo: { ...current.logo, position: event.target.value as LogoSettings['position'] } }))}
                className="w-full rounded px-3 py-2"
                style={inputStyle}
              >
                <option value="top-right">أعلى اليمين</option>
                <option value="top-left">أعلى اليسار</option>
                <option value="bottom-right">أسفل اليمين</option>
                <option value="bottom-left">أسفل اليسار</option>
                <option value="custom">مخصص</option>
              </select>
            </InputRow>
            <Slider label="الحجم" value={settings.logo.scale} min={0.01} max={1} step={0.01} onChange={value => setSettings(current => ({ ...current, logo: { ...current.logo, scale: value } }))} />
            <Slider label="الشفافية" value={settings.logo.opacity} min={0} max={1} step={0.01} onChange={value => setSettings(current => ({ ...current, logo: { ...current.logo, opacity: value } }))} />
            <div className="grid grid-cols-2 gap-3">
              <NumberInput label="هامش X" value={settings.logo.xMargin} onChange={value => setSettings(current => ({ ...current, logo: { ...current.logo, xMargin: value } }))} />
              <NumberInput label="هامش Y" value={settings.logo.yMargin} onChange={value => setSettings(current => ({ ...current, logo: { ...current.logo, yMargin: value } }))} />
            </div>
            <button className="btn-primary flex items-center gap-2" disabled={loading !== null} onClick={() => void saveSettings()}>
              <Save size={16} />
              حفظ JSON
            </button>
          </div>

          <div className="card space-y-4">
            <PanelTitle icon={Eye} title="معاينة اللوجو" />
            <div className="relative aspect-video overflow-hidden rounded-md border" style={{ borderColor: 'var(--bg-border)', background: '#111827' }}>
              <div className={logoPositionClass(settings.logo.position)} style={overlayPreviewStyle}>
                <div className="rounded bg-white/90 px-4 py-2 font-bold text-black">DAAWAH</div>
              </div>
            </div>
          </div>
        </section>
      )}

      {tab === 'ticker' && (
        <section className="card space-y-4">
          <PanelTitle icon={Type} title="شريط الأخبار" />
          <textarea
            value={manualMessages}
            onChange={event => setManualMessages(event.target.value)}
            rows={4}
            className="w-full rounded px-3 py-2"
            style={inputStyle}
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <NumberInput label="حجم الخط" value={settings.ticker.fontSize} onChange={value => setSettings(current => ({ ...current, ticker: { ...current.ticker, fontSize: value } }))} />
            <NumberInput label="السرعة" value={settings.ticker.speedPixelsPerSecond} onChange={value => setSettings(current => ({ ...current, ticker: { ...current.ticker, speedPixelsPerSecond: value } }))} />
            <NumberInput label="عدد العناصر" value={settings.ticker.limitItems} onChange={value => setSettings(current => ({ ...current, ticker: { ...current.ticker, limitItems: value } }))} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={loading !== null} onClick={() => void previewTicker('manual')}>معاينة يدوي</button>
            <button className="btn-ghost" disabled={loading !== null} onClick={() => void previewTicker('mixed')}>معاينة مختلط</button>
            <button className="btn-ghost flex items-center gap-2" disabled={loading !== null} onClick={() => void exportAss()}>
              <Download size={16} />
              تصدير ASS
            </button>
          </div>
        </section>
      )}

      {tab === 'today' && (
        <section className="card space-y-4">
          <PanelTitle icon={ListChecks} title="تشاهدون اليوم" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_160px_auto]">
            <input type="date" value={todayDate} onChange={event => setTodayDate(event.target.value)} className="rounded px-3 py-2" style={inputStyle} />
            <input type="number" value={settings.ticker.limitItems} onChange={event => setSettings(current => ({ ...current, ticker: { ...current.ticker, limitItems: Number(event.target.value) } }))} className="rounded px-3 py-2" style={inputStyle} />
            <button className="btn-primary" disabled={loading !== null} onClick={() => void loadTodaySchedule()}>قراءة الجدول</button>
          </div>
          <div className="grid gap-2">
            {todayItems.map(item => (
              <div key={`${item.time}-${item.title}`} className="flex items-center gap-3 rounded-md border px-3 py-2" style={{ borderColor: 'var(--bg-border)' }}>
                <span className="badge badge-info ltr-text">{item.time}</span>
                <span>{item.title}</span>
              </div>
            ))}
            {todayItems.length === 0 && <div className="text-sm" style={{ color: 'var(--text-muted)' }}>لا توجد عناصر محملة.</div>}
          </div>
          <button className="btn-primary" disabled={loading !== null} onClick={() => void previewTicker('today')}>توليد شريط اليوم</button>
        </section>
      )}

      {tab === 'preview' && (
        <section className="card space-y-4">
          <PanelTitle icon={SlidersHorizontal} title="معاينة التراكب" />
          <div className="relative aspect-video overflow-hidden rounded-md border" style={{ borderColor: 'var(--bg-border)', background: '#111827' }}>
            <div className={logoPositionClass(settings.logo.position)} style={overlayPreviewStyle}>
              <div className="rounded bg-white/90 px-4 py-2 font-bold text-black">DAAWAH</div>
            </div>
            <div className="absolute bottom-6 left-0 right-0 bg-black/70 px-4 py-2 text-center text-white">
              {tickerPreview?.text ?? 'تشاهدون اليوم'}
            </div>
          </div>
          {tickerPreview?.tickerAssPath && (
            <div className="rounded-md border p-3 text-xs ltr-text" style={{ borderColor: 'var(--bg-border)' }}>
              {tickerPreview.tickerAssPath}
            </div>
          )}
          <pre className="max-h-80 overflow-auto rounded-md p-3 text-xs ltr-text" style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)' }}>
            {tickerPreview?.assPreview ?? 'ASS preview will appear here.'}
          </pre>
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <AlertTriangle size={16} />
            لا يوجد زر تفعيل للبث المباشر ولا زر إعادة تشغيل.
          </div>
        </section>
      )}
    </div>
  );
}

function PanelTitle({ icon: Icon, title }: { icon: typeof ShieldCheck; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon size={18} style={{ color: 'var(--accent)' }} />
      <h3 className="font-semibold">{title}</h3>
    </div>
  );
}

function InputRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <InputRow label={`${label}: ${value}`}>
      <input type="range" value={value} min={min} max={max} step={step} onChange={event => onChange(Number(event.target.value))} />
    </InputRow>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <InputRow label={label}>
      <input type="number" value={value} onChange={event => onChange(Number(event.target.value))} className="rounded px-3 py-2" style={inputStyle} />
    </InputRow>
  );
}

function MiniTable({ title, rows }: { title: string; rows: Array<{ key: string; value: string; note: string }> }) {
  return (
    <div className="rounded-md border" style={{ borderColor: 'var(--bg-border)' }}>
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--bg-border)' }}>
        <CheckCircle2 size={16} style={{ color: 'var(--accent)' }} />
        <span className="font-medium">{title}</span>
      </div>
      <div className="max-h-56 overflow-auto">
        {rows.map(row => (
          <div key={`${row.key}-${row.value}`} className="grid gap-1 border-b px-3 py-2 text-xs" style={{ borderColor: 'var(--bg-border)' }}>
            <div className="font-medium">{row.key}</div>
            <div className="ltr-text">{row.value}</div>
            <div style={{ color: 'var(--text-muted)' }}>{row.note}</div>
          </div>
        ))}
        {rows.length === 0 && <div className="p-3 text-sm" style={{ color: 'var(--text-muted)' }}>لا توجد بيانات.</div>}
      </div>
    </div>
  );
}

const inputStyle = {
  background: 'var(--bg-primary)',
  border: '1px solid var(--bg-border)',
  color: 'var(--text-primary)',
};

function logoPositionClass(position: LogoSettings['position']): string {
  const base = 'absolute';
  if (position === 'top-left') return `${base} left-6 top-6`;
  if (position === 'bottom-right') return `${base} bottom-6 right-6`;
  if (position === 'bottom-left') return `${base} bottom-6 left-6`;
  return `${base} right-6 top-6`;
}

function errorText(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const data = (err as { response?: { data?: { error?: string } } }).response?.data;
    if (data?.error) return data.error;
  }
  return err instanceof Error ? err.message : String(err);
}
