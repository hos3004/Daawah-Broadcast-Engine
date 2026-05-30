import fs from 'fs';
import os from 'os';
import path from 'path';

describe('professional gap filler', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let mainDir: string;
  let seasonalDir: string;
  let generalDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-gap-'));
    mainDir = path.join(tempDir, 'bumpers', 'logo-sting');
    seasonalDir = path.join(tempDir, 'bumpers', 'sting-hag');
    generalDir = path.join(tempDir, 'bumpers', 'general');

    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(seasonalDir, { recursive: true });
    fs.mkdirSync(path.join(generalDir, 'A'), { recursive: true });
    fs.mkdirSync(path.join(generalDir, 'B'), { recursive: true });
    fs.mkdirSync(path.join(generalDir, 'C'), { recursive: true });

    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;
    process.env['PLAYLISTS_PATH'] = path.join(tempDir, 'playlists');
    process.env['MEDIA_LIBRARY_PATH'] = path.join(tempDir, 'media', 'library');
    process.env['MEDIA_EMERGENCY_PATH'] = path.join(tempDir, 'media', 'emergency');
    process.env['GAP_MAIN_STING_PATH'] = mainDir;
    process.env['GAP_SEASONAL_STING_PATH'] = seasonalDir;
    process.env['GAP_GENERAL_BUMPERS_PATH'] = generalDir;
    process.env['GAP_PATTERN'] = 'main,seasonal,general,general,general';
  });

  afterEach(() => {
    closeDb?.();
    closeDb = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('starts a 15 minute gap with main, seasonal, and three general bumpers, then repeats', () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();
    seedProfessionalBumpers(db, mainDir, seasonalDir, generalDir);

    const items = fillGapWithProfessionalBumpers(0, 15 * 60_000, db, 0);

    expect(items.slice(0, 6).map(item => item.source_role)).toEqual([
      'main_sting',
      'seasonal_sting',
      'general_bumper',
      'general_bumper',
      'general_bumper',
      'main_sting',
    ]);
  });

  it('trims the last bumper to preserve a 40 second hard start gap', () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();
    insertMedia(db, 'main-1', path.join(mainDir, '01-main.mp4'), 60);

    const items = fillGapWithProfessionalBumpers(0, 40_000, db, 0);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source_role: 'main_sting',
      duration_ms: 40_000,
      is_trimmed: true,
      trim_out_ms: 40_000,
      forced_duration_ms: 40_000,
    });
  });

  it('skips an empty seasonal folder without stopping the sequence', () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();
    insertMedia(db, 'main-1', path.join(mainDir, '01-main.mp4'), 60);
    insertMedia(db, 'general-a-1', path.join(generalDir, 'A', '01-a.mp4'), 60);

    const items = fillGapWithProfessionalBumpers(0, 3 * 60_000, db, 0);

    expect(items.map(item => item.source_role)).not.toContain('seasonal_sting');
    expect(items.some(item => item.source_role === 'main_sting')).toBe(true);
    expect(items.some(item => item.source_role === 'general_bumper')).toBe(true);
  });

  it('persists cursors so the next build does not restart from the same file when another exists', () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();
    insertMedia(db, 'main-1', path.join(mainDir, '01-main.mp4'), 60);
    insertMedia(db, 'main-2', path.join(mainDir, '02-main.mp4'), 60);

    const first = fillGapWithProfessionalBumpers(0, 60_000, db, 0);
    const second = fillGapWithProfessionalBumpers(60_000, 120_000, db, 1);

    expect(first[0]?.media_file_id).toBe('main-1');
    expect(second[0]?.media_file_id).toBe('main-2');
  });

  it('round-robins general bumpers across subfolders', () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();
    insertMedia(db, 'general-a-1', path.join(generalDir, 'A', '01-a.mp4'), 60);
    insertMedia(db, 'general-b-1', path.join(generalDir, 'B', '01-b.mp4'), 60);
    insertMedia(db, 'general-c-1', path.join(generalDir, 'C', '01-c.mp4'), 60);

    const items = fillGapWithProfessionalBumpers(0, 3 * 60_000, db, 0);

    expect(items.map(item => item.media_file_id)).toEqual([
      'general-a-1',
      'general-b-1',
      'general-c-1',
    ]);
  });

  it('returns no professional items when no professional bumper folders are available', () => {
    fs.rmSync(path.join(tempDir, 'bumpers'), { recursive: true, force: true });

    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();

    expect(fillGapWithProfessionalBumpers(0, 60_000, db, 0)).toEqual([]);
  });

  it('does not loop when the pattern only contains an empty role while another role has bumpers', () => {
    process.env['GAP_PATTERN'] = 'seasonal';

    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();
    insertMedia(db, 'main-1', path.join(mainDir, '01-main.mp4'), 60);

    expect(fillGapWithProfessionalBumpers(0, 60_000, db, 0)).toEqual([]);
  });

  it('supports dry-run cursor planning without persisting cursor updates', () => {
    process.env['GAP_PATTERN'] = 'main,main';

    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();
    insertMedia(db, 'main-1', path.join(mainDir, '01-main.mp4'), 60);
    insertMedia(db, 'main-2', path.join(mainDir, '02-main.mp4'), 60);

    const items = fillGapWithProfessionalBumpers(0, 120_000, db, 0, { updateCursors: false });
    const cursorCount = (db.prepare('SELECT COUNT(*) as cnt FROM bumper_cursor_state')
      .get() as { cnt: number }).cnt;

    expect(items.map(item => item.media_file_id)).toEqual(['main-1', 'main-2']);
    expect(cursorCount).toBe(0);
  });

  it('continues a dry-run cursor plan across separate gaps without database writes', () => {
    process.env['GAP_PATTERN'] = 'main';

    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { fillGapWithProfessionalBumpers } = require('../playlist/gapFiller') as typeof import('../playlist/gapFiller');

    initDb();
    closeDb = close;
    const db = getDb();
    insertMedia(db, 'main-1', path.join(mainDir, '01-main.mp4'), 60);
    insertMedia(db, 'main-2', path.join(mainDir, '02-main.mp4'), 60);

    const plannedCursors = new Map();
    const first = fillGapWithProfessionalBumpers(0, 60_000, db, 0, {
      updateCursors: false,
      plannedCursors,
    });
    const second = fillGapWithProfessionalBumpers(10 * 60_000, 11 * 60_000, db, 1, {
      updateCursors: false,
      plannedCursors,
    });
    const cursorCount = (db.prepare('SELECT COUNT(*) as cnt FROM bumper_cursor_state')
      .get() as { cnt: number }).cnt;

    expect(first.map(item => item.media_file_id)).toEqual(['main-1']);
    expect(second.map(item => item.media_file_id)).toEqual(['main-2']);
    expect(cursorCount).toBe(0);
  });
});

