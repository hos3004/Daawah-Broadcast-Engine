import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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
  Trash2,
  Type,
  Upload,
} from 'lucide-react';
import { schedulerFoundationApi, broadcastApi, api } from '../api/client';

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

interface LogoAsset {
  id: string;
  originalFilename: string;
  filename: string;
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
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
  scale: 0.08,
  opacity: 0.9,
  safeArea: 24,
};

const defaultTicker: TickerSettings = {
  enabled: true,
  mode: 'today',
  fontFamily: 'Tajawal',
  fontSize: 34,
  textColor: '#FFFFFF',
  backgroundColor: 'gradient-blue',
  backgroundOpacity: 1,
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
  const [logoAssets, setLogoAssets] = useState<LogoAsset[]>([]);
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
  const selectedLogoAsset = useMemo(
    () => logoAssets.find(asset => asset.id === settings.logo.logoAssetId) ?? null,
    [logoAssets, settings.logo.logoAssetId]
  );
  const logoPreviewUrl = selectedLogoAsset
    ? `${schedulerFoundationApi.logoAssetContentUrl(selectedLogoAsset.id)}?v=${encodeURIComponent(selectedLogoAsset.createdAt)}`
    : null;
  const logoPreviewStyle = useMemo(
    () => logoOverlayStyle(settings.logo, settings.ticker.resolutionWidth, settings.ticker.resolutionHeight),
    [settings.logo, settings.ticker.resolutionWidth, settings.ticker.resolutionHeight]
  );
  const tickerPreviewStyle = useMemo(
    () => tickerOverlayStyle(settings.ticker),
    [settings.ticker]
  );

  async function refresh() {
    setLoading('refresh');
    try {
      const [safe, overlay, logoAssetResponse] = await Promise.all([
        schedulerFoundationApi.safeNamingControlPanel().then(r => r.data as SafeNamingPanel),
        schedulerFoundationApi.overlaySettings().then(r => r.data as OverlaySettings),
        schedulerFoundationApi.listLogoAssets().then(r => r.data as { assets: LogoAsset[] }),
      ]);
      setSafeNaming(safe);
      setLogoAssets(logoAssetResponse.assets ?? []);
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

  async function uploadLogoAsset(file: File | null | undefined) {
    if (!file) return;
    setLoading('logo-upload');
    setMessage('');
    try {
      const response = await schedulerFoundationApi.uploadLogoAsset(file);
      const asset = (response.data as { asset: LogoAsset }).asset;
      setLogoAssets(current => [asset, ...current.filter(item => item.id !== asset.id)]);
      setSettings(current => ({
        ...current,
        logo: {
          ...current.logo,
          logoAssetId: asset.id,
          logoPath: asset.absolutePath,
        },
      }));
      setMessage('تم رفع أصل اللوجو داخل data/overlay-assets فقط.');
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setLoading(null);
    }
  }

  async function deleteSelectedLogoAsset() {
    if (!settings.logo.logoAssetId) return;
    setLoading('logo-delete');
    setMessage('');
    try {
      await schedulerFoundationApi.deleteLogoAsset(settings.logo.logoAssetId);
      setLogoAssets(current => current.filter(asset => asset.id !== settings.logo.logoAssetId));
      setSettings(current => ({
        ...current,
        logo: {
          ...current.logo,
          logoAssetId: null,
          logoPath: null,
        },
      }));
      setMessage('تم حذف أصل اللوجو التجريبي من data/overlay-assets.');
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

  async function applyToBroadcast() {
    const confirmed = window.confirm('سيتم توليد شريط الأخبار بإعدادات هذه الصفحة ثم إعادة تشغيل البث. هل تريد المتابعة؟');
    if (!confirmed) return;
    setLoading('apply');
    setMessage('');
    try {
      await api.post(`/overlays/ticker/generate/${todayDate}`, {
        mode: settings.ticker.mode,
        date: todayDate,
        messages: manualMessages.split('\n'),
        settings: settings.ticker,
        limit: settings.ticker.limitItems,
      });
      await broadcastApi.restart();
      setMessage('تم توليد شريط الأخبار وإعادة تشغيل البث بالإعدادات الحالية.');
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
            <span className="badge badge-info">معاينة آمنة</span>
            <span className="badge badge-ready">بدون OBS</span>
            <span className="badge badge-warning">التطبيق المباشر يتطلب تأكيدًا</span>
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
            <InputRow label="أصول اللوجو">
              <div className="grid gap-2">
                <label className="btn-ghost inline-flex cursor-pointer items-center justify-center gap-2">
                  <Upload size={16} />
                  رفع PNG / JPEG / WebP
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    disabled={loading !== null}
                    onChange={event => {
                      const file = event.currentTarget.files?.[0] ?? null;
                      event.currentTarget.value = '';
                      void uploadLogoAsset(file);
                    }}
                  />
                </label>
                <select
                  value={settings.logo.logoAssetId ?? ''}
                  onChange={event => {
                    const asset = logoAssets.find(item => item.id === event.target.value) ?? null;
                    setSettings(current => ({
                      ...current,
                      logo: {
                        ...current.logo,
                        logoAssetId: asset?.id ?? null,
                        logoPath: asset?.absolutePath ?? current.logo.logoPath,
                      },
                    }));
                  }}
                  className="w-full rounded px-3 py-2"
                  style={inputStyle}
                >
                  <option value="">بدون أصل محفوظ</option>
                  {logoAssets.map(asset => (
                    <option key={asset.id} value={asset.id}>{asset.originalFilename}</option>
                  ))}
                </select>
                {selectedLogoAsset && (
                  <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--bg-border)' }}>
                    <span className="ltr-text">{selectedLogoAsset.relativePath}</span>
                    <button className="btn-ghost flex items-center gap-1" disabled={loading !== null} onClick={() => void deleteSelectedLogoAsset()}>
                      <Trash2 size={14} />
                      حذف
                    </button>
                  </div>
                )}
              </div>
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
              <LogoPreviewOverlay src={logoPreviewUrl} settings={settings.logo} style={logoPreviewStyle} />
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
          <InputRow label="خط العربية">
            <select
              value={settings.ticker.fontFamily}
              onChange={event => setSettings(current => ({ ...current, ticker: { ...current.ticker, fontFamily: event.target.value } }))}
              className="w-full rounded px-3 py-2"
              style={inputStyle}
            >
              <option value="Tajawal">Tajawal (مثبّت)</option>
              <option value="Noto Naskh Arabic">Noto Naskh Arabic</option>
              <option value="Amiri">Amiri</option>
              <option value="Noto Sans Arabic">Noto Sans Arabic</option>
              <option value="Arial">Arial</option>
              <option value="DejaVu Sans">DejaVu Sans</option>
            </select>
          </InputRow>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <InputRow label="خلفية الشريط">
              <select
                value={settings.ticker.backgroundColor}
                onChange={event => setSettings(current => ({ ...current, ticker: { ...current.ticker, backgroundColor: event.target.value } }))}
                className="w-full rounded px-3 py-2"
                style={inputStyle}
              >
                <option value="gradient-blue">تدرج أزرق</option>
                <option value="#000000">أسود شفاف</option>
                <option value="#0B69D1">أزرق ثابت</option>
              </select>
            </InputRow>
            <InputRow label="موضع الشريط">
              <select
                value={settings.ticker.position}
                onChange={event => setSettings(current => ({ ...current, ticker: { ...current.ticker, position: event.target.value as TickerSettings['position'] } }))}
                className="w-full rounded px-3 py-2"
                style={inputStyle}
              >
                <option value="bottom">أسفل الشاشة</option>
                <option value="top">أعلى الشاشة</option>
              </select>
            </InputRow>
          </div>
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
          <div className="rounded-md border p-3" style={{ borderColor: 'var(--accent)', background: 'var(--bg-secondary)' }}>
            <p className="mb-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              يعيد توليد ملف التيكر لتاريخ اليوم ثم يعيد تشغيل البث مباشرةً.
            </p>
            <button
              className="btn-primary flex items-center gap-2"
              disabled={loading !== null}
              onClick={() => void applyToBroadcast()}
            >
              {loading === 'apply' ? '⏳ جارٍ التطبيق...' : '📡 تطبيق على البث الآن'}
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
            <LogoPreviewOverlay src={logoPreviewUrl} settings={settings.logo} style={logoPreviewStyle} />
            <div style={tickerPreviewStyle}>
              <div className="ticker-preview-marquee" dir="rtl">
                {tickerPreview?.text ?? 'تشاهدون اليوم'}
              </div>
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
            المعاينة هنا لا تغيّر البث. زر التطبيق المباشر موجود في تبويب شريط الأخبار ويتطلب تأكيدًا.
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

function LogoPreviewOverlay({ src, settings, style }: { src: string | null; settings: LogoSettings; style: CSSProperties }) {
  if (!settings.enabled) return null;
  return (
    <div className="pointer-events-none flex items-center justify-center" style={style}>
      {src ? (
        <img
          src={src}
          alt="Logo preview"
          className="block h-auto w-full select-none"
          style={{ objectFit: 'contain' }}
          draggable={false}
        />
      ) : (
        <div className="rounded border border-dashed px-3 py-2 text-xs" style={{ borderColor: 'rgba(255,255,255,0.35)', color: 'rgba(255,255,255,0.76)' }}>
          لا يوجد لوجو مختار
        </div>
      )}
    </div>
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

function logoOverlayStyle(settings: LogoSettings, resolutionWidth: number, resolutionHeight: number): CSSProperties {
  const widthPx = settings.width ?? Math.round(resolutionWidth * settings.scale);
  const widthPercent = clamp((widthPx / resolutionWidth) * 100, 3, 34);
  const xPercent = clamp((settings.xMargin / resolutionWidth) * 100, 0, 45);
  const yPercent = clamp((settings.yMargin / resolutionHeight) * 100, 0, 45);
  const style: CSSProperties = {
    position: 'absolute',
    width: `${widthPercent}%`,
    maxHeight: '42%',
    opacity: settings.opacity,
    zIndex: 2,
  };

  if (settings.position === 'custom') {
    style.left = `${clamp(((settings.customX ?? settings.xMargin) / resolutionWidth) * 100, 0, 92)}%`;
    style.top = `${clamp(((settings.customY ?? settings.yMargin) / resolutionHeight) * 100, 0, 92)}%`;
    return style;
  }

  if (settings.position.includes('right')) style.right = `${xPercent}%`;
  else style.left = `${xPercent}%`;

  if (settings.position.includes('bottom')) style.bottom = `${yPercent}%`;
  else style.top = `${yPercent}%`;

  return style;
}

function tickerOverlayStyle(settings: TickerSettings): CSSProperties {
  const verticalKey = settings.position === 'top' ? 'top' : 'bottom';
  return {
    position: 'absolute',
    [verticalKey]: 0,
    left: 0,
    right: 0,
    minHeight: '42px',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    color: settings.textColor,
    background: tickerBackgroundCss(settings.backgroundColor, settings.backgroundOpacity),
    opacity: settings.opacity,
    fontFamily: `"${settings.fontFamily}", "Noto Naskh Arabic", Arial, sans-serif`,
    fontSize: `${clamp(Math.round(settings.fontSize * 0.56), 14, 30)}px`,
    lineHeight: 1.35,
    whiteSpace: 'nowrap',
    zIndex: 1,
  };
}

function tickerBackgroundCss(backgroundColor: string, opacity: number): string {
  if (backgroundColor.toLowerCase() === 'gradient-blue') {
    return `linear-gradient(90deg, ${hexToRgba('#042B66', opacity)} 0%, ${hexToRgba('#0B69D1', opacity)} 45%, ${hexToRgba('#021A3D', opacity)} 100%)`;
  }
  return hexToRgba(backgroundColor, opacity);
}

function hexToRgba(value: string, opacity: number): string {
  const match = /^#?([0-9A-Fa-f]{6})$/.exec(value);
  const hex = match?.[1] ?? '000000';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(opacity, 0, 1)})`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function errorText(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const data = (err as { response?: { data?: { error?: string } } }).response?.data;
    if (data?.error) return data.error;
  }
  return err instanceof Error ? err.message : String(err);
}
