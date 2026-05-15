import fs from 'fs';
import os from 'os';
import path from 'path';

describe('playlist build integration', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-playlist-'));
    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;
    process.env['PLAYLISTS_PATH'] = path.join(tempDir, 'playlists');
    process.env['MEDIA_LIBRARY_PATH'] = path.join(tempDir, 'media', 'library');
    process.env['MEDIA_EMERGENCY_PATH'] = path.join(tempDir, 'media', 'emergency');
  });

  afterEach(() => {
    closeDb?.();
    closeDb = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('imports, validates, publishes, and builds today playlist without treating emergency as a SQL column', async () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { importScheduleFromJson } = require('../schedule/importer') as typeof import('../schedule/importer');
    const { validateSchedule, publishSchedule } = require('../schedule/validator') as typeof import('../schedule/validator');
    const { buildDailyPlaylist } = require('../playlist/builder') as typeof import('../playlist/builder');

    initDb();
    closeDb = close;

    const db = getDb();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).run('user-1', 'smoke@example.com', 'hash', 'admin');

    db.prepare(`
      INSERT INTO programs (id, name, name_ar, folder_path, play_mode)
      VALUES (?, ?, ?, ?, ?)
    `).run('program-1', 'Smoke Program', 'Smoke Program', 'programs', 'sequential');

    db.prepare(`
      INSERT INTO media_files
        (id, path, relative_path, filename, type, status, program_id, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'program-media-1',
      path.join(tempDir, 'media', 'library', 'programs', 'program-1.mp4'),
      path.join('programs', 'program-1.mp4'),
      'program-1.mp4',
      'program',
      'ready',
      'program-1',
      60
    );

    db.prepare(`
      INSERT INTO media_files
        (id, path, relative_path, filename, type, status, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'emergency-media-1',
      path.join(tempDir, 'media', 'emergency', 'emergency-1.mp4'),
      'emergency-1.mp4',
      'emergency-1.mp4',
      'emergency',
      'ready',
      30
    );

    const today = '2026-05-15';
    const importResult = importScheduleFromJson([
      {
        date: today,
        start_time: '10:00',
        type: 'program',
        program_id: 'program-1',
        episode_id: null,
        title: 'Smoke Program Slot',
        expected_duration: 60,
        duration_policy: 'exact',
      },
      {
        date: today,
        start_time: '10:02',
        type: 'filler',
        program_id: null,
        episode_id: null,
        title: 'Smoke Filler Slot',
        expected_duration: 30,
        duration_policy: 'exact',
      },
    ], 'Smoke Schedule', 'user-1');

    const report = validateSchedule(importResult.scheduleId);
    expect(report.isValid).toBe(true);

    publishSchedule(importResult.scheduleId, 'user-1');

    const playlist = await buildDailyPlaylist(today);
    const scheduledProgram = playlist.items.find(item => item.title === 'Smoke Program Slot');
    const emergencyBackedSlot = playlist.items.find(item => item.title === 'Smoke Filler Slot');

    expect(scheduledProgram).toMatchObject({
      type: 'program',
      media_file_id: 'program-media-1',
      is_emergency: false,
    });
    expect(emergencyBackedSlot).toMatchObject({
      type: 'filler',
      media_file_id: 'emergency-media-1',
      is_emergency: true,
    });
    expect(playlist.items.some(item => item.media_file_id === 'program-media-1')).toBe(true);

    const playlistPath = path.join(tempDir, 'playlists', `${today}.json`);
    expect(fs.existsSync(playlistPath)).toBe(true);
  });
});