function seedProfessionalBumpers(
  db: ReturnType<typeof import('../db/schema').getDb>,
  mainDir: string,
  seasonalDir: string,
  generalDir: string
): void {
  insertMedia(db, 'main-1', path.join(mainDir, '01-main.mp4'), 60);
  insertMedia(db, 'main-2', path.join(mainDir, '02-main.mp4'), 60);
  insertMedia(db, 'seasonal-1', path.join(seasonalDir, '01-seasonal.mp4'), 60);
  insertMedia(db, 'seasonal-2', path.join(seasonalDir, '02-seasonal.mp4'), 60);
  insertMedia(db, 'general-a-1', path.join(generalDir, 'A', '01-a.mp4'), 60);
  insertMedia(db, 'general-b-1', path.join(generalDir, 'B', '01-b.mp4'), 60);
  insertMedia(db, 'general-c-1', path.join(generalDir, 'C', '01-c.mp4'), 60);
}

function insertMedia(
  db: ReturnType<typeof import('../db/schema').getDb>,
  id: string,
  filePath: string,
  durationSec: number
): void {
  db.prepare(`
    INSERT INTO media_files
      (id, path, relative_path, filename, type, status, duration_sec)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, filePath, path.basename(filePath), path.basename(filePath), 'filler', 'ready', durationSec);
}
