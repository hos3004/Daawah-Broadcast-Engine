import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getDb } from '../db/schema';
import { DraftValidationError, getActiveScheduleState, getPublishedSchedule } from '../schedule/drafts';

export type LogoPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'custom';
export type TickerMode = 'manual' | 'today' | 'mixed';

export interface LogoOverlaySettings {
  enabled: boolean;
  logoPath: string | null;
  logoAssetId: string | null;
  position: LogoPosition;
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

export interface TickerSettings {
  enabled: boolean;
  mode: TickerMode;
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

export interface OverlayControlSettings {
  mode: 'preview-only';
  logo: LogoOverlaySettings;
  ticker: TickerSettings;
  safety: OverlaySafety;
  updatedAt: string;
}

export interface OverlayControlSettingsInput {
  logo?: Partial<LogoOverlaySettings>;
  ticker?: Partial<TickerSettings>;
}

export interface OverlaySafety {
  previewOnly: true;
  liveActivation: false;
  restartPlayout: false;
  ffmpegExecution: false;
  rtmpPush: false;
  streamKeyUsage: false;
  mediaWrites: false;
  productionPathMutation: false;
}

export interface TodayScheduleTickerItem {
  time: string;
  title: string;
  programKey: string | null;
}

export interface TickerPreviewInput {
  mode?: TickerMode;
  messages?: string[];
  date?: string;
  limit?: number;
  settings?: Partial<TickerSettings>;
  scheduleItems?: TodayScheduleTickerItem[];
}

export interface TickerPreview {
  mode: 'ticker-preview';
  sourceMode: TickerMode;
  date: string;
  text: string;
  scheduleItems: TodayScheduleTickerItem[];
  settings: TickerSettings;
  assPreview: string;
  safety: OverlaySafety;
}

export interface TickerExport extends Omit<TickerPreview, 'mode'> {
  mode: 'ticker-export';
  runId: string;
  tickerAssPath: string;
  tickerJsonPath: string;
  overlayManifestPath: string;
}

const SAFETY: OverlaySafety = {
  previewOnly: true,
  liveActivation: false,
  restartPlayout: false,
  ffmpegExecution: false,
  rtmpPush: false,
  streamKeyUsage: false,
  mediaWrites: false,
  productionPathMutation: false,
};

const DEFAULT_LOGO_SETTINGS: LogoOverlaySettings = {
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

const DEFAULT_TICKER_SETTINGS: TickerSettings = {
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

export function getOverlaySettings(): OverlayControlSettings {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) return defaultSettings();
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Partial<OverlayControlSettings>;
    return {
      mode: 'preview-only',
      logo: validateLogoOverlaySettings(parsed.logo ?? {}),
      ticker: validateTickerSettings(parsed.ticker ?? {}),
      safety: SAFETY,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return defaultSettings();
  }
}

export function saveOverlaySettings(input: OverlayControlSettingsInput): OverlayControlSettings {
  const settings = {
    mode: 'preview-only' as const,
    logo: validateLogoOverlaySettings(input.logo ?? {}),
    ticker: validateTickerSettings(input.ticker ?? {}),
    safety: SAFETY,
    updatedAt: new Date().toISOString(),
  };
  const settingsPath = getSettingsPath();
  ensureProjectPath(settingsPath, getOverlayDataRoot());
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

export function validateLogoOverlaySettings(input: Partial<LogoOverlaySettings>): LogoOverlaySettings {
  const position = normalizePosition(input.position);
  const logoPath = normalizeLogoPath(input.logoPath ?? null);
  const logoAssetId = normalizeAssetId(input.logoAssetId ?? null);
  return {
    enabled: input.enabled === true,
    logoPath,
    logoAssetId,
    position,
    xMargin: clampInt(input.xMargin ?? DEFAULT_LOGO_SETTINGS.xMargin, 0, 640),
    yMargin: clampInt(input.yMargin ?? DEFAULT_LOGO_SETTINGS.yMargin, 0, 360),
    customX: position === 'custom' ? clampNullableInt(input.customX, 0, 4096) : null,
    customY: position === 'custom' ? clampNullableInt(input.customY, 0, 4096) : null,
    width: clampNullableInt(input.width, 1, 4096),
    height: clampNullableInt(input.height, 1, 4096),
    scale: clampNumber(input.scale ?? DEFAULT_LOGO_SETTINGS.scale, 0.01, 2),
    opacity: clampNumber(input.opacity ?? DEFAULT_LOGO_SETTINGS.opacity, 0, 1),
    safeArea: clampInt(input.safeArea ?? DEFAULT_LOGO_SETTINGS.safeArea, 0, 512),
  };
}

export function validateTickerSettings(input: Partial<TickerSettings>): TickerSettings {
  const mode = input.mode === 'manual' || input.mode === 'mixed' ? input.mode : 'today';
  return {
    enabled: input.enabled !== false,
    mode,
    fontFamily: cleanString(input.fontFamily) || DEFAULT_TICKER_SETTINGS.fontFamily,
    fontSize: clampInt(input.fontSize ?? DEFAULT_TICKER_SETTINGS.fontSize, 12, 120),
    textColor: normalizeHexColor(input.textColor, DEFAULT_TICKER_SETTINGS.textColor),
    backgroundColor: normalizeHexColor(input.backgroundColor, DEFAULT_TICKER_SETTINGS.backgroundColor),
    backgroundOpacity: clampNumber(input.backgroundOpacity ?? DEFAULT_TICKER_SETTINGS.backgroundOpacity, 0, 1),
    opacity: clampNumber(input.opacity ?? DEFAULT_TICKER_SETTINGS.opacity, 0, 1),
    speedPixelsPerSecond: clampInt(input.speedPixelsPerSecond ?? DEFAULT_TICKER_SETTINGS.speedPixelsPerSecond, 10, 800),
    position: input.position === 'top' ? 'top' : 'bottom',
    safeArea: clampInt(input.safeArea ?? DEFAULT_TICKER_SETTINGS.safeArea, 0, 512),
    resolutionWidth: clampInt(input.resolutionWidth ?? DEFAULT_TICKER_SETTINGS.resolutionWidth, 320, 7680),
    resolutionHeight: clampInt(input.resolutionHeight ?? DEFAULT_TICKER_SETTINGS.resolutionHeight, 180, 4320),
    limitItems: clampInt(input.limitItems ?? DEFAULT_TICKER_SETTINGS.limitItems, 1, 50),
  };
}

export function buildTickerPreview(input: TickerPreviewInput = {}): TickerPreview {
  const saved = getOverlaySettings();
  const settings = validateTickerSettings({ ...saved.ticker, ...input.settings });
  const sourceMode = input.mode ?? settings.mode;
  const date = normalizeDate(input.date);
  const limit = clampInt(input.limit ?? settings.limitItems, 1, 50);
  const scheduleItems = sourceMode === 'manual'
    ? []
    : (input.scheduleItems ?? getTodayScheduleItems({ date, limit }));
  const text = buildTickerText({
    mode: sourceMode,
    messages: input.messages ?? [],
    scheduleItems,
    limit,
  });

  return {
    mode: 'ticker-preview',
    sourceMode,
    date,
    text,
    scheduleItems,
    settings,
    assPreview: renderTickerAss(text, settings),
    safety: SAFETY,
  };
}

export function exportTickerAss(input: TickerPreviewInput = {}): TickerExport {
  const preview = buildTickerPreview(input);
  const runId = `ticker-${preview.date}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.join(getTickerDataRoot(), runId);
  ensureProjectPath(outDir, getTickerDataRoot());
  fs.mkdirSync(outDir, { recursive: true });

  const tickerAssPath = path.join(outDir, 'ticker.ass');
  const tickerJsonPath = path.join(outDir, 'ticker.json');
  const overlayManifestPath = path.join(outDir, 'overlay-manifest.json');
  for (const outputPath of [tickerAssPath, tickerJsonPath, overlayManifestPath]) {
    ensureProjectPath(outputPath, getTickerDataRoot());
  }

  fs.writeFileSync(tickerAssPath, preview.assPreview, 'utf8');
  fs.writeFileSync(tickerJsonPath, `${JSON.stringify(preview, null, 2)}\n`, 'utf8');
  fs.writeFileSync(overlayManifestPath, `${JSON.stringify({
    mode: 'preview-only',
    runId,
    tickerAssPath,
    tickerJsonPath,
    generatedAt: new Date().toISOString(),
    futureFfmpegUse: {
      subtitlesFilter: `subtitles='${tickerAssPath.replace(/\\/g, '/').replace(/'/g, "\\'")}'`,
      liveActivation: false,
    },
    safety: SAFETY,
  }, null, 2)}\n`, 'utf8');

  return {
    ...preview,
    mode: 'ticker-export',
    runId,
    tickerAssPath,
    tickerJsonPath,
    overlayManifestPath,
  };
}

export function getTodayScheduleItems(input: { date?: string; limit?: number } = {}): TodayScheduleTickerItem[] {
  const date = normalizeDate(input.date);
  const limit = clampInt(input.limit ?? DEFAULT_TICKER_SETTINGS.limitItems, 1, 50);
  const activeState = getActiveScheduleState();
  if (!activeState) return [];
  const activeSchedule = getPublishedSchedule(activeState.publishedScheduleId);
  if (!activeSchedule) return [];
  return scheduleItemsFromPreview(activeSchedule.schedulePreview, date, limit, getSafeNameDisplayLookup());
}

export function scheduleItemsFromPreview(
  preview: unknown,
  date: string,
  limit: number,
  displayNameLookup: Map<string, string> = new Map()
): TodayScheduleTickerItem[] {
  const days = isRecord(preview) && Array.isArray(preview['days']) ? preview['days'] : [];
  const day = days.find(item => isRecord(item) && item['date'] === date);
  const rows = isRecord(day) && Array.isArray(day['rows']) ? day['rows'] : [];
  return rows
    .filter(isRecord)
    .filter(row => row['type'] === 'slot')
    .slice(0, limit)
    .map(row => {
      const programKey = typeof row['program_key'] === 'string' ? row['program_key'] : null;
      const fallbackTitle = typeof row['title'] === 'string' ? row['title'] : '';
      return {
        time: typeof row['start_time'] === 'string' ? row['start_time'] : '',
        title: (programKey ? displayNameLookup.get(programKey) : null) ?? fallbackTitle,
        programKey,
      };
    });
}

export function buildTickerText(input: {
  mode: TickerMode;
  messages: string[];
  scheduleItems: TodayScheduleTickerItem[];
  limit?: number;
}): string {
  const scheduleText = input.scheduleItems
    .slice(0, input.limit ?? input.scheduleItems.length)
    .map(item => `${item.time} ${item.title}`.trim())
    .filter(Boolean)
    .join(' • ');
  const manualText = input.messages.map(cleanString).filter(Boolean).join(' • ');
  if (input.mode === 'manual') return manualText || 'تشاهدون اليوم';
  if (input.mode === 'mixed') {
    return [manualText, scheduleText ? `تشاهدون اليوم: ${scheduleText}` : '']
      .filter(Boolean)
      .join(' • ');
  }
  return scheduleText ? `تشاهدون اليوم: ${scheduleText}` : 'تشاهدون اليوم';
}

export function renderTickerAss(text: string, settings: TickerSettings): string {
  const escaped = escapeAssText(`\u202B${text}\u202C`);
  const y = settings.position === 'top'
    ? settings.safeArea
    : settings.resolutionHeight - settings.safeArea - settings.fontSize - 18;
  const estimatedTextWidth = Math.max(settings.resolutionWidth, Math.ceil(text.length * settings.fontSize * 0.85));
  const durationSeconds = Math.max(30, Math.ceil((settings.resolutionWidth + estimatedTextWidth) / settings.speedPixelsPerSecond));
  const endX = -estimatedTextWidth;
  const primaryColour = assColor(settings.textColor, settings.opacity);
  const backColour = assColor(settings.backgroundColor, settings.backgroundOpacity);

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Ticker,${settings.fontFamily},${settings.fontSize},${primaryColour},${primaryColour},&H00000000,${backColour},0,0,0,0,100,100,0,0,3,0,0,7,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,${formatAssTime(durationSeconds)},Ticker,,0,0,0,,{\\an7\\move(${settings.resolutionWidth},${y},${endX},${y})}${escaped}`,
    '',
  ].join('\n');
}

export function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N');
}

function defaultSettings(): OverlayControlSettings {
  return {
    mode: 'preview-only',
    logo: DEFAULT_LOGO_SETTINGS,
    ticker: DEFAULT_TICKER_SETTINGS,
    safety: SAFETY,
    updatedAt: new Date().toISOString(),
  };
}

function getSafeNameDisplayLookup(): Map<string, string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT suggested_program_key, safe_slug, display_name_ar
    FROM program_candidates
  `).all() as Array<{ suggested_program_key: string; safe_slug: string; display_name_ar: string }>;
  const lookup = new Map<string, string>();
  for (const row of rows) {
    lookup.set(row.suggested_program_key, row.display_name_ar);
    lookup.set(row.safe_slug, row.display_name_ar);
  }
  return lookup;
}

function normalizeLogoPath(value: string | null): string | null {
  const raw = cleanString(value ?? '');
  if (!raw) return null;
  if (/^(rtmp|rtmps|http|https):\/\//i.test(raw)) {
    throw new DraftValidationError('Logo path must be a local project-controlled asset', 'UNSAFE_LOGO_PATH');
  }
  const resolved = path.resolve(raw);
  const allowedRoots = [getLogoAssetRoot(), path.join(config.paths.assets, 'overlays')].map(root => path.resolve(root));
  if (!allowedRoots.some(root => isInside(resolved, root))) {
    throw new DraftValidationError('Logo path must stay under data/overlay-assets or assets/overlays', 'UNSAFE_LOGO_PATH');
  }
  if (resolved.includes('/srv/daawah/media') || resolved.includes('\\srv\\daawah\\media')) {
    throw new DraftValidationError('Logo path cannot point inside /srv/daawah/media', 'UNSAFE_LOGO_PATH');
  }
  return resolved;
}

function normalizeAssetId(value: string | null): string | null {
  const raw = cleanString(value ?? '');
  if (!raw) return null;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) {
    throw new DraftValidationError('Logo asset id contains unsafe characters', 'UNSAFE_LOGO_ASSET_ID');
  }
  return raw;
}

function normalizePosition(value: unknown): LogoPosition {
  if (
    value === 'top-right' ||
    value === 'top-left' ||
    value === 'bottom-right' ||
    value === 'bottom-left' ||
    value === 'custom'
  ) {
    return value;
  }
  return DEFAULT_LOGO_SETTINGS.position;
}

function normalizeDate(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date().toISOString().slice(0, 10);
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)) return value.toUpperCase();
  return fallback;
}

function assColor(hex: string, opacity: number): string {
  const alpha = Math.round((1 - clampNumber(opacity, 0, 1)) * 255);
  const rr = hex.slice(1, 3);
  const gg = hex.slice(3, 5);
  const bb = hex.slice(5, 7);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${bb}${gg}${rr}`;
}

function formatAssTime(totalSeconds: number): string {
  const centiseconds = Math.floor(totalSeconds * 100);
  const cs = centiseconds % 100;
  const total = Math.floor(centiseconds / 100);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}

function getOverlayDataRoot(): string {
  return path.join(config.paths.data, 'overlays');
}

function getTickerDataRoot(): string {
  return path.join(getOverlayDataRoot(), 'tickers');
}

function getLogoAssetRoot(): string {
  return path.join(config.paths.data, 'overlay-assets');
}

function getSettingsPath(): string {
  return path.join(getOverlayDataRoot(), 'settings.json');
}

function ensureProjectPath(targetPath: string, rootPath: string): void {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(rootPath);
  if (!isInside(resolved, root)) {
    throw new DraftValidationError('Overlay output path escapes project-controlled overlay directory', 'UNSAFE_OVERLAY_OUTPUT_PATH');
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampNullableInt(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return clampInt(value, min, max);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
