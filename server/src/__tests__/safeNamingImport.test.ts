import fs from 'fs';
import os from 'os';
import path from 'path';

function makeSampleCsv(): string {
  return [
    'root,original_path,original_name,normalized_name,proposed_display_name,proposed_safe_slug,candidate_type,confidence,review_status,reason,collision_group,slug_collision',
    'source,/srv/daawah/media/source/برنامج اسمعني,برنامج اسمعني,برنامج اسمعني,برنامج اسمعني,برنامج-اسمعني,program,high,ready,clean name,,',
    'source,/srv/daawah/media/source/دراما حكم عقلك,دراما حكم عقلك,دراما حكم عقلك,دراما حكم عقلك,دراما-حكم-عقلك,program,high,ready,clean name,,',
    'original-ar,/srv/daawah/media/original-ar/قصة وخطوة,قصة وخطوة,قصة وخطوة,قصة وخطوة,قصة-وخطوة,needs_review,medium,needs_review,found in multiple roots,COL-001,',
    'source,/srv/daawah/media/source/قصة وخطوة,قصة وخطوة,قصة وخطوة,قصة وخطوة,قصة-وخطوة,needs_review,medium,needs_review,found in multiple roots,COL-001,',
    'bumpers,/srv/daawah/media/bumpers/general,general,general,general,general,bumper,high,ready,clean name,,',
    'original-ar,/srv/daawah/media/original-ar/سنن مهجورة مع د أكرم كساب,سنن مهجورة مع د أكرم كساب,سنن مهجورة مع د أكرم كساب,سنن مهجورة مع د أكرم كساب,سنن-مهجورة,original-library,high,ready,clean name,,SLUG-سنن-مهجورة',
    'source,/srv/daawah/media/source/سنن مهجورة,سنن مهجورة,سنن مهجورة,سنن مهجورة,سنن-مهجورة,program,high,ready,clean name,,SLUG-سنن-مهجورة',
  ].join('\n');
}

function makeCleanCsv(): string {
  return [
    'root,original_path,original_name,normalized_name,proposed_display_name,proposed_safe_slug,candidate_type,confidence,review_status,reason,collision_group,slug_collision',
    'source,/srv/daawah/media/source/برنامج اسمعني,برنامج اسمعني,برنامج اسمعني,برنامج اسمعني,برنامج-اسمعني,program,high,ready,clean name,,',
    'source,/srv/daawah/media/source/دراما حكم عقلك,دراما حكم عقلك,دراما حكم عقلك,دراما حكم عقلك,دراما-حكم-عقلك,program,high,ready,clean name,,',
    'bumpers,/srv/daawah/media/bumpers/general,general,general,general,general,bumper,high,ready,clean name,,',
    'original-ar,/srv/daawah/media/original-ar/سنن مهجورة مع د أكرم كساب,سنن مهجورة مع د أكرم كساب,سنن مهجورة مع د أكرم كساب,سنن مهجورة مع د أكرم كساب,سنن-مهجورة,original-library,high,ready,clean name,,',
  ].join('\n');
}

