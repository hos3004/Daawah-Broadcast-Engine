import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
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
