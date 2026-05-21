import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import * as XLSX from 'xlsx';

describe('scheduler foundation routes', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;
  let server: http.Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    jest.resetModules();
    process.env = { ...originalEnv };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-scheduler-route-'));
    process.env['NODE_ENV'] = 'test';
    process.env['DB_PATH'] = path.join(tempDir, 'test.db');
    process.env['DATA_PATH'] = tempDir;

    const { initDb, getDb, closeDb: close } = require('../db/schema') as typeof import('../db/schema');
    const { schedulerFoundationRouter } = require('../api/routes/schedulerFoundation') as typeof import('../api/routes/schedulerFoundation');
    initDb();
    closeDb = close;
    const db = getDb();

    db.prepare(`
      INSERT INTO media_folders
        (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug, file_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('folder-1', 'root-original-ar', 'Tafseer/Season 01', 'برنامج التفسير', 'season 01', 'tafseer-season-01', 12, 'provisional');

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: 'user-1', email: 'test@example.com', role: 'admin' };
      next();
    });
    app.use('/api/scheduler-foundation', schedulerFoundationRouter);
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    closeDb?.();
    closeDb = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('serves the fixed Excel template without accepting arbitrary paths', async () => {
    const response = await fetch(`${baseUrl}/api/scheduler-foundation/excel-template`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('scheduler_excel_import_template.xlsx');
  });

  it('keeps media registry scan preview disabled by default', async () => {
    const response = await fetch(`${baseUrl}/api/scheduler-foundation/media-registry/scan-preview`, {
      method: 'POST',
    });
    const body = await response.json() as { code: string; error: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe('MEDIA_SCAN_PREVIEW_DISABLED');
    expect(body.error).toContain('ENABLE_MEDIA_SCAN_PREVIEW=true');
  });

  it('accepts an XLSX upload preview without activating schedules or updating cursors', async () => {
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const db = getDb();
    db.prepare('INSERT INTO cursors (key, value) VALUES (?, ?)').run('program:test', 'file-1');

    const form = new FormData();
    form.append(
      'file',
      new Blob([makeWorkbookBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'schedule.xlsx'
    );

    const response = await fetch(`${baseUrl}/api/scheduler-foundation/excel-import/preview`, {
      method: 'POST',
      body: form,
    });
    const body = await response.json() as {
      willActivateSchedule: boolean;
      willUpdateCursors: boolean;
      willMaterializePlaylist: boolean;
      summary: { matchedPrograms: number; programCount: number; slotCount: number };
      folderMatches: Array<{ status: string }>;
      schedulePreview: { days: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.willActivateSchedule).toBe(false);
    expect(body.willUpdateCursors).toBe(false);
    expect(body.willMaterializePlaylist).toBe(false);
    expect(body.summary).toMatchObject({ matchedPrograms: 1, programCount: 1, slotCount: 1 });
    expect(body.folderMatches[0]?.status).toBe('matched');
    expect(body.schedulePreview.days.length).toBeGreaterThan(0);

    const scheduleCount = (db.prepare('SELECT COUNT(*) as cnt FROM schedules').get() as { cnt: number }).cnt;
    const cursorCount = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
    expect(scheduleCount).toBe(0);
    expect(cursorCount).toBe(1);
  });

  it('saves, lists, and reads an inactive draft from a validated Excel preview without publishing', async () => {
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const db = getDb();
    db.prepare('INSERT INTO cursors (key, value) VALUES (?, ?)').run('program:test', 'file-1');

    const workbook = makeWorkbookBuffer();
    const form = new FormData();
    form.append(
      'file',
      new Blob([workbook], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'schedule.xlsx'
    );

    const previewResponse = await fetch(`${baseUrl}/api/scheduler-foundation/excel-import/preview`, {
      method: 'POST',
      body: form,
    });
    const preview = await previewResponse.json() as {
      summary: { errors: number };
      [key: string]: unknown;
    };
    expect(previewResponse.status).toBe(200);
    expect(preview.summary.errors).toBe(0);

    const saveResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Safe draft',
        sourceExcel: {
          filename: 'schedule.xlsx',
          sha256: sha256(workbook),
        },
        preview,
      }),
    });
    const saved = await saveResponse.json() as {
      draft: {
        id: string;
        name: string;
        status: string;
        isActive: boolean;
        sourceExcelSha256: string;
        programCount: number;
        slotCount: number;
        willActivateSchedule: boolean;
        willUpdateCursors: boolean;
        willMaterializePlaylist: boolean;
      };
    };

    expect(saveResponse.status).toBe(201);
    expect(saved.draft).toMatchObject({
      name: 'Safe draft',
      status: 'draft',
      isActive: false,
      programCount: 1,
      slotCount: 1,
      willActivateSchedule: false,
      willUpdateCursors: false,
      willMaterializePlaylist: false,
    });

    const listResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`);
    const list = await listResponse.json() as { drafts: Array<{ id: string; isActive: boolean }> };
    expect(listResponse.status).toBe(200);
    expect(list.drafts).toHaveLength(1);
    expect(list.drafts[0]?.isActive).toBe(false);

    const readResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules/${saved.draft.id}`);
    const read = await readResponse.json() as { draft: { slots: unknown[]; schedulePreview: { days: unknown[] } } };
    expect(readResponse.status).toBe(200);
    expect(read.draft.slots).toHaveLength(1);
    expect(read.draft.schedulePreview.days.length).toBeGreaterThan(0);

    const scheduleCount = (db.prepare('SELECT COUNT(*) as cnt FROM schedules').get() as { cnt: number }).cnt;
    const scheduleItemCount = (db.prepare('SELECT COUNT(*) as cnt FROM schedule_items').get() as { cnt: number }).cnt;
    const playlistCount = (db.prepare('SELECT COUNT(*) as cnt FROM daily_playlists').get() as { cnt: number }).cnt;
    const cursorCount = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
    const draftCount = (db.prepare('SELECT COUNT(*) as cnt FROM scheduler_drafts').get() as { cnt: number }).cnt;
    expect(scheduleCount).toBe(0);
    expect(scheduleItemCount).toBe(0);
    expect(playlistCount).toBe(0);
    expect(cursorCount).toBe(1);
    expect(draftCount).toBe(1);
  });

  it('rejects draft save when the preview has validation errors', async () => {
    const response = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad draft',
        sourceExcel: {
          filename: 'bad.xlsx',
          sha256: 'a'.repeat(64),
        },
        preview: {
          mode: 'preview',
          settings: {
            timezone: 'Europe/Istanbul',
            schedule_start_date: '2026-06-06',
            schedule_end_date: '2026-06-06',
          },
          programs: [{ program_key: 'bad' }],
          slots: [{ program_key: 'bad' }],
          folderMatches: [],
          issues: [{ severity: 'error', code: 'TEST_ERROR', sheet: 'Programs', message: 'bad' }],
          summary: { errors: 1, warnings: 0, programCount: 1, slotCount: 1 },
          schedulePreview: { timezone: 'Europe/Istanbul', gapPattern: 'main', truncated: false, days: [] },
          willActivateSchedule: false,
          willUpdateCursors: false,
          willMaterializePlaylist: false,
          productionSafety: {
            previewOnly: true,
            cursorUpdates: false,
            playlistMaterialization: false,
            ffmpeg: false,
            scheduleActivation: false,
          },
        },
      }),
    });
    const body = await response.json() as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('PREVIEW_HAS_ERRORS');
  });
});

function makeWorkbookBuffer(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
    timezone: 'Europe/Istanbul',
    schedule_start_date: '2026-06-06',
    schedule_end_date: '2026-06-06',
    default_duration_policy: 'fit',
    default_repeat_policy: 'same_day_same_episode',
    default_gap_policy: 'professional_gap_filler',
  }]), 'Settings');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
    program_key: 'tafseer',
    program_name: 'برنامج التفسير',
    folder_hint: 'Tafseer/Season 01',
    folder_root: 'original-ar',
    play_mode: 'sequential',
    slot_mode: 'fit',
    repeat_policy: 'same_day_same_episode',
    enabled: 'true',
  }]), 'Programs');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
    program_key: 'tafseer',
    days: 'sat',
    start_time: '08:00',
    end_time: '09:00',
    priority: '10',
  }]), 'Slots');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function listen(app: express.Express): Promise<http.Server> {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}
