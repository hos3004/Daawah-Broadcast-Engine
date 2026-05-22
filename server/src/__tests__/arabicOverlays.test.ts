import fs from 'fs';
import os from 'os';
import path from 'path';

describe('Arabic overlay control panel', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-arabic-overlays-'));
    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;
    process.env['ASSETS_PATH'] = path.join(tempDir, 'assets');
  });

  afterEach(() => {
    try {
      const { closeDb } = require('../db/schema') as typeof import('../db/schema');
      closeDb();
    } catch {
      // Module may not have been loaded by a test.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('generates Arabic ticker text from schedule data and safe display names', () => {
    const { buildTickerText, scheduleItemsFromPreview } = require('../overlays/controlPanel') as typeof import('../overlays/controlPanel');
    const preview = {
      days: [
        {
          date: '2026-05-22',
          rows: [
            { type: 'slot', start_time: '08:00', program_key: 'tafseer', title: 'تفسير خام' },
            { type: 'slot', start_time: '09:30', program_key: 'seerah', title: 'السيرة' },
          ],
        },
      ],
    };
    const lookup = new Map<string, string>([['tafseer', 'برنامج التفسير']]);
    const items = scheduleItemsFromPreview(preview, '2026-05-22', 5, lookup);
    const text = buildTickerText({ mode: 'today', messages: [], scheduleItems: items });

    expect(items).toEqual([
      { time: '08:00', title: 'برنامج التفسير', programKey: 'tafseer' },
      { time: '09:30', title: 'السيرة', programKey: 'seerah' },
    ]);
    expect(text).toBe('تشاهدون اليوم: 08:00 برنامج التفسير • 09:30 السيرة');
  });

  it('reads today ticker items from the active published schedule snapshot', () => {
    const { getDb, initDb } = require('../db/schema') as typeof import('../db/schema');
    const {
      activatePublishedSchedule,
      publishSchedulerDraft,
      saveSchedulerDraft,
    } = require('../schedule/drafts') as typeof import('../schedule/drafts');
    const {
      buildTickerPreview,
      getTodayScheduleItems,
    } = require('../overlays/controlPanel') as typeof import('../overlays/controlPanel');
    initDb();
    const db = getDb();
    const existingSourceRoot = db.prepare('SELECT id FROM media_roots WHERE root_key=?').get('source') as { id: string } | undefined;
    const sourceRootId = existingSourceRoot?.id ?? 'root-source';
    if (!existingSourceRoot) {
      db.prepare(`
        INSERT INTO media_roots (id, root_key, absolute_path, is_readonly, is_original_library)
        VALUES (?, ?, ?, ?, ?)
      `).run(sourceRootId, 'source', path.join(tempDir, 'source'), 1, 0);
    }
    db.prepare(`
      INSERT INTO media_folders
        (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('folder-tafseer', sourceRootId, 'Tafseer', 'تفسير', 'tafseer', 'tafseer', 1, 'indexed');
    db.prepare(`
      INSERT INTO program_candidates
        (id, folder_id, suggested_program_key, display_name_ar, safe_slug, episode_count, play_mode_suggestion, slot_mode_suggestion, confidence_score, needs_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('candidate-tafseer', 'folder-tafseer', 'tafseer', 'برنامج التفسير المعتمد', 'tafseer', 1, 'sequential', 'fit', 1, 0);

    const draft = saveSchedulerDraft({
      name: 'Active ticker schedule',
      sourceExcel: { filename: 'ticker.xlsx', sha256: 'a'.repeat(64) },
      preview: makeActiveSchedulePreview() as unknown as import('../schedule/excelPreview').ExcelImportPreviewResult,
      createdBy: null,
    });
    const published = publishSchedulerDraft({ draftId: draft.id, publishedBy: null });
    activatePublishedSchedule({
      publishedScheduleId: published.id,
      requestedScheduleId: published.id,
      confirmActivation: true,
      confirmationText: `ACTIVATE SCHEDULE ${published.id}`,
      activatedBy: null,
    });

    const items = getTodayScheduleItems({ date: '2026-05-22', limit: 5 });
    const preview = buildTickerPreview({ mode: 'today', date: '2026-05-22' });

    expect(items).toEqual([
      { time: '08:00', title: 'برنامج التفسير المعتمد', programKey: 'tafseer' },
      { time: '09:30', title: 'السيرة', programKey: 'seerah' },
    ]);
    expect(preview.text).toContain('برنامج التفسير المعتمد');
    expect(preview.text).toContain('09:30 السيرة');
  });

  it('escapes ASS special characters and renders moving UTF-8 ASS output', () => {
    const { escapeAssText, renderTickerAss, validateTickerSettings } = require('../overlays/controlPanel') as typeof import('../overlays/controlPanel');
    const escaped = escapeAssText('خبر {مهم}\\سطر\nثان');
    const ass = renderTickerAss('تشاهدون اليوم: خبر مهم', validateTickerSettings({ fontFamily: 'Noto Sans Arabic' }));

    expect(validateTickerSettings({}).fontFamily).toBe('Noto Naskh Arabic');
    expect(escaped).toBe('خبر \\{مهم\\}\\\\سطر\\Nثان');
    expect(Buffer.from(ass, 'utf8').toString('utf8')).toContain('تشاهدون اليوم');
    expect(ass).toContain('\\move(');
    expect(ass).toContain('PlayResX: 1280');
    expect(ass).toContain('Fontname');
  });

  it('exports ticker.ass, ticker.json, and overlay-manifest.json under data only', () => {
    const { exportTickerAss } = require('../overlays/controlPanel') as typeof import('../overlays/controlPanel');
    const result = exportTickerAss({
      mode: 'manual',
      messages: ['رسالة تجريبية'],
      date: '2026-05-22',
    });

    expect(result.mode).toBe('ticker-export');
    expect(result.safety).toMatchObject({
      previewOnly: true,
      liveActivation: false,
      ffmpegExecution: false,
      restartPlayout: false,
    });
    for (const outputPath of [result.tickerAssPath, result.tickerJsonPath, result.overlayManifestPath]) {
      expect(path.resolve(outputPath).startsWith(path.resolve(tempDir))).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
    }
    expect(fs.readFileSync(result.tickerAssPath, 'utf8')).toContain('رسالة تجريبية');
  });

  it('validates logo overlay config and rejects unsafe media paths', () => {
    const { validateLogoOverlaySettings } = require('../overlays/controlPanel') as typeof import('../overlays/controlPanel');
    const safeLogoDir = path.join(tempDir, 'overlay-assets');
    fs.mkdirSync(safeLogoDir, { recursive: true });
    const safeLogo = path.join(safeLogoDir, 'logo.png');
    fs.writeFileSync(safeLogo, 'png');

    expect(validateLogoOverlaySettings({
      enabled: true,
      logoPath: safeLogo,
      position: 'bottom-left',
      scale: 0.25,
      opacity: 0.7,
    })).toMatchObject({
      enabled: true,
      position: 'bottom-left',
      scale: 0.25,
      opacity: 0.7,
    });

    expect(() => validateLogoOverlaySettings({
      logoPath: '/srv/daawah/media/source/logo.png',
    })).toThrow(/Logo path/);
  });

  it('manages logo assets under data/overlay-assets with type and size validation', () => {
    const {
      deleteLogoAsset,
      listLogoAssets,
      saveLogoAsset,
      validateLogoOverlaySettings,
    } = require('../overlays/controlPanel') as typeof import('../overlays/controlPanel');
    const asset = saveLogoAsset({
      originalFilename: 'شعار.png',
      mimeType: 'image/png',
      buffer: Buffer.from('png-data'),
    });

    expect(asset.absolutePath).toContain(path.join(tempDir, 'overlay-assets'));
    expect(asset.relativePath).toMatch(/^overlay-assets\//);
    expect(fs.existsSync(asset.absolutePath)).toBe(true);
    expect(listLogoAssets().map(item => item.id)).toContain(asset.id);
    expect(validateLogoOverlaySettings({ logoAssetId: asset.id })).toMatchObject({ logoAssetId: asset.id });
    expect(() => saveLogoAsset({
      originalFilename: 'bad.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg />'),
    })).toThrow(/PNG, JPEG, or WebP/);
    expect(() => saveLogoAsset({
      originalFilename: 'huge.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc((5 * 1024 * 1024) + 1),
    })).toThrow(/too large/);
    expect(deleteLogoAsset(asset.id)?.id).toBe(asset.id);
    expect(fs.existsSync(asset.absolutePath)).toBe(false);
  });

  it('saves overlay settings as preview-only JSON without live playout mutation', () => {
    const { saveOverlaySettings } = require('../overlays/controlPanel') as typeof import('../overlays/controlPanel');
    const settings = saveOverlaySettings({
      logo: { enabled: true, position: 'top-left' },
      ticker: { mode: 'manual', fontSize: 40 },
    });
    const settingsPath = path.join(tempDir, 'overlays', 'settings.json');

    expect(settings.mode).toBe('preview-only');
    expect(settings.safety).toMatchObject({
      liveActivation: false,
      restartPlayout: false,
      ffmpegExecution: false,
      rtmpPush: false,
      streamKeyUsage: false,
    });
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  it('does not count FFmpeg cpb buffer size lines as health monitor errors', () => {
    const healthErrorPattern = /error|failed|invalid|corrupt|non-monoton|No such file|Permission denied|DTS|PTS|buffer (queue|underflow|overflow)|Too many packets buffered/i;
    const script = fs.readFileSync(path.resolve(__dirname, '../../../scripts/start-diverse-normalized-hls-test.mjs'), 'utf8');

    expect('cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A').not.toMatch(healthErrorPattern);
    expect(script).toContain('buffer (queue|underflow|overflow)');
    expect(script).not.toContain("DTS|PTS|buffer',");
  });
});

function makeActiveSchedulePreview(): Record<string, unknown> {
  return {
    mode: 'preview',
    willActivateSchedule: false,
    willUpdateCursors: false,
    willMaterializePlaylist: false,
    productionSafety: {
      previewOnly: true,
      cursorUpdates: false,
      playlistMaterialization: false,
      ffmpeg: false,
      scheduleActivation: false,
    },
    settings: {
      row: null,
      status: 'ok',
      timezone: 'Europe/Istanbul',
      timezoneSource: 'sheet',
      schedule_start_date: '2026-05-22',
      schedule_end_date: '2026-05-22',
      default_duration_policy: 'fit',
      default_repeat_policy: 'same_day_same_episode',
      default_gap_policy: 'professional_gap_filler',
      rangeDays: 1,
      issues: [],
    },
    programs: [
      {
        row: 2,
        status: 'ok',
        program_key: 'tafseer',
        program_name: 'تفسير خام',
        folder_hint: 'Tafseer',
        normalized_folder_hint: 'tafseer',
        folder_root: 'source',
        play_mode: 'sequential',
        slot_mode: 'fit',
        file_count: null,
        repeat_policy: 'same_day_same_episode',
        enabled: true,
        notes: '',
        issues: [],
      },
      {
        row: 3,
        status: 'ok',
        program_key: 'seerah',
        program_name: 'السيرة',
        folder_hint: 'Seerah',
        normalized_folder_hint: 'seerah',
        folder_root: 'source',
        play_mode: 'sequential',
        slot_mode: 'fit',
        file_count: null,
        repeat_policy: 'same_day_same_episode',
        enabled: true,
        notes: '',
        issues: [],
      },
    ],
    slots: [
      {
        row: 2,
        status: 'ok',
        program_key: 'tafseer',
        days: ['fri'],
        raw_days: 'fri',
        start_time: '08:00',
        end_time: '09:00',
        duration_minutes: 60,
        effective_from: '2026-05-22',
        effective_to: '2026-05-22',
        priority: 10,
        issues: [],
      },
      {
        row: 3,
        status: 'ok',
        program_key: 'seerah',
        days: ['fri'],
        raw_days: 'fri',
        start_time: '09:30',
        end_time: '10:00',
        duration_minutes: 30,
        effective_from: '2026-05-22',
        effective_to: '2026-05-22',
        priority: 10,
        issues: [],
      },
    ],
    folderMatches: [],
    schedulePreview: {
      timezone: 'Europe/Istanbul',
      gapPattern: 'professional_gap_filler',
      truncated: false,
      days: [
        {
          date: '2026-05-22',
          day: 'fri',
          rows: [
            { type: 'slot', row: 2, program_key: 'tafseer', title: 'تفسير خام', start_time: '08:00', end_time: '09:00', duration_minutes: 60 },
            { type: 'slot', row: 3, program_key: 'seerah', title: 'السيرة', start_time: '09:30', end_time: '10:00', duration_minutes: 30 },
          ],
        },
      ],
    },
    summary: {
      settingsRows: 1,
      programRows: 2,
      slotRows: 2,
      programCount: 2,
      matchedPrograms: 0,
      needsReviewPrograms: 0,
      missingFolders: 0,
      rejectedFolders: 0,
      slotCount: 2,
      conflicts: 0,
      warnings: 0,
      errors: 0,
      crossingMidnight: 0,
      fileStatus: 'صالح للمعاينة',
    },
    issues: [],
    acceptedProgramKeys: ['tafseer', 'seerah'],
  };
}
