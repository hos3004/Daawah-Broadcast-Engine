import fs from 'fs';
import os from 'os';
import path from 'path';

describe('media registry foundation', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-registry-'));
    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;
  });

  afterEach(() => {
    closeDb?.();
    closeDb = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('normalizes Arabic names for matching while preserving display names separately', () => {
    const { normalizeArabicForMatch } = require('../media/safeNaming') as typeof import('../media/safeNaming');

    expect(normalizeArabicForMatch('أَحْمَد_الحلقة-الأولى')).toBe('احمد الحلقه الاولي');
  });

  it('generates path-safe slugs and resolves collisions deterministically', () => {
    const { generateSafeSlug, buildSafeNameMappings } = require('../media/safeNaming') as typeof import('../media/safeNaming');

    expect(generateSafeSlug('درس/خاص: 01؟')).toBe('درس-خاص-01');

    const mappings = buildSafeNameMappings([
      { entityId: 'a', originalName: 'درس' },
      { entityId: 'b', originalName: 'دَرْس' },
      { entityId: 'c', originalName: 'درس' },
    ]);

    expect(mappings.map(item => item.safeSlug)).toEqual(['درس', 'درس-2', 'درس-3']);
    expect(mappings.map(item => item.collisionIndex)).toEqual([0, 1, 2]);
  });

  it('rejects absolute import paths and resolves root-relative paths inside a root', () => {
    const { normalizeRootRelativePath, resolveRootRelativePath, SafeRootError } = require('../media/safeRoots') as typeof import('../media/safeRoots');

    expect(() => normalizeRootRelativePath('C:\\media\\Program')).toThrow(SafeRootError);
    expect(() => normalizeRootRelativePath('/srv/daawah/media/original-ar/Program')).toThrow(SafeRootError);
    expect(normalizeRootRelativePath('Programs\\Tafseer')).toBe('Programs/Tafseer');

    const rootPath = path.join(tempDir, 'media-root');
    const childPath = path.join(rootPath, 'Programs', 'Tafseer');
    fs.mkdirSync(childPath, { recursive: true });

    const resolved = resolveRootRelativePath({
      id: 'root-test',
      root_key: 'test',
      absolute_path: rootPath,
      is_readonly: true,
      is_original_library: true,
    }, 'Programs/Tafseer');

    expect(resolved.relativePath).toBe('Programs/Tafseer');
    expect(resolved.absolutePath).toBe(childPath);
  });

  it('creates protected default media roots in the schema', () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    initDb();
    closeDb = close;

    const db = getDb();
    const original = db.prepare('SELECT * FROM media_roots WHERE root_key=?').get('original-ar') as
      { absolute_path: string; is_readonly: number; is_original_library: number } | undefined;

    expect(original).toMatchObject({
      absolute_path: '/srv/daawah/media/original-ar',
      is_readonly: 1,
      is_original_library: 1,
    });
  });

  it('generates sequential program candidates from numbered indexed files', () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { generateProgramCandidatesFromIndexedFolders } = require('../media/registry') as typeof import('../media/registry');
    initDb();
    closeDb = close;
    const db = getDb();

    db.prepare(`
      INSERT INTO media_folders
        (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('folder-1', 'root-original-ar', 'Tafseer', 'برنامج التفسير', 'برنامج التفسير', 'برنامج-التفسير', 3, 'provisional');

    for (const number of [1, 2, 3]) {
      db.prepare(`
        INSERT INTO media_files
          (id, path, filename, type, status, root_id, folder_id, original_filename, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `file-${number}`,
        path.join(tempDir, `0${number}-episode.mp4`),
        `0${number}-episode.mp4`,
        'program',
        'pending',
        'root-original-ar',
        'folder-1',
        `0${number}-episode.mp4`,
        30 * 60_000
      );
    }

    const result = generateProgramCandidatesFromIndexedFolders({ persist: false });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      suggested_program_key: 'برنامج-التفسير',
      episode_count: 3,
      play_mode_suggestion: 'sequential',
      slot_mode_suggestion: 'fit',
    });
  });

  it('keeps monthly preview from mutating cursor state', () => {
    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { buildMonthlySchedulePreviewStub } = require('../schedule/monthlyPreview') as typeof import('../schedule/monthlyPreview');
    initDb();
    closeDb = close;
    const db = getDb();

    db.prepare('INSERT INTO cursors (key, value) VALUES (?, ?)').run('program:test', 'file-1');

    const result = buildMonthlySchedulePreviewStub();
    const cursorRows = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;

    expect(result.cursorMutation).toBe(false);
    expect(cursorRows).toBe(1);
  });
});
