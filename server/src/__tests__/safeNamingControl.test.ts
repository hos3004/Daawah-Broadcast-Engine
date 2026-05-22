import fs from 'fs';
import os from 'os';
import path from 'path';

function makeCsv(): string {
  return [
    'root,original_path,original_name,normalized_name,proposed_display_name,proposed_safe_slug,candidate_type,review_status,reason,collision_group,slug_collision',
    'source,/srv/daawah/media/source/برنامج اليوم.mp4,برنامج اليوم,برنامج اليوم,برنامج اليوم,program-today,media_file,ready,clean,,',
    'source,/srv/daawah/media/source/برنامج آخر.mp4,برنامج آخر,برنامج اخر,برنامج آخر,program-today,media_file,needs_review,collision,,slug-program-today',
  ].join('\n');
}

describe('safe naming control panel', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-safe-naming-control-'));
    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;
  });

  afterEach(() => {
    const { closeDb } = require('../db/schema') as typeof import('../db/schema');
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('returns safe naming display fields without mutating media files', () => {
    const { initDb, getDb } = require('../db/schema') as typeof import('../db/schema');
    const { getSafeNamingControlPanel } = require('../media/safeNamingControl') as typeof import('../media/safeNamingControl');
    initDb();
    const db = getDb();
    const sourceRoot = db.prepare('SELECT id FROM media_roots WHERE root_key=?').get('source') as { id: string };
    db.prepare(`
      INSERT INTO media_files
        (id, path, relative_path, filename, type, status, root_id, original_filename,
         display_title_ar, normalized_title, safe_slug, qc_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'media-1',
      '/srv/daawah/media/source/برنامج اليوم.mp4',
      'برنامج اليوم.mp4',
      'برنامج اليوم.mp4',
      'program',
      'ready',
      sourceRoot.id,
      'برنامج اليوم.mp4',
      'برنامج اليوم',
      'برنامج اليوم',
      'program-today',
      'passed'
    );

    const panel = getSafeNamingControlPanel();

    expect(panel.rows[0]).toMatchObject({
      originalArabicName: 'برنامج اليوم.mp4',
      originalPath: '/srv/daawah/media/source/برنامج اليوم.mp4',
      displayName: 'برنامج اليوم',
      normalizedName: 'برنامج اليوم',
      safeSlug: 'program-today',
      root: 'source',
      schedulingStatus: 'schedulable',
      archiveStatus: 'scheduling_root',
    });
    expect(panel.safety).toMatchObject({
      previewOnly: true,
      mediaRenameMoveDelete: false,
      mediaWrites: false,
      livePlayoutMutation: false,
    });
  });

  it('previews CSV imports, detects slug collisions, and keeps manual overrides as drafts', () => {
    const { previewSafeNamingImport } = require('../media/safeNamingControl') as typeof import('../media/safeNamingControl');
    const preview = previewSafeNamingImport({
      csvContent: makeCsv(),
      manualSlugOverrides: {
        '/srv/daawah/media/source/برنامج آخر.mp4': 'program-other-draft',
      },
    });

    expect(preview.mode).toBe('preview');
    expect(preview.entryCount).toBe(2);
    expect(preview.needsReview).toHaveLength(1);
    expect(preview.needsReview[0]?.manualSlugOverrideDraft).toBe('program-other-draft');
    expect(preview.slugCollisions).toHaveLength(0);
    expect(preview.safety.applyRequiresConfirmation).toBe('IMPORT SAFE NAMING');
  });

  it('rejects non-dry-run import without exact confirmation', () => {
    const { applySafeNamingImport } = require('../media/safeNamingControl') as typeof import('../media/safeNamingControl');
    expect(() => applySafeNamingImport({
      csvContent: makeCsv(),
      dryRun: false,
      confirmationText: 'WRONG',
    })).toThrow(/IMPORT SAFE NAMING/);
  });

  it('dry-run import reports intended writes without DB mutation', () => {
    const { initDb, getDb } = require('../db/schema') as typeof import('../db/schema');
    const { applySafeNamingImport } = require('../media/safeNamingControl') as typeof import('../media/safeNamingControl');
    initDb();
    const db = getDb();
    const result = applySafeNamingImport({
      csvContent: makeCsv(),
      dryRun: true,
      manualSlugOverrides: {
        '/srv/daawah/media/source/برنامج آخر.mp4': 'program-other-draft',
      },
    });
    const count = db.prepare('SELECT COUNT(*) as cnt FROM safe_name_mappings').get() as { cnt: number };

    expect(result.mode).toBe('dry_run');
    expect(result.safeNameMappingsWritten).toBe(2);
    expect(count.cnt).toBe(0);
  });
});
