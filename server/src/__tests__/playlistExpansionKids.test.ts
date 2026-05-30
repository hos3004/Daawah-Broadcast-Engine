import fs from 'fs';
import os from 'os';
import path from 'path';

describe('kids playlist expansion', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-kids-expansion-'));
    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;

    const { initDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    initDb();
    closeDb = close;
  });

  afterEach(() => {
    closeDb?.();
    closeDb = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('takes the first file from each kids child folder, then the second from each child folder', () => {
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const { expandPublishedScheduleToFiles } = require('../schedule/playlistExpansion') as typeof import('../schedule/playlistExpansion');
    const db = getDb();

    db.prepare(`
      INSERT INTO media_folders
        (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, parent_folder_id, file_count, status)
      VALUES (?, 'root-original-ar', ?, ?, ?, ?, ?, ?, 'indexed')
    `).run('kids-folder', 'kids', 'Kids', 'kids', 'kids', null, 4);
    db.prepare(`
      INSERT INTO media_folders
        (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, parent_folder_id, file_count, status)
      VALUES (?, 'root-original-ar', ?, ?, ?, ?, ?, ?, 'indexed')
    `).run('kids-a', 'kids/A', 'Kids A', 'kids a', 'kids-a', 'kids-folder', 2);
    db.prepare(`
      INSERT INTO media_folders
        (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, parent_folder_id, file_count, status)
      VALUES (?, 'root-original-ar', ?, ?, ?, ?, ?, ?, 'indexed')
    `).run('kids-b', 'kids/B', 'Kids B', 'kids b', 'kids-b', 'kids-folder', 2);

    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    insertReadyProgram(db, mediaDir, 'kids-a-1', 'kids/A/001.mp4', 'kids-a');
    insertReadyProgram(db, mediaDir, 'kids-a-2', 'kids/A/002.mp4', 'kids-a');
    insertReadyProgram(db, mediaDir, 'kids-b-1', 'kids/B/001.mp4', 'kids-b');
    insertReadyProgram(db, mediaDir, 'kids-b-2', 'kids/B/002.mp4', 'kids-b');

    const result = expandPublishedScheduleToFiles({
      programs: [{
        row: 2,
        status: 'ok',
        program_key: 'kids',
        program_name: 'Kids',
        hide_logo: true,
        folder_hint: 'kids',
        normalized_folder_hint: 'kids',
        folder_root: 'original-ar',
        play_mode: 'sequential',
        slot_mode: 'kids_round_robin',
        file_count: null,
        repeat_policy: 'advance_each_airing',
        enabled: true,
        notes: '',
        issues: [],
      }],
      folderMatches: [{
        row: 2,
        program_key: 'kids',
        folder_root: 'original-ar',
        folder_hint: 'kids',
        status: 'matched',
        status_ar: 'matched',
        confidence: 100,
        matched_folder_id: 'kids-folder',
        matched_relative_path: 'kids',
        suggestions: [],
        message: '',
      }],
      schedulePreview: {
        timezone: 'Europe/Istanbul',
        gapPattern: 'professional_gap_filler',
        truncated: false,
        days: [{
          date: '2026-06-06',
          day: 'sat',
          rows: [{
            type: 'slot',
            row: 2,
            program_key: 'kids',
            title: 'Kids',
            start_time: '00:00',
            end_time: '00:40',
            duration_minutes: 40,
          }],
        }],
      },
    } as never);

    expect(result.errors).toEqual([]);
    expect(result.items.map(item => item.mediaFileId)).toEqual([
      'kids-a-1',
      'kids-b-1',
      'kids-a-2',
      'kids-b-2',
    ]);
    expect(result.items.every(item => item.hideLogo === true)).toBe(true);
    expect(result.summary.mediaExpansionAvailable).toBe(true);
  });
});

function insertReadyProgram(
  db: ReturnType<typeof import('../db/schema').getDb>,
  mediaDir: string,
  id: string,
  relativePath: string,
  folderId: string
): void {
  const filePath = path.join(mediaDir, `${id}.mp4`);
  fs.writeFileSync(filePath, id);
  db.prepare(`
    INSERT INTO media_files
      (id, path, relative_path, filename, type, status, root_id, folder_id, duration_sec, duration_ms, file_size)
    VALUES (?, ?, ?, ?, 'program', 'ready', 'root-original-ar', ?, 600, 600000, ?)
  `).run(id, filePath, relativePath, path.basename(relativePath), folderId, fs.statSync(filePath).size);
}
