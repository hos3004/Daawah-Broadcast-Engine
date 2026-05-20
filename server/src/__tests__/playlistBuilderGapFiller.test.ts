import fs from 'fs';
import os from 'os';
import path from 'path';

describe('playlist builder professional gap filler integration', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-builder-gap-'));
    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;
    process.env['PLAYLISTS_PATH'] = path.join(tempDir, 'playlists');
    process.env['MEDIA_LIBRARY_PATH'] = path.join(tempDir, 'media', 'library');
    process.env['MEDIA_EMERGENCY_PATH'] = path.join(tempDir, 'media', 'emergency');
    process.env['GAP_MAIN_STING_PATH'] = path.join(tempDir, 'missing', 'main');
    process.env['GAP_SEASONAL_STING_PATH'] = path.join(tempDir, 'missing', 'seasonal');
    process.env['GAP_GENERAL_BUMPERS_PATH'] = path.join(tempDir, 'missing', 'general');
  });

  afterEach(() => {
    closeDb?.();
    closeDb = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('uses emergency/filler fallback when no professional bumpers are available', async () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { importScheduleFromJson } = require('../schedule/importer') as typeof import('../schedule/importer');
    const { validateSchedule, publishSchedule } = require('../schedule/validator') as typeof import('../schedule/validator');
    const { buildDailyPlaylist } = require('../playlist/builder') as typeof import('../playlist/builder');

    initDb();
    closeDb = close;
    const db = getDb();

    db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('user-1', 'builder-gap@example.com', 'hash', 'admin');

    insertMedia(db, 'program-1', path.join(tempDir, 'media', 'program-1.mp4'), 'program', 60);
    insertMedia(db, 'program-2', path.join(tempDir, 'media', 'program-2.mp4'), 'program', 24 * 60 * 60);
    insertMedia(db, 'emergency-1', path.join(tempDir, 'media', 'emergency-1.mp4'), 'emergency', 30);

    const date = '2026-05-15';
    const importResult = importScheduleFromJson([
      {
        date,
        start_time: '00:00',
        type: 'program',
        media_file_id: 'program-1',
        title: 'Opening Program',
        expected_duration: 60,
      },
      {
        date,
        start_time: '00:03',
        type: 'program',
        media_file_id: 'program-2',
        title: 'Long Program',
        expected_duration: 24 * 60 * 60,
      },
    ], 'Fallback Gap Schedule', 'user-1');

    const report = validateSchedule(importResult.scheduleId);
    expect(report.isValid).toBe(true);
    publishSchedule(importResult.scheduleId, 'user-1');

    const playlist = await buildDailyPlaylist(date);
    const fallbackItems = playlist.items.filter(item => item.source_role === 'emergency');

    expect(fallbackItems.length).toBeGreaterThan(0);
    expect(fallbackItems.every(item => item.media_file_id === 'emergency-1')).toBe(true);
  });
});

function insertMedia(
  db: ReturnType<typeof import('../db/schema').getDb>,
  id: string,
  filePath: string,
  type: string,
  durationSec: number
): void {
  db.prepare(`
    INSERT INTO media_files
      (id, path, relative_path, filename, type, status, duration_sec)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, filePath, path.basename(filePath), path.basename(filePath), type, 'ready', durationSec);
}
