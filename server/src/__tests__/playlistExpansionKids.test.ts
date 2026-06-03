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

  it('auto-repeats a wizard cycle to fill the day and trims rows at the next cycle boundary', () => {
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const { expandPublishedScheduleToFiles } = require('../schedule/playlistExpansion') as typeof import('../schedule/playlistExpansion');
    const db = getDb();
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    insertFolder(db, 'p1-folder', 'program-a');
    insertFolder(db, 'p2-folder', 'program-b');
    insertReadyProgram(db, mediaDir, 'p1-media', 'program-a/001.mp4', 'p1-folder', 3600);
    insertReadyProgram(db, mediaDir, 'p2-media', 'program-b/001.mp4', 'p2-folder', 1200);
    insertReadyFiller(db, mediaDir, 'filler-media', 1800);

    const result = expandPublishedScheduleToFiles({
      programs: [
        programRow('p1', 'Program A'),
        programRow('p2', 'Program B'),
      ],
      slots: [
        slotRow(2, 'p1', '08:00', 60, 'main airing; cycle 1/1'),
        slotRow(3, 'p2', '15:50', 20, 'main airing; cycle 1/1'),
      ],
      folderMatches: [
        folderMatch('p1', 'p1-folder'),
        folderMatch('p2', 'p2-folder'),
      ],
      schedulePreview: {
        timezone: 'Europe/Istanbul',
        gapPattern: 'professional_gap_filler',
        truncated: false,
        days: [{
          date: '2026-06-06',
          day: 'sat',
          rows: [
            gapRow('00:00', '08:00', 480),
            previewSlot(2, 'p1', 'Program A', '08:00', '09:00', 60),
            gapRow('09:00', '15:50', 410),
            previewSlot(3, 'p2', 'Program B', '15:50', '16:10', 20),
            gapRow('16:10', '24:00', 470),
          ],
        }],
      },
    } as never);

    const programItems = result.items.filter(item => item.type === 'program');
    const p1Starts = programItems.filter(item => item.programKey === 'p1').map(item => item.startTime);
    const p2Windows = programItems
      .filter(item => item.programKey === 'p2')
      .map(item => `${item.startTime}-${item.endTime}:${item.durationSeconds}`);

    expect(result.errors).toEqual([]);
    expect(result.warnings.some(warning => warning.code === 'AUTO_CYCLE_REPEAT_APPLIED')).toBe(true);
    expect(p1Starts).toEqual(['00:00:00', '08:00:00', '16:00:00']);
    expect(p2Windows).toEqual([
      '07:50:00-08:00:00:600',
      '15:50:00-16:00:00:600',
      '23:50:00-24:00:00:600',
    ]);
    expect(result.summary.mediaExpansionAvailable).toBe(true);
  });
});

function insertFolder(
  db: ReturnType<typeof import('../db/schema').getDb>,
  id: string,
  relativePath: string
): void {
  db.prepare(`
    INSERT INTO media_folders
      (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, parent_folder_id, file_count, status)
    VALUES (?, 'root-original-ar', ?, ?, ?, ?, NULL, 1, 'indexed')
  `).run(id, relativePath, relativePath, relativePath, relativePath);
}

function insertReadyProgram(
  db: ReturnType<typeof import('../db/schema').getDb>,
  mediaDir: string,
  id: string,
  relativePath: string,
  folderId: string,
  durationSec = 600
): void {
  const filePath = path.join(mediaDir, `${id}.mp4`);
  fs.writeFileSync(filePath, id);
  db.prepare(`
    INSERT INTO media_files
      (id, path, relative_path, filename, type, status, root_id, folder_id, duration_sec, duration_ms, file_size)
    VALUES (?, ?, ?, ?, 'program', 'ready', 'root-original-ar', ?, ?, ?, ?)
  `).run(id, filePath, relativePath, path.basename(relativePath), folderId, durationSec, durationSec * 1000, fs.statSync(filePath).size);
}

function insertReadyFiller(
  db: ReturnType<typeof import('../db/schema').getDb>,
  mediaDir: string,
  id: string,
  durationSec: number
): void {
  const filePath = path.join(mediaDir, `${id}.mp4`);
  fs.writeFileSync(filePath, id);
  db.prepare(`
    INSERT INTO media_files
      (id, path, relative_path, filename, type, status, root_id, folder_id, duration_sec, duration_ms, file_size)
    VALUES (?, ?, ?, ?, 'filler', 'ready', 'root-original-ar', NULL, ?, ?, ?)
  `).run(id, filePath, `${id}.mp4`, `${id}.mp4`, durationSec, durationSec * 1000, fs.statSync(filePath).size);
}

function programRow(programKey: string, name: string): Record<string, unknown> {
  return {
    row: 2,
    status: 'ok',
    program_key: programKey,
    program_name: name,
    hide_logo: false,
    folder_hint: programKey,
    normalized_folder_hint: programKey,
    folder_root: 'original-ar',
    play_mode: 'sequential',
    slot_mode: 'fit',
    file_count: null,
    repeat_policy: 'advance_each_airing',
    enabled: true,
    notes: '',
    issues: [],
  };
}

function folderMatch(programKey: string, folderId: string): Record<string, unknown> {
  return {
    row: 2,
    program_key: programKey,
    folder_root: 'original-ar',
    folder_hint: programKey,
    status: 'matched',
    status_ar: 'matched',
    confidence: 100,
    matched_folder_id: folderId,
    matched_relative_path: programKey,
    suggestions: [],
    message: '',
  };
}

function slotRow(
  row: number,
  programKey: string,
  startTime: string,
  durationMinutes: number,
  notes: string
): Record<string, unknown> {
  const startMinutes = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3, 5));
  return {
    row,
    status: 'ok',
    program_key: programKey,
    days: ['sat'],
    raw_days: 'sat',
    start_time: startTime,
    end_time: '',
    duration_minutes: durationMinutes,
    effective_from: '2026-06-06',
    effective_to: '2026-06-06',
    priority: row,
    notes,
    start_minutes: startMinutes,
    end_minutes: null,
    computed_end_minutes: startMinutes + durationMinutes,
    crosses_midnight: false,
    issues: [],
  };
}

function previewSlot(
  row: number,
  programKey: string,
  title: string,
  startTime: string,
  endTime: string,
  durationMinutes: number
): Record<string, unknown> {
  return {
    type: 'slot',
    row,
    program_key: programKey,
    title,
    start_time: startTime,
    end_time: endTime,
    duration_minutes: durationMinutes,
  };
}

function gapRow(startTime: string, endTime: string, durationMinutes: number): Record<string, unknown> {
  return {
    type: 'gap',
    row: null,
    program_key: null,
    title: 'Professional Gap Preview',
    start_time: startTime,
    end_time: endTime,
    duration_minutes: durationMinutes,
  };
}
