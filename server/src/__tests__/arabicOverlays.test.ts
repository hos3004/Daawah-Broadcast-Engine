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

  it('escapes ASS special characters and renders moving UTF-8 ASS output', () => {
    const { escapeAssText, renderTickerAss, validateTickerSettings } = require('../overlays/controlPanel') as typeof import('../overlays/controlPanel');
    const escaped = escapeAssText('خبر {مهم}\\سطر\nثان');
    const ass = renderTickerAss('تشاهدون اليوم: خبر مهم', validateTickerSettings({ fontFamily: 'Noto Sans Arabic' }));

    expect(escaped).toBe('خبر \\{مهم\\}\\\\سطر\\Nثان');
    expect(Buffer.from(ass, 'utf8').toString('utf8')).toContain('تشاهدون اليوم');
    expect(ass).toContain('\\move(');
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
});
