import fs from 'fs';
import os from 'os';
import path from 'path';

describe('schedule importer media_file_id support', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-import-media-'));
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

  it('imports, validates, publishes, and builds an item addressed by media_file_id only', async () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { importScheduleFromJson } = require('../schedule/importer') as typeof import('../schedule/importer');
    const { validateSchedule, publishSchedule } = require('../schedule/validator') as typeof import('../schedule/validator');
    const { buildDailyPlaylist } = require('../playlist/builder') as typeof import('../playlist/builder');

    initDb();
    closeDb = close;
    const db = getDb();

    db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('user-1', 'media-file-id@example.com', 'hash', 'admin');

    db.prepare(`
      INSERT INTO media_files
        (id, path, relative_path, filename, type, status, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'direct-media-1',
      path.join(tempDir, 'media', 'direct-media-1.mp4'),
      'direct-media-1.mp4',
      'direct-media-1.mp4',
      'program',
      'ready',
      24 * 60 * 60
    );

    const date = '2026-05-15';
    const importResult = importScheduleFromJson([
      {
        date,
        start_time: '00:00',
        type: 'program',
        media_file_id: 'direct-media-1',
        title: 'Direct Media Program',
        expected_duration: 24 * 60 * 60,
      },
    ], 'Direct Media Schedule', 'user-1');

    const storedItem = db.prepare('SELECT media_file_id FROM schedule_items WHERE schedule_id=?')
      .get(importResult.scheduleId) as { media_file_id: string | null };
    expect(storedItem.media_file_id).toBe('direct-media-1');

    const report = validateSchedule(importResult.scheduleId);
    expect(report.isValid).toBe(true);

    publishSchedule(importResult.scheduleId, 'user-1');
    const playlist = await buildDailyPlaylist(date);

    expect(playlist.items[0]).toMatchObject({
      title: 'Direct Media Program',
      media_file_id: 'direct-media-1',
      source_role: 'program',
    });
  });
});