describe('safe naming import', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-safe-naming-import-'));
    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;
    process.env['SAFE_NAMING_IMPORT_DIR'] = tempDir;
  });

  afterEach(() => {
    closeDb?.();
    closeDb = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  describe('parseSafeNamingCsv', () => {
    it('parses a valid CSV with all columns', () => {
      const { parseSafeNamingCsv } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const csv = makeSampleCsv();
      const entries = parseSafeNamingCsv(csv);

      expect(entries).toHaveLength(7);
      expect(entries[0]).toMatchObject({
        root: 'source',
        originalName: 'برنامج اسمعني',
        proposedSafeSlug: 'برنامج-اسمعني',
        candidateType: 'program',
        reviewStatus: 'ready',
      });
    });

    it('handles empty CSV gracefully', () => {
      const { parseSafeNamingCsv } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const entries = parseSafeNamingCsv('root,original_path,original_name\n');
      expect(entries).toHaveLength(0);
    });
  });

  describe('analyzeImportPlan', () => {
    it('computes correct summary statistics from parsed entries', () => {
      const { parseSafeNamingCsv, analyzeImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const entries = parseSafeNamingCsv(makeSampleCsv());
      const preview = analyzeImportPlan(entries);

      expect(preview.mode).toBe('preview');
      expect(preview.entryCount).toBe(7);
      expect(preview.readyCount).toBe(5);
      expect(preview.needsReviewCount).toBe(2);
      expect(preview.byRoot).toEqual(
        expect.arrayContaining([
          { root: 'source', count: 4 },
          { root: 'original-ar', count: 2 },
          { root: 'bumpers', count: 1 },
        ])
      );
      expect(preview.collisionGroups).toHaveLength(1);
      expect(preview.collisionGroups[0]).toMatchObject({ group: 'COL-001', entries: 2 });
      expect(preview.slugCollisions).toHaveLength(1);
      expect(preview.slugCollisions[0]).toMatchObject({ slug: 'SLUG-سنن-مهجورة', entries: 2 });
      expect(preview.programCandidateCount).toBeGreaterThan(0);
    });
  });

  describe('previewImportPlan', () => {
    it('reads and previews from CSV string content', () => {
      const { previewImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const preview = previewImportPlan({ csvContent: makeCleanCsv() });

      expect(preview.mode).toBe('preview');
      expect(preview.entryCount).toBe(4);
    });

    it('reads and previews from a CSV file path', () => {
      const { previewImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const csvPath = path.join(tempDir, 'test-import.csv');
      fs.writeFileSync(csvPath, makeCleanCsv(), 'utf8');

      const preview = previewImportPlan({ csvPath });
      expect(preview.entryCount).toBe(4);
    });
  });

  describe('APPLY_CONFIRMATION_TEXT', () => {
    it('is the expected constant', () => {
      const { APPLY_CONFIRMATION_TEXT } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      expect(APPLY_CONFIRMATION_TEXT).toBe('IMPORT SAFE NAMING');
    });
  });

  describe('applyImportPlan — confirmation guard', () => {
    it('returns dry-run result without writing to DB (no confirmation needed for dry-run)', () => {
      const { initDb } = require('../db/schema') as typeof import('../db/schema');
      const { applyImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      initDb();

      const result = applyImportPlan({
        csvContent: makeCleanCsv(),
        dryRun: true,
        importReadyOnly: true,
      });

      expect(result.mode).toBe('dry_run');
      expect(result.safeNameMappingsWritten).toBeGreaterThan(0);
      expect(result.programCandidatesWritten).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
      expect(result.timestamp).toEqual(expect.any(String));
    });

    it('rejects apply without confirmation text', () => {
      const { initDb } = require('../db/schema') as typeof import('../db/schema');
      const { applyImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      initDb();

      expect(() => {
        applyImportPlan({
          csvContent: makeCleanCsv(),
          dryRun: false,
          importReadyOnly: true,
          confirmationText: '',
        });
      }).toThrow(/Confirmation text mismatch/);
    });

    it('rejects apply with wrong confirmation text', () => {
      const { initDb } = require('../db/schema') as typeof import('../db/schema');
      const { applyImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      initDb();

      expect(() => {
        applyImportPlan({
          csvContent: makeCleanCsv(),
          dryRun: false,
          importReadyOnly: true,
          confirmationText: 'WRONG TEXT',
        });
      }).toThrow(/Confirmation text mismatch/);
    });

    it('rejects apply with correct confirmation but unresolved slug collisions', () => {
      const { initDb } = require('../db/schema') as typeof import('../db/schema');
      const { applyImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      initDb();

      expect(() => {
        applyImportPlan({
          csvContent: makeSampleCsv(),
          dryRun: false,
          importReadyOnly: true,
          confirmationText: 'IMPORT SAFE NAMING',
        });
      }).toThrow(/unresolved slug collisions/);
    });

    it('rejects apply when needs_review entries exist with importReadyOnly=true', () => {
      const { initDb } = require('../db/schema') as typeof import('../db/schema');
      const { applyImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      initDb();

      expect(() => {
        applyImportPlan({
          csvContent: makeSampleCsv(),
          dryRun: false,
          importReadyOnly: true,
          confirmationText: 'IMPORT SAFE NAMING',
        });
      }).toThrow(/unresolved slug collisions/);
    });
  });

  describe('applyImportPlan — applied writes', () => {
    it('applies ready-only entries to safe_name_mappings and program_candidates with confirmation', () => {
      const { initDb, getDb } = require('../db/schema') as typeof import('../db/schema');
      const { applyImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const { v4: uuidv4 } = require('uuid');
      initDb();
      const db = getDb();

      const root = db.prepare('SELECT id FROM media_roots WHERE root_key=?').get('source') as { id: string };
      db.prepare(`INSERT INTO media_folders (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'provisional')
        ON CONFLICT(root_id, original_relative_path) DO NOTHING`).run(
        uuidv4(), root.id, 'برنامج اسمعني', 'برنامج اسمعني', 'برنامج اسمعني', 'برنامج-اسمعني'
      );
      db.prepare(`INSERT INTO media_folders (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'provisional')
        ON CONFLICT(root_id, original_relative_path) DO NOTHING`).run(
        uuidv4(), root.id, 'دراما حكم عقلك', 'دراما حكم عقلك', 'دراما حكم عقلك', 'دراما-حكم-عقلك'
      );
      const bumperRoot = db.prepare('SELECT id FROM media_roots WHERE root_key=?').get('bumpers') as { id: string };
      db.prepare(`INSERT INTO media_folders (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'provisional')
        ON CONFLICT(root_id, original_relative_path) DO NOTHING`).run(
        uuidv4(), bumperRoot.id, 'general', 'general', 'general', 'general'
      );

      const csvPath = path.join(tempDir, 'clean-import.csv');
      fs.writeFileSync(csvPath, makeCleanCsv(), 'utf8');

      const result = applyImportPlan({
        csvPath,
        dryRun: false,
        importReadyOnly: true,
        confirmationText: 'IMPORT SAFE NAMING',
      });

      expect(result.mode).toBe('applied');
      expect(result.safeNameMappingsWritten).toBe(4);
      expect(result.errors).toEqual([]);

      const mappings = db.prepare('SELECT COUNT(*) as cnt FROM safe_name_mappings').get() as { cnt: number };
      expect(mappings.cnt).toBe(4);

      const approved = db.prepare("SELECT COUNT(*) as cnt FROM safe_name_mappings WHERE approved_status='approved'").get() as { cnt: number };
      expect(approved.cnt).toBe(4);
    });

    it('preserves original_path as entity_id exactly', () => {
      const { initDb, getDb } = require('../db/schema') as typeof import('../db/schema');
      const { applyImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      initDb();
      const db = getDb();

      const csvPath = path.join(tempDir, 'clean-import.csv');
      fs.writeFileSync(csvPath, makeCleanCsv(), 'utf8');

      applyImportPlan({
        csvPath,
        dryRun: false,
        importReadyOnly: true,
        confirmationText: 'IMPORT SAFE NAMING',
      });

      const rows = db.prepare('SELECT entity_id, original_name FROM safe_name_mappings').all() as { entity_id: string; original_name: string }[];
      expect(rows).toHaveLength(4);

      const sourceEntry = rows.find(r => r.original_name === 'برنامج اسمعني');
      expect(sourceEntry).toBeDefined();
      expect(sourceEntry!.entity_id).toBe('/srv/daawah/media/source/برنامج اسمعني');
    });

    it('does not write needs_review entries to scheduling candidates', () => {
      const { initDb, getDb } = require('../db/schema') as typeof import('../db/schema');
      const { applyImportPlan } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const { v4: uuidv4 } = require('uuid');
      initDb();
      const db = getDb();

      const root = db.prepare('SELECT id FROM media_roots WHERE root_key=?').get('source') as { id: string };
      db.prepare(`INSERT INTO media_folders (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'provisional')
        ON CONFLICT(root_id, original_relative_path) DO NOTHING`).run(
        uuidv4(), root.id, 'برنامج اسمعني', 'برنامج اسمعني', 'برنامج اسمعني', 'برنامج-اسمعني'
      );
      db.prepare(`INSERT INTO media_folders (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'provisional')
        ON CONFLICT(root_id, original_relative_path) DO NOTHING`).run(
        uuidv4(), root.id, 'دراما حكم عقلك', 'دراما حكم عقلك', 'دراما حكم عقلك', 'دراما-حكم-عقلك'
      );
      const bumperRoot = db.prepare('SELECT id FROM media_roots WHERE root_key=?').get('bumpers') as { id: string };
      db.prepare(`INSERT INTO media_folders (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'provisional')
        ON CONFLICT(root_id, original_relative_path) DO NOTHING`).run(
        uuidv4(), bumperRoot.id, 'general', 'general', 'general', 'general'
      );

      db.prepare(`INSERT INTO media_folders (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'provisional')
        ON CONFLICT(root_id, original_relative_path) DO NOTHING`).run(
        uuidv4(), root.id, 'بحاجة مراجعة', 'بحاجة مراجعة', 'بحاجة مراجعة', 'بحاجة-مراجعة'
      );

      const csvPath = path.join(tempDir, 'clean-with-review.csv');
      const csv = makeCleanCsv() + '\n' +
        'source,/srv/daawah/media/source/بحاجة مراجعة,بحاجة مراجعة,بحاجة مراجعة,بحاجة مراجعة,بحاجة-مراجعة,needs_review,medium,needs_review,unusual chars,,';
      fs.writeFileSync(csvPath, csv, 'utf8');

      const result = applyImportPlan({
        csvPath,
        dryRun: false,
        importReadyOnly: false,
        confirmationText: 'IMPORT SAFE NAMING',
      });

      const mappings = db.prepare('SELECT COUNT(*) as cnt FROM safe_name_mappings').get() as { cnt: number };
      expect(mappings.cnt).toBe(5);

      const needsReviewMapping = db.prepare(
        "SELECT COUNT(*) as cnt FROM safe_name_mappings WHERE approved_status='pending'"
      ).get() as { cnt: number };
      expect(needsReviewMapping.cnt).toBe(1);

      expect(result.safeNameMappingsWritten).toBe(5);
      expect(result.programCandidatesWritten).toBe(3);

      const reviewCandidates = db.prepare(
        "SELECT COUNT(*) as cnt FROM program_candidates WHERE needs_review=1"
      ).get() as { cnt: number };
      expect(reviewCandidates.cnt).toBe(1);
    });
  });

  describe('readCsvFromFile', () => {
    it('reads CSV content from a file path', () => {
      const { readCsvFromFile } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const csvPath = path.join(tempDir, 'sample.csv');
      fs.writeFileSync(csvPath, 'a,b,c\n1,2,3', 'utf8');

      const content = readCsvFromFile(csvPath);
      expect(content).toBe('a,b,c\n1,2,3');
    });

    it('throws when file does not exist', () => {
      const { readCsvFromFile } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      expect(() => readCsvFromFile('/nonexistent/path.csv')).toThrow(/CSV file not found/);
    });
  });

  describe('findLatestImportCsv', () => {
    it('returns null when directory does not exist', () => {
      const { findLatestImportCsv } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      const result = findLatestImportCsv('/nonexistent');
      expect(result).toBeNull();
    });

    it('finds the latest safe-name-db-import-plan CSV in a directory', () => {
      const { findLatestImportCsv } = require('../media/safeNamingImport') as typeof import('../media/safeNamingImport');
      fs.writeFileSync(path.join(tempDir, 'safe-name-db-import-plan-20260520.csv'), 'a', 'utf8');
      fs.writeFileSync(path.join(tempDir, 'safe-name-db-import-plan-20260522.csv'), 'b', 'utf8');

      const result = findLatestImportCsv(tempDir);
      expect(result).toBe(path.join(tempDir, 'safe-name-db-import-plan-20260522.csv'));
    });
  });
});
