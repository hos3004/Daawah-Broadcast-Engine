import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export function initDb(): Database.Database {
  const dbPath = config.db.path;
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(dbPath);

  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('encoding = "UTF-8"');

  runMigrations(_db);
  logger.info(`Database initialized at ${dbPath}`);
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = (db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number | null }).v ?? 0;

  const migrations: Array<{ version: number; sql?: string; apply?: (db: Database.Database) => void }> = [
    { version: 1, sql: migration_001 },
    { version: 2, sql: migration_002 },
    { version: 3, apply: migration_003 },
    { version: 4, apply: migration_004 },
    { version: 5, apply: migration_005 },
    { version: 6, apply: migration_006 },
    { version: 7, apply: migration_007 },
  ];

  for (const m of migrations) {
    if (m.version > currentVersion) {
      const applyMigration = db.transaction(() => {
        if (m.sql) db.exec(m.sql);
        m.apply?.(db);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
      });
      applyMigration();
      logger.info(`Applied DB migration v${m.version}`);
    }
  }
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === columnName);
}

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinition: string
): void {
  if (!columnExists(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

const migration_001 = `
  -- Users & Auth
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','editor','operator','viewer')),
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Programs (shows)
  CREATE TABLE IF NOT EXISTS programs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_ar     TEXT,
    folder_path TEXT,
    play_mode   TEXT NOT NULL DEFAULT 'sequential' CHECK(play_mode IN ('sequential','shuffle','newest','round_robin')),
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Episodes
  CREATE TABLE IF NOT EXISTS episodes (
    id          TEXT PRIMARY KEY,
    program_id  TEXT NOT NULL REFERENCES programs(id),
    title       TEXT,
    episode_number INTEGER,
    media_file_id TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_program ON episodes(program_id);

  -- Media files
  CREATE TABLE IF NOT EXISTS media_files (
    id            TEXT PRIMARY KEY,
    path          TEXT NOT NULL UNIQUE,
    relative_path TEXT,
    filename      TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('program','filler','emergency','promo','quran','logo','other')),
    status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('ready','needs_transcode','missing','invalid','duplicate','unsupported','pending')),
    program_id    TEXT REFERENCES programs(id),
    duration_sec  REAL,
    file_size     INTEGER,
    modified_at   TEXT,
    width         INTEGER,
    height        INTEGER,
    fps           REAL,
    video_codec   TEXT,
    audio_codec   TEXT,
    pixel_format  TEXT,
    bitrate       INTEGER,
    audio_rate    INTEGER,
    content_hash  TEXT,
    scanned_at    TEXT,
    probe_error   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_media_files_type ON media_files(type);
  CREATE INDEX IF NOT EXISTS idx_media_files_status ON media_files(status);
  CREATE INDEX IF NOT EXISTS idx_media_files_program ON media_files(program_id);

  -- Schedules (3-month import)
  CREATE TABLE IF NOT EXISTS schedules (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    start_date  TEXT NOT NULL,
    end_date    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','validated','published','archived')),
    imported_by TEXT REFERENCES users(id),
    published_by TEXT REFERENCES users(id),
    published_at TEXT,
    validation_report TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Schedule items
  CREATE TABLE IF NOT EXISTS schedule_items (
    id              TEXT PRIMARY KEY,
    schedule_id     TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    date            TEXT NOT NULL,
    start_time      TEXT NOT NULL,
    end_time        TEXT,
    type            TEXT NOT NULL CHECK(type IN ('program','filler','quran','promo','emergency')),
    program_id      TEXT REFERENCES programs(id),
    episode_id      TEXT REFERENCES episodes(id),
    media_file_id   TEXT REFERENCES media_files(id),
    title           TEXT,
    expected_duration INTEGER,
    actual_duration INTEGER,
    duration_policy TEXT NOT NULL DEFAULT 'exact' CHECK(duration_policy IN ('exact','fit','allow_overrun','fill_gap')),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_schedule_items_schedule ON schedule_items(schedule_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_items_date ON schedule_items(date);

  -- Daily playlists (pre-materialized)
  CREATE TABLE IF NOT EXISTS daily_playlists (
    id          TEXT PRIMARY KEY,
    date        TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'building' CHECK(status IN ('building','ready','error','stale')),
    schedule_id TEXT REFERENCES schedules(id),
    built_at    TEXT,
    error_msg   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Playlist items (materialized timeline)
  CREATE TABLE IF NOT EXISTS playlist_items (
    id              TEXT PRIMARY KEY,
    playlist_id     TEXT NOT NULL REFERENCES daily_playlists(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    start_time_ms   INTEGER NOT NULL,
    end_time_ms     INTEGER NOT NULL,
    type            TEXT NOT NULL CHECK(type IN ('program','filler','quran','promo','emergency')),
    program_id      TEXT REFERENCES programs(id),
    media_file_id   TEXT NOT NULL REFERENCES media_files(id),
    title           TEXT,
    title_ar        TEXT,
    duration_ms     INTEGER NOT NULL,
    show_lower_third INTEGER NOT NULL DEFAULT 0,
    lower_third_path TEXT,
    is_emergency    INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_playlist_items_start ON playlist_items(start_time_ms);

  -- Overlay assets
  CREATE TABLE IF NOT EXISTS overlay_assets (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL CHECK(type IN ('logo','ticker','now_playing','other')),
    date        TEXT,
    playlist_item_id TEXT REFERENCES playlist_items(id),
    file_path   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','generating','ready','error')),
    error_msg   TEXT,
    generated_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Broadcast runs
  CREATE TABLE IF NOT EXISTS broadcast_runs (
    id          TEXT PRIMARY KEY,
    started_at  TEXT,
    stopped_at  TEXT,
    status      TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','starting','running','stopping','error','emergency')),
    pid         INTEGER,
    ffmpeg_cmd  TEXT,
    stop_reason TEXT,
    error_msg   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Broadcast events (per-item played log)
  CREATE TABLE IF NOT EXISTS broadcast_events (
    id              TEXT PRIMARY KEY,
    broadcast_run_id TEXT REFERENCES broadcast_runs(id),
    playlist_item_id TEXT REFERENCES playlist_items(id),
    media_path      TEXT,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    was_emergency   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Transcode jobs
  CREATE TABLE IF NOT EXISTS transcode_jobs (
    id          TEXT PRIMARY KEY,
    media_file_id TEXT NOT NULL REFERENCES media_files(id),
    status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','error','cancelled')),
    priority    INTEGER NOT NULL DEFAULT 5,
    ffmpeg_cmd  TEXT,
    output_path TEXT,
    progress    REAL DEFAULT 0,
    error_msg   TEXT,
    started_at  TEXT,
    finished_at TEXT,
    created_by  TEXT REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Audit logs
  CREATE TABLE IF NOT EXISTS audit_logs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id),
    user_email  TEXT,
    action      TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    detail      TEXT,
    ip_address  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

  -- App settings
  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by  TEXT REFERENCES users(id)
  );

  -- Scan errors
  CREATE TABLE IF NOT EXISTS scan_errors (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    error_msg   TEXT NOT NULL,
    scanned_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const migration_002 = `
  -- Add cursors table for episode sequencing
  CREATE TABLE IF NOT EXISTS cursors (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function migration_003(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bumper_cursor_state (
      id TEXT PRIMARY KEY,
      cursor_key TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      folder_key TEXT,
      last_media_file_id TEXT,
      last_played_path TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  addColumnIfMissing(db, 'playlist_items', 'source_role', 'source_role TEXT');
  addColumnIfMissing(db, 'playlist_items', 'is_trimmed', 'is_trimmed INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'playlist_items', 'trim_out_ms', 'trim_out_ms INTEGER');
  addColumnIfMissing(db, 'playlist_items', 'forced_duration_ms', 'forced_duration_ms INTEGER');
}

function migration_004(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_roots (
      id TEXT PRIMARY KEY,
      root_key TEXT NOT NULL UNIQUE,
      absolute_path TEXT NOT NULL,
      is_readonly INTEGER NOT NULL DEFAULT 1,
      is_original_library INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_folders (
      id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL REFERENCES media_roots(id),
      original_relative_path TEXT NOT NULL,
      display_name_ar TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      safe_slug TEXT NOT NULL,
      parent_folder_id TEXT REFERENCES media_folders(id),
      file_count INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER,
      longest_file_duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'provisional'
        CHECK(status IN ('provisional','indexed','missing','needs_review')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(root_id, original_relative_path)
    );

    CREATE TABLE IF NOT EXISTS safe_name_mappings (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      safe_slug TEXT NOT NULL,
      collision_group TEXT,
      collision_index INTEGER NOT NULL DEFAULT 0,
      approved_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(approved_status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS program_candidates (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES media_folders(id),
      suggested_program_key TEXT NOT NULL,
      display_name_ar TEXT NOT NULL,
      safe_slug TEXT NOT NULL,
      episode_count INTEGER NOT NULL DEFAULT 0,
      play_mode_suggestion TEXT NOT NULL
        CHECK(play_mode_suggestion IN ('sequential','shuffle','newest','round_robin')),
      slot_mode_suggestion TEXT NOT NULL
        CHECK(slot_mode_suggestion IN ('fit','playlist','file_count')),
      confidence_score REAL NOT NULL DEFAULT 0,
      needs_review INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_program_candidates_folder
      ON program_candidates(folder_id);
    CREATE INDEX IF NOT EXISTS idx_media_folders_root
      ON media_folders(root_id);
    CREATE INDEX IF NOT EXISTS idx_safe_name_mappings_slug
      ON safe_name_mappings(entity_type, safe_slug);
  `);

  addColumnIfMissing(db, 'media_files', 'root_id', 'root_id TEXT REFERENCES media_roots(id)');
  addColumnIfMissing(db, 'media_files', 'folder_id', 'folder_id TEXT REFERENCES media_folders(id)');
  addColumnIfMissing(db, 'media_files', 'original_relative_path', 'original_relative_path TEXT');
  addColumnIfMissing(db, 'media_files', 'original_filename', 'original_filename TEXT');
  addColumnIfMissing(db, 'media_files', 'display_title_ar', 'display_title_ar TEXT');
  addColumnIfMissing(db, 'media_files', 'normalized_title', 'normalized_title TEXT');
  addColumnIfMissing(db, 'media_files', 'safe_slug', 'safe_slug TEXT');
  addColumnIfMissing(db, 'media_files', 'extension', 'extension TEXT');
  addColumnIfMissing(db, 'media_files', 'size_bytes', 'size_bytes INTEGER');
  addColumnIfMissing(db, 'media_files', 'duration_ms', 'duration_ms INTEGER');
  addColumnIfMissing(db, 'media_files', 'qc_status', 'qc_status TEXT');
  addColumnIfMissing(db, 'media_files', 'updated_at', 'updated_at TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_files_registry_root ON media_files(root_id);
    CREATE INDEX IF NOT EXISTS idx_media_files_registry_folder ON media_files(folder_id);
    CREATE INDEX IF NOT EXISTS idx_media_files_safe_slug ON media_files(safe_slug);
  `);

  const stmt = db.prepare(`
    INSERT INTO media_roots
      (id, root_key, absolute_path, is_readonly, is_original_library)
    VALUES
      (@id, @root_key, @absolute_path, @is_readonly, @is_original_library)
    ON CONFLICT(root_key) DO UPDATE SET
      absolute_path=excluded.absolute_path,
      is_readonly=excluded.is_readonly,
      is_original_library=excluded.is_original_library,
      updated_at=datetime('now')
  `);

  stmt.run({
    id: 'root-original-ar',
    root_key: 'original-ar',
    absolute_path: '/srv/daawah/media/original-ar',
    is_readonly: 1,
    is_original_library: 1,
  });
  stmt.run({
    id: 'root-source',
    root_key: 'source',
    absolute_path: '/srv/daawah/media/source',
    is_readonly: 0,
    is_original_library: 0,
  });
  stmt.run({
    id: 'root-bumpers',
    root_key: 'bumpers',
    absolute_path: '/srv/daawah/media/bumpers',
    is_readonly: 0,
    is_original_library: 0,
  });
  stmt.run({
    id: 'root-emergency',
    root_key: 'emergency',
    absolute_path: '/srv/daawah/media/emergency',
    is_readonly: 0,
    is_original_library: 0,
  });
}

function migration_005(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_drafts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft')),
      is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active = 0),
      schedule_start_date TEXT NOT NULL,
      schedule_end_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      source_excel_filename TEXT NOT NULL,
      source_excel_sha256 TEXT NOT NULL,
      validation_status TEXT NOT NULL DEFAULT 'draft_valid'
        CHECK(validation_status IN ('draft_valid','draft_invalid')),
      validation_errors_json TEXT NOT NULL DEFAULT '[]',
      validation_summary_json TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      programs_json TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      folder_matches_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      schedule_preview_json TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_scheduler_drafts_created
      ON scheduler_drafts(created_at);
    CREATE INDEX IF NOT EXISTS idx_scheduler_drafts_range
      ON scheduler_drafts(schedule_start_date, schedule_end_date);
    CREATE INDEX IF NOT EXISTS idx_scheduler_drafts_status
      ON scheduler_drafts(status, is_active);
    CREATE INDEX IF NOT EXISTS idx_scheduler_drafts_validation_status
      ON scheduler_drafts(validation_status);
  `);
}

function migration_006(db: Database.Database): void {
  addColumnIfMissing(
    db,
    'scheduler_drafts',
    'validation_status',
    "validation_status TEXT NOT NULL DEFAULT 'draft_valid' CHECK(validation_status IN ('draft_valid','draft_invalid'))"
  );
  addColumnIfMissing(
    db,
    'scheduler_drafts',
    'validation_errors_json',
    "validation_errors_json TEXT NOT NULL DEFAULT '[]'"
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduler_drafts_validation_status
      ON scheduler_drafts(validation_status);
  `);
}

function migration_007(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_published_schedules (
      id TEXT PRIMARY KEY,
      source_draft_id TEXT NOT NULL REFERENCES scheduler_drafts(id),
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published'
        CHECK(status IN ('published')),
      is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active = 0),
      schedule_start_date TEXT NOT NULL,
      schedule_end_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      source_excel_filename TEXT NOT NULL,
      source_excel_sha256 TEXT NOT NULL,
      validation_status TEXT NOT NULL
        CHECK(validation_status IN ('draft_valid')),
      validation_errors_json TEXT NOT NULL DEFAULT '[]',
      validation_summary_json TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      programs_json TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      folder_matches_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      schedule_preview_json TEXT NOT NULL,
      published_by TEXT,
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_draft_id)
    );

    CREATE INDEX IF NOT EXISTS idx_scheduler_published_created
      ON scheduler_published_schedules(created_at);
    CREATE INDEX IF NOT EXISTS idx_scheduler_published_range
      ON scheduler_published_schedules(schedule_start_date, schedule_end_date);
    CREATE INDEX IF NOT EXISTS idx_scheduler_published_source_draft
      ON scheduler_published_schedules(source_draft_id);
    CREATE INDEX IF NOT EXISTS idx_scheduler_published_status
      ON scheduler_published_schedules(status, is_active);

    CREATE TRIGGER IF NOT EXISTS trg_scheduler_published_no_update
      BEFORE UPDATE ON scheduler_published_schedules
      BEGIN
        SELECT RAISE(ABORT, 'published schedule snapshots are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_scheduler_published_no_delete
      BEFORE DELETE ON scheduler_published_schedules
      BEGIN
        SELECT RAISE(ABORT, 'published schedule snapshots are immutable');
      END;
  `);
}
