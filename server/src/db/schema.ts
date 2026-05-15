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

  const migrations: Array<{ version: number; sql: string }> = [
    { version: 1, sql: migration_001 },
    { version: 2, sql: migration_002 },
  ];

  for (const m of migrations) {
    if (m.version > currentVersion) {
      const applyMigration = db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
      });
      applyMigration();
      logger.info(`Applied DB migration v${m.version}`);
    }
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
