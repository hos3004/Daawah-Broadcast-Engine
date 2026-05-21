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
    process.env['PLAYLIST_MATERIALIZATION_PROJECT_ROOT'] = tempDir;
    process.env['TEST_PLAYOUT_PROJECT_ROOT'] = tempDir;

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
      const role = (req.header('x-test-role') ?? 'admin') as 'admin' | 'editor' | 'operator';
      req.user = { id: 'user-1', email: 'test@example.com', role };
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
        validationStatus: string;
        validationErrors: unknown[];
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
      validationStatus: 'draft_valid',
      validationErrors: [],
      programCount: 1,
      slotCount: 1,
      willActivateSchedule: false,
      willUpdateCursors: false,
      willMaterializePlaylist: false,
    });

    const listResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`);
    const list = await listResponse.json() as { drafts: Array<{ id: string; isActive: boolean; validationStatus: string }> };
    expect(listResponse.status).toBe(200);
    expect(list.drafts).toHaveLength(1);
    expect(list.drafts[0]?.isActive).toBe(false);
    expect(list.drafts[0]?.validationStatus).toBe('draft_valid');

    const readResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules/${saved.draft.id}`);
    const read = await readResponse.json() as { draft: { validationStatus: string; validationErrors: unknown[]; slots: unknown[]; schedulePreview: { days: unknown[] } } };
    expect(readResponse.status).toBe(200);
    expect(read.draft.validationStatus).toBe('draft_valid');
    expect(read.draft.validationErrors).toEqual([]);
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

  it('publishes a valid draft as an inactive immutable schedule snapshot only', async () => {
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const db = getDb();
    db.prepare('INSERT INTO cursors (key, value) VALUES (?, ?)').run('program:test', 'file-1');

    const workbook = makeWorkbookBuffer();
    const preview = await previewWorkbook(baseUrl, workbook);
    const saveResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Publishable draft',
        sourceExcel: {
          filename: 'publishable.xlsx',
          sha256: sha256(workbook),
        },
        preview,
      }),
    });
    const saved = await saveResponse.json() as {
      draft: {
        id: string;
        validationStatus: string;
        validationErrors: unknown[];
      };
    };
    expect(saveResponse.status).toBe(201);
    expect(saved.draft.validationStatus).toBe('draft_valid');
    expect(saved.draft.validationErrors).toEqual([]);

    const cursorCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
    const publishResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules/${saved.draft.id}/publish`, {
      method: 'POST',
    });
    const published = await publishResponse.json() as {
      safety: {
        scheduleActivation: boolean;
        cursorUpdates: boolean;
        playlistMaterialization: boolean;
        ffmpeg: boolean;
        playout: boolean;
        broadcast: boolean;
      };
      publishedSchedule: {
        id: string;
        sourceDraftId: string;
        name: string;
        status: string;
        isActive: boolean;
        validationStatus: string;
        validationErrors: unknown[];
        programCount: number;
        slotCount: number;
        publishedBy: string | null;
        publishedAt: string;
        willActivateSchedule: boolean;
        willUpdateCursors: boolean;
        willMaterializePlaylist: boolean;
      };
    };

    expect(publishResponse.status).toBe(201);
    expect(published.publishedSchedule).toMatchObject({
      sourceDraftId: saved.draft.id,
      name: 'Publishable draft',
      status: 'published',
      isActive: false,
      validationStatus: 'draft_valid',
      validationErrors: [],
      programCount: 1,
      slotCount: 1,
      publishedBy: 'user-1',
      willActivateSchedule: false,
      willUpdateCursors: false,
      willMaterializePlaylist: false,
    });
    expect(published.publishedSchedule.publishedAt).toEqual(expect.any(String));
    expect(published.safety).toMatchObject({
      scheduleActivation: false,
      cursorUpdates: false,
      playlistMaterialization: false,
      ffmpeg: false,
      playout: false,
      broadcast: false,
    });

    const listResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules`);
    const list = await listResponse.json() as {
      publishedSchedules: Array<{ id: string; sourceDraftId: string; isActive: boolean; status: string }>;
    };
    expect(listResponse.status).toBe(200);
    expect(list.publishedSchedules).toHaveLength(1);
    expect(list.publishedSchedules[0]).toMatchObject({
      id: published.publishedSchedule.id,
      sourceDraftId: saved.draft.id,
      isActive: false,
      status: 'published',
    });

    const readResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules/${published.publishedSchedule.id}`);
    const read = await readResponse.json() as { publishedSchedule: { slots: unknown[]; schedulePreview: { days: unknown[] } } };
    expect(readResponse.status).toBe(200);
    expect(read.publishedSchedule.slots).toHaveLength(1);
    expect(read.publishedSchedule.schedulePreview.days.length).toBeGreaterThan(0);

    const duplicateResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules/${saved.draft.id}/publish`, {
      method: 'POST',
    });
    const duplicate = await duplicateResponse.json() as { code: string };
    expect(duplicateResponse.status).toBe(400);
    expect(duplicate.code).toBe('DRAFT_ALREADY_PUBLISHED');

    expect(() => db.prepare('UPDATE scheduler_published_schedules SET name=? WHERE id=?').run('Changed', published.publishedSchedule.id))
      .toThrow(/immutable/);

    const scheduleCount = (db.prepare('SELECT COUNT(*) as cnt FROM schedules').get() as { cnt: number }).cnt;
    const scheduleItemCount = (db.prepare('SELECT COUNT(*) as cnt FROM schedule_items').get() as { cnt: number }).cnt;
    const playlistCount = (db.prepare('SELECT COUNT(*) as cnt FROM daily_playlists').get() as { cnt: number }).cnt;
    const cursorCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
    const publishedCount = (db.prepare('SELECT COUNT(*) as cnt FROM scheduler_published_schedules').get() as { cnt: number }).cnt;
    const auditCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_logs WHERE action='scheduler_foundation.publish_schedule'").get() as { cnt: number }).cnt;
    expect(scheduleCount).toBe(0);
    expect(scheduleItemCount).toBe(0);
    expect(playlistCount).toBe(0);
    expect(cursorCountAfter).toBe(cursorCountBefore);
    expect(publishedCount).toBe(1);
    expect(auditCount).toBe(1);
  });

  it('activates a published schedule with double confirmation without materializing playlists or mutating cursors', async () => {
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const db = getDb();
    db.prepare('INSERT INTO cursors (key, value) VALUES (?, ?)').run('program:test', 'file-1');

    const first = await saveAndPublishValidDraft(baseUrl, 'First published schedule', 'first.xlsx');
    const second = await saveAndPublishValidDraft(baseUrl, 'Second published schedule', 'second.xlsx');
    const cursorCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;

    const editorResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules/${first.publishedId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'editor' },
      body: JSON.stringify({
        scheduleId: first.publishedId,
        confirmActivation: true,
        confirmationText: `ACTIVATE SCHEDULE ${first.publishedId}`,
      }),
    });
    expect(editorResponse.status).toBe(403);

    const rejectedResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules/${first.publishedId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleId: first.publishedId,
        confirmActivation: true,
        confirmationText: 'activate please',
      }),
    });
    const rejected = await rejectedResponse.json() as { code: string };
    expect(rejectedResponse.status).toBe(400);
    expect(rejected.code).toBe('ACTIVATION_TEXT_MISMATCH');

    const activateFirstResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules/${first.publishedId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleId: first.publishedId,
        confirmActivation: true,
        confirmationText: `ACTIVATE SCHEDULE ${first.publishedId}`,
      }),
    });
    const activatedFirst = await activateFirstResponse.json() as {
      activeSchedule: { id: string; isActive: boolean };
      previousPublishedScheduleId: string | null;
      safety: {
        scheduleActivation: boolean;
        cursorUpdates: boolean;
        playlistMaterialization: boolean;
        ffmpeg: boolean;
        playout: boolean;
        broadcast: boolean;
      };
    };

    expect(activateFirstResponse.status).toBe(200);
    expect(activatedFirst.activeSchedule).toMatchObject({ id: first.publishedId, isActive: true });
    expect(activatedFirst.previousPublishedScheduleId).toBeNull();
    expect(activatedFirst.safety).toMatchObject({
      scheduleActivation: true,
      cursorUpdates: false,
      playlistMaterialization: false,
      ffmpeg: false,
      playout: false,
      broadcast: false,
    });

    const alreadyActiveResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules/${first.publishedId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleId: first.publishedId,
        confirmActivation: true,
        confirmationText: `ACTIVATE SCHEDULE ${first.publishedId}`,
      }),
    });
    const alreadyActive = await alreadyActiveResponse.json() as { code: string };
    expect(alreadyActiveResponse.status).toBe(409);
    expect(alreadyActive.code).toBe('ALREADY_ACTIVE');

    const activateSecondResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules/${second.publishedId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleId: second.publishedId,
        confirmActivation: true,
        confirmationText: `ACTIVATE SCHEDULE ${second.publishedId}`,
      }),
    });
    const activatedSecond = await activateSecondResponse.json() as {
      activeSchedule: { id: string; isActive: boolean };
      previousPublishedScheduleId: string | null;
      activeState: { publishedScheduleId: string; previousPublishedScheduleId: string | null };
    };

    expect(activateSecondResponse.status).toBe(200);
    expect(activatedSecond.activeSchedule).toMatchObject({ id: second.publishedId, isActive: true });
    expect(activatedSecond.previousPublishedScheduleId).toBe(first.publishedId);
    expect(activatedSecond.activeState).toMatchObject({
      publishedScheduleId: second.publishedId,
      previousPublishedScheduleId: first.publishedId,
    });

    const listResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules`);
    const list = await listResponse.json() as { publishedSchedules: Array<{ id: string; isActive: boolean }> };
    expect(listResponse.status).toBe(200);
    expect(list.publishedSchedules.find(schedule => schedule.id === first.publishedId)?.isActive).toBe(false);
    expect(list.publishedSchedules.find(schedule => schedule.id === second.publishedId)?.isActive).toBe(true);

    const readSecondResponse = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules/${second.publishedId}`);
    const readSecond = await readSecondResponse.json() as { publishedSchedule: { id: string; isActive: boolean } };
    expect(readSecondResponse.status).toBe(200);
    expect(readSecond.publishedSchedule).toMatchObject({ id: second.publishedId, isActive: true });

    const activeStateCount = (db.prepare('SELECT COUNT(*) as cnt FROM scheduler_active_schedule_state').get() as { cnt: number }).cnt;
    const activeState = db.prepare("SELECT * FROM scheduler_active_schedule_state WHERE id='active'").get() as {
      published_schedule_id: string;
      previous_published_schedule_id: string | null;
    };
    const publishedActiveSum = (db.prepare('SELECT COALESCE(SUM(is_active), 0) as cnt FROM scheduler_published_schedules').get() as { cnt: number }).cnt;
    const scheduleCount = (db.prepare('SELECT COUNT(*) as cnt FROM schedules').get() as { cnt: number }).cnt;
    const scheduleItemCount = (db.prepare('SELECT COUNT(*) as cnt FROM schedule_items').get() as { cnt: number }).cnt;
    const playlistCount = (db.prepare('SELECT COUNT(*) as cnt FROM daily_playlists').get() as { cnt: number }).cnt;
    const cursorCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
    const activationAuditCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_logs WHERE action='scheduler_foundation.activate_schedule'").get() as { cnt: number }).cnt;
    expect(activeStateCount).toBe(1);
    expect(activeState.published_schedule_id).toBe(second.publishedId);
    expect(activeState.previous_published_schedule_id).toBe(first.publishedId);
    expect(publishedActiveSum).toBe(0);
    expect(scheduleCount).toBe(0);
    expect(scheduleItemCount).toBe(0);
    expect(playlistCount).toBe(0);
    expect(cursorCountAfter).toBe(cursorCountBefore);
    expect(activationAuditCount).toBe(2);
  });

  it('returns safe active schedule status when no active schedule exists', async () => {
    const response = await fetch(`${baseUrl}/api/scheduler-foundation/active-schedule`);
    const body = await response.json() as {
      activeSchedule: unknown;
      activeState: unknown;
      safety: {
        cursorUpdates: boolean;
        playlistMaterialization: boolean;
        ffmpeg: boolean;
        ffprobe: boolean;
        playout: boolean;
        broadcast: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(body.activeSchedule).toBeNull();
    expect(body.activeState).toBeNull();
    expect(body.safety).toMatchObject({
      cursorUpdates: false,
      playlistMaterialization: false,
      ffmpeg: false,
      ffprobe: false,
      playout: false,
      broadcast: false,
    });
  });

  it('creates playlist materialization dry-run artifacts only under generated/playlists without mutating cursors', async () => {
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const db = getDb();
    db.prepare('INSERT INTO cursors (key, value) VALUES (?, ?)').run('program:test', 'file-1');
    const published = await saveAndPublishValidDraft(baseUrl, 'Materialization schedule', 'materialize.xlsx');
    await activatePublishedScheduleForTest(baseUrl, published.publishedId);
    const cursorCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;

    const missingConfirmResponse = await fetch(`${baseUrl}/api/scheduler-foundation/playlist-materialization/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmDryRun: false, publishedScheduleId: published.publishedId }),
    });
    const missingConfirm = await missingConfirmResponse.json() as { code: string };
    expect(missingConfirmResponse.status).toBe(400);
    expect(missingConfirm.code).toBe('DRY_RUN_CONFIRMATION_REQUIRED');

    const unsafeResponse = await fetch(`${baseUrl}/api/scheduler-foundation/playlist-materialization/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmDryRun: true,
        publishedScheduleId: published.publishedId,
        outputRoot: path.join(tempDir, 'outside-generated'),
      }),
    });
    const unsafe = await unsafeResponse.json() as { code: string };
    expect(unsafeResponse.status).toBe(400);
    expect(unsafe.code).toBe('UNSAFE_OUTPUT_PATH');

    const dryRunResponse = await fetch(`${baseUrl}/api/scheduler-foundation/playlist-materialization/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmDryRun: true,
        publishedScheduleId: published.publishedId,
      }),
    });
    const dryRun = await dryRunResponse.json() as {
      run: {
        id: string;
        outputPath: string;
        status: string;
        summary: {
          itemCount: number;
          mediaExpansionAvailable: boolean;
          testPlayoutEligible: boolean;
          ffconcatPath: string | null;
          safety: {
            cursorMutation: boolean;
            ffmpeg: boolean;
            ffprobe: boolean;
            playout: boolean;
            broadcast: boolean;
            mediaModification: boolean;
          };
        };
        warnings: Array<{ code: string }>;
        errors: Array<{ code: string }>;
      };
    };
    const generatedRoot = path.join(tempDir, 'generated', 'playlists');

    expect(dryRunResponse.status).toBe(201);
    expect(dryRun.run.status).toBe('failed');
    expect(path.resolve(dryRun.run.outputPath).startsWith(`${path.resolve(generatedRoot)}${path.sep}`)).toBe(true);
    expect(fs.existsSync(path.join(dryRun.run.outputPath, 'playlist.json'))).toBe(true);
    expect(fs.existsSync(path.join(dryRun.run.outputPath, 'report.json'))).toBe(true);
    expect(fs.existsSync(path.join(dryRun.run.outputPath, 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(dryRun.run.outputPath, 'playlist.ffconcat'))).toBe(false);
    expect(dryRun.run.summary.itemCount).toBeGreaterThan(0);
    expect(dryRun.run.summary.mediaExpansionAvailable).toBe(false);
    expect(dryRun.run.summary.testPlayoutEligible).toBe(false);
    expect(dryRun.run.summary.ffconcatPath).toBeNull();
    expect(dryRun.run.summary.safety).toMatchObject({
      cursorMutation: false,
      ffmpeg: false,
      ffprobe: false,
      playout: false,
      broadcast: false,
      mediaModification: false,
    });
    expect(dryRun.run.errors.map(error => error.code)).toContain('PROGRAM_MEDIA_NOT_AVAILABLE');

    const cursorCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
    const playlistCount = (db.prepare('SELECT COUNT(*) as cnt FROM daily_playlists').get() as { cnt: number }).cnt;
    const runCount = (db.prepare('SELECT COUNT(*) as cnt FROM playlist_materialization_runs').get() as { cnt: number }).cnt;
    const auditRow = db.prepare(`
      SELECT detail
      FROM audit_logs
      WHERE action='scheduler_foundation.playlist_materialization_dry_run'
    `).get() as { detail: string } | undefined;
    expect(cursorCountAfter).toBe(cursorCountBefore);
    expect(playlistCount).toBe(0);
    expect(runCount).toBe(1);
    expect(auditRow).toBeDefined();
    expect(JSON.parse(auditRow?.detail ?? '{}')).toMatchObject({
      runId: dryRun.run.id,
      createdBy: 'user-1',
      mediaExpansionAvailable: false,
      testPlayoutEligible: false,
      cursorMutation: false,
      playout: false,
      broadcast: false,
    });
  });

  it('expands a published schedule to file-level playlist artifacts and ffconcat when media is ready', async () => {
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const db = getDb();
    const published = await saveAndPublishValidDraft(baseUrl, 'Expanded materialization schedule', 'expanded.xlsx');
    await activatePublishedScheduleForTest(baseUrl, published.publishedId);
    const mediaDir = path.join(tempDir, 'media', 'tafseer');
    fs.mkdirSync(mediaDir, { recursive: true });
    const first = path.join(mediaDir, '001.mp4');
    const second = path.join(mediaDir, '002.mp4');
    const filler = path.join(mediaDir, 'filler.mp4');
    fs.writeFileSync(first, 'media-1');
    fs.writeFileSync(second, 'media-2');
    fs.writeFileSync(filler, 'filler');
    insertMediaFile(db, {
      id: 'program-media-1',
      filePath: first,
      filename: '001.mp4',
      type: 'program',
      folderId: 'folder-1',
      durationSec: 1800,
    });
    insertMediaFile(db, {
      id: 'program-media-2',
      filePath: second,
      filename: '002.mp4',
      type: 'program',
      folderId: 'folder-1',
      durationSec: 1800,
    });
    insertMediaFile(db, {
      id: 'filler-media-1',
      filePath: filler,
      filename: 'filler.mp4',
      type: 'filler',
      folderId: null,
      durationSec: 23 * 60 * 60,
    });

    const dryRunResponse = await fetch(`${baseUrl}/api/scheduler-foundation/playlist-materialization/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmDryRun: true,
        publishedScheduleId: published.publishedId,
      }),
    });
    const dryRun = await dryRunResponse.json() as {
      run: {
        outputPath: string;
        status: string;
        summary: {
          mediaExpansionAvailable: boolean;
          testPlayoutEligible: boolean;
          ffconcatPath: string | null;
          missingMediaFileCount: number;
          unknownDurationCount: number;
        };
        errors: Array<{ code: string }>;
      };
    };
    const playlistPath = path.join(dryRun.run.outputPath, 'playlist.json');
    const ffconcatPath = path.join(dryRun.run.outputPath, 'playlist.ffconcat');
    const playlist = JSON.parse(fs.readFileSync(playlistPath, 'utf8')) as {
      mediaExpansionAvailable: boolean;
      items: Array<{ mediaFileId: string | null; absolutePath: string | null; validationStatus: string }>;
    };
    const ffconcat = fs.readFileSync(ffconcatPath, 'utf8');

    expect(dryRunResponse.status).toBe(201);
    expect(dryRun.run.status).toBe('completed');
    expect(dryRun.run.summary).toMatchObject({
      mediaExpansionAvailable: true,
      testPlayoutEligible: true,
      missingMediaFileCount: 0,
      unknownDurationCount: 0,
    });
    expect(dryRun.run.summary.ffconcatPath).toBe(ffconcatPath);
    expect(dryRun.run.errors).toEqual([]);
    expect(playlist.mediaExpansionAvailable).toBe(true);
    expect(playlist.items.every(item => item.validationStatus === 'ready')).toBe(true);
    expect(playlist.items.map(item => item.mediaFileId)).toContain('program-media-1');
    expect(playlist.items.map(item => item.mediaFileId)).toContain('program-media-2');
    expect(playlist.items.every(item => item.absolutePath)).toBe(true);
    expect(ffconcat).toContain('ffconcat version 1.0');
    expect(ffconcat).toContain(first.replace(/\\/g, '/').split('/').pop());
  });

  it('lists and reads playlist materialization dry-run records', async () => {
    const published = await saveAndPublishValidDraft(baseUrl, 'Run list schedule', 'run-list.xlsx');
    await activatePublishedScheduleForTest(baseUrl, published.publishedId);

    const dryRunResponse = await fetch(`${baseUrl}/api/scheduler-foundation/playlist-materialization/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmDryRun: true }),
    });
    const dryRun = await dryRunResponse.json() as { run: { id: string } };
    expect(dryRunResponse.status).toBe(201);

    const listResponse = await fetch(`${baseUrl}/api/scheduler-foundation/playlist-materialization/runs`);
    const list = await listResponse.json() as { runs: Array<{ id: string; mode: string; status: string }> };
    expect(listResponse.status).toBe(200);
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({ id: dryRun.run.id, mode: 'dry_run', status: 'failed' });

    const readResponse = await fetch(`${baseUrl}/api/scheduler-foundation/playlist-materialization/runs/${dryRun.run.id}`);
    const read = await readResponse.json() as { run: { id: string; summary: { safety: { playout: boolean; broadcast: boolean } } } };
    expect(readResponse.status).toBe(200);
    expect(read.run.id).toBe(dryRun.run.id);
    expect(read.run.summary.safety).toMatchObject({ playout: false, broadcast: false });
  });

  it('requires explicit prepare-only confirmation for test playout plans', async () => {
    const playlistPath = createDryRunPlaylistArtifact(tempDir);

    const response = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: false,
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
      }),
    });
    const body = await response.json() as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('TEST_PLAYOUT_CONFIRMATION_REQUIRED');
  });

  it('rejects RTMP, RTMPS, and live URL targets for test playout plans', async () => {
    const playlistPath = createDryRunPlaylistArtifact(tempDir);

    const rtmpResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: 'rtmp://live.example/stream',
        outputMode: 'local_file',
      }),
    });
    const rtmp = await rtmpResponse.json() as { code: string };
    expect(rtmpResponse.status).toBe(400);
    expect(rtmp.code).toBe('RTMP_TARGET_FORBIDDEN');

    const rtmpsResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        outputPath: 'rtmps://live.example/stream',
      }),
    });
    const rtmps = await rtmpsResponse.json() as { code: string };
    expect(rtmpsResponse.status).toBe(400);
    expect(rtmps.code).toBe('RTMP_TARGET_FORBIDDEN');

    const liveUrlResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'localhost_hls',
        outputPath: 'https://live.example/hls/index.m3u8',
      }),
    });
    const liveUrl = await liveUrlResponse.json() as { code: string };
    expect(liveUrlResponse.status).toBe(400);
    expect(liveUrl.code).toBe('LIVE_URL_FORBIDDEN');
  });

  it('rejects unsafe output and media paths for test playout plans', async () => {
    const playlistPath = createDryRunPlaylistArtifact(tempDir);

    const outsideResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        outputPath: path.join(tempDir, 'outside', 'output.mp4'),
      }),
    });
    const outside = await outsideResponse.json() as { code: string };
    expect(outsideResponse.status).toBe(400);
    expect(outside.code).toBe('UNSAFE_TEST_PLAYOUT_OUTPUT_PATH');

    const mediaResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        outputPath: '/srv/daawah/media/output.mp4',
      }),
    });
    const media = await mediaResponse.json() as { code: string };
    expect(mediaResponse.status).toBe(400);
    expect(media.code).toBe('MEDIA_PATH_FORBIDDEN');

    const streamKeyResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        streamKey: 'sk_live_secret_stream_key_value',
      }),
    });
    const streamKey = await streamKeyResponse.json() as { code: string };
    expect(streamKeyResponse.status).toBe(400);
    expect(streamKey.code).toBe('STREAM_KEY_FORBIDDEN');

    const nestedStreamKeyResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        metadata: {
          streamKey: 'sk_live_nested_secret',
        },
      }),
    });
    const nestedStreamKey = await nestedStreamKeyResponse.json() as { code: string };
    expect(nestedStreamKeyResponse.status).toBe(400);
    expect(nestedStreamKey.code).toBe('STREAM_KEY_FORBIDDEN');
  });

  it('rejects test playout plans when ffconcat does not match expanded playlist items', async () => {
    const playlistPath = createDryRunPlaylistArtifact(tempDir);
    fs.writeFileSync(
      path.join(path.dirname(playlistPath), 'playlist.ffconcat'),
      "ffconcat version 1.0\nfile 'rtmp://live.example/unsafe'\n",
      'utf8'
    );

    const response = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
      }),
    });
    const body = await response.json() as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('SOURCE_PLAYLIST_FFCONCAT_MISMATCH');
  });

  it('creates a planned test playout record only without spawning or mutating production tables', async () => {
    const childProcess = require('child_process') as typeof import('child_process');
    const spawnSpy = jest.spyOn(childProcess, 'spawn');
    const { getDb } = require('../db/schema') as typeof import('../db/schema');
    const db = getDb();
    db.prepare('INSERT INTO cursors (key, value) VALUES (?, ?)').run('program:test', 'file-1');
    const playlistPath = createDryRunPlaylistArtifact(tempDir);
    const cursorCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
    const playlistCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM daily_playlists').get() as { cnt: number }).cnt;

    const response = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        durationLimitSeconds: 600,
      }),
    });
    const body = await response.json() as {
      plan: {
        id: string;
        status: string;
        sourcePlaylistPath: string;
        outputPath: string;
        durationLimitSeconds: number;
        commandPreview: {
          willExecute: boolean;
          safety: {
            ffmpegExecution: boolean;
            playoutStarted: boolean;
            broadcastStarted: boolean;
            cursorMutation: boolean;
            mediaAccess: boolean;
          };
        };
      };
      safety: {
        prepareOnly: boolean;
        ffmpegExecution: boolean;
        playoutStarted: boolean;
        broadcastStarted: boolean;
        cursorUpdates: boolean;
      };
    };
    const cursorCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
    const playlistCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM daily_playlists').get() as { cnt: number }).cnt;
    const planCount = (db.prepare('SELECT COUNT(*) as cnt FROM test_playout_plans').get() as { cnt: number }).cnt;

    expect(response.status).toBe(201);
    expect(body.plan).toMatchObject({
      status: 'planned',
      sourcePlaylistPath: playlistPath,
      durationLimitSeconds: 600,
    });
    expect(path.resolve(body.plan.outputPath).startsWith(`${path.resolve(tempDir, 'generated', 'test-playout')}${path.sep}`)).toBe(true);
    expect(body.plan.outputPath.endsWith(`${path.sep}output.mp4`)).toBe(true);
    expect(body.plan.commandPreview.willExecute).toBe(false);
    expect(body.plan.commandPreview.safety).toMatchObject({
      ffmpegExecution: false,
      playoutStarted: false,
      broadcastStarted: false,
      cursorMutation: false,
      mediaAccess: false,
    });
    expect(body.safety).toMatchObject({
      prepareOnly: true,
      ffmpegExecution: false,
      playoutStarted: false,
      broadcastStarted: false,
      cursorUpdates: false,
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(cursorCountAfter).toBe(cursorCountBefore);
    expect(playlistCountAfter).toBe(playlistCountBefore);
    expect(planCount).toBe(1);
    spawnSpy.mockRestore();
  });

  it('lists and reads test playout plans', async () => {
    const playlistPath = createDryRunPlaylistArtifact(tempDir);

    const createResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmPrepareOnly: true,
        sourcePlaylistPath: playlistPath,
        outputMode: 'localhost_hls',
      }),
    });
    const created = await createResponse.json() as { plan: { id: string; outputMode: string; outputPath: string } };
    expect(createResponse.status).toBe(201);
    expect(created.plan.outputMode).toBe('localhost_hls');
    expect(created.plan.outputPath.endsWith(`${path.sep}hls`)).toBe(true);

    const listResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans`);
    const list = await listResponse.json() as { plans: Array<{ id: string; status: string }> };
    expect(listResponse.status).toBe(200);
    expect(list.plans).toHaveLength(1);
    expect(list.plans[0]).toMatchObject({ id: created.plan.id, status: 'planned' });

    const readResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/plans/${created.plan.id}`);
    const read = await readResponse.json() as { plan: { id: string; commandPreview: { safety: { broadcastStarted: boolean } } } };
    expect(readResponse.status).toBe(200);
    expect(read.plan.id).toBe(created.plan.id);
    expect(read.plan.commandPreview.safety.broadcastStarted).toBe(false);
  });

  it('executes an isolated test playout run only after explicit execution confirmation', async () => {
    const childProcess = require('child_process') as typeof import('child_process');
    const { EventEmitter } = require('events') as typeof import('events');
    const playlistPath = createDryRunPlaylistArtifact(tempDir);
    const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation((() => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stderr?.emit('data', Buffer.from('ffmpeg ok'));
        child.emit('close', 0, null);
      });
      return child;
    }) as typeof childProcess.spawn);

    const rejectedResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        durationLimitSeconds: 5,
      }),
    });
    const rejected = await rejectedResponse.json() as { code: string };
    expect(rejectedResponse.status).toBe(400);
    expect(rejected.code).toBe('TEST_PLAYOUT_EXECUTION_CONFIRMATION_REQUIRED');
    expect(spawnSpy).not.toHaveBeenCalled();

    const paddedConfirmationResponse = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmExecution: true,
        confirmationText: ' RUN ISOLATED TEST PLAYOUT ',
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        durationLimitSeconds: 5,
      }),
    });
    const paddedConfirmation = await paddedConfirmationResponse.json() as { code: string };
    expect(paddedConfirmationResponse.status).toBe(400);
    expect(paddedConfirmation.code).toBe('TEST_PLAYOUT_EXECUTION_TEXT_REQUIRED');
    expect(spawnSpy).not.toHaveBeenCalled();

    const response = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmExecution: true,
        confirmationText: 'RUN ISOLATED TEST PLAYOUT',
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        durationLimitSeconds: 5,
      }),
    });
    const body = await response.json() as {
      run: {
        status: string;
        outputPath: string;
        artifacts: {
          statusPath: string;
          reportPath: string;
          ffmpegLogPath: string;
        };
        commandPreview: {
          willExecute: boolean;
          args: string[];
          safety: {
            ffmpegExecution: boolean;
            broadcastStarted: boolean;
            rtmpPush: boolean;
            streamKeyUsage: boolean;
          };
        };
        safety: {
          broadcastStarted: boolean;
          rtmpPush: boolean;
          streamKeyUsage: boolean;
          productionPaths: boolean;
        };
      };
    };

    expect(response.status).toBe(201);
    expect(body.run.status).toBe('completed');
    expect(path.resolve(body.run.outputPath).startsWith(`${path.resolve(tempDir, 'generated', 'test-playout')}${path.sep}`)).toBe(true);
    expect(body.run.commandPreview.willExecute).toBe(true);
    expect(body.run.commandPreview.args.join(' ')).not.toContain('rtmp');
    expect(body.run.commandPreview.safety).toMatchObject({
      ffmpegExecution: true,
      broadcastStarted: false,
      rtmpPush: false,
      streamKeyUsage: false,
    });
    expect(body.run.safety).toMatchObject({
      broadcastStarted: false,
      rtmpPush: false,
      streamKeyUsage: false,
      productionPaths: false,
    });
    expect(fs.existsSync(body.run.artifacts.statusPath)).toBe(true);
    expect(fs.existsSync(body.run.artifacts.reportPath)).toBe(true);
    expect(fs.existsSync(body.run.artifacts.ffmpegLogPath)).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const args = spawnSpy.mock.calls[0]?.[1] as string[];
    const inputIndex = args.indexOf('-i');
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    const verifiedFfconcatPath = args[inputIndex + 1];
    if (!verifiedFfconcatPath) throw new Error('Missing verified ffconcat path in FFmpeg args');
    expect(path.resolve(verifiedFfconcatPath)).toContain(`${path.resolve(tempDir, 'generated', 'test-playout')}${path.sep}`);
    expect(path.basename(verifiedFfconcatPath)).toBe('verified-playlist.ffconcat');
    expect(fs.readFileSync(verifiedFfconcatPath, 'utf8')).toContain('expanded-1.mp4');
    spawnSpy.mockRestore();
  });

  it('fails an isolated test playout run and kills FFmpeg when it exceeds the watchdog timeout', async () => {
    process.env['TEST_PLAYOUT_FFMPEG_TIMEOUT_MS'] = '5';
    process.env['TEST_PLAYOUT_FFMPEG_KILL_GRACE_MS'] = '5';
    const childProcess = require('child_process') as typeof import('child_process');
    const { EventEmitter } = require('events') as typeof import('events');
    const playlistPath = createDryRunPlaylistArtifact(tempDir);
    let killSpy: jest.Mock<boolean, [NodeJS.Signals]> | null = null;
    const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation((() => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn((signal: NodeJS.Signals) => {
        setImmediate(() => {
          child.emit('close', null, signal);
        });
        return true;
      });
      killSpy = child.kill;
      return child;
    }) as typeof childProcess.spawn);

    const response = await fetch(`${baseUrl}/api/scheduler-foundation/test-playout/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmExecution: true,
        confirmationText: 'RUN ISOLATED TEST PLAYOUT',
        sourcePlaylistPath: playlistPath,
        outputMode: 'local_file',
        durationLimitSeconds: 5,
      }),
    });
    const body = await response.json() as { run: { status: string; errors: Array<{ code: string }> } };

    expect(response.status).toBe(500);
    expect(body.run.status).toBe('failed');
    expect(body.run.errors.map(error => error.code)).toContain('FFMPEG_TIMEOUT');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    spawnSpy.mockRestore();
  });

  it('saves an inactive invalid draft when the preview has validation errors', async () => {
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
          acceptedProgramKeys: ['bad'],
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
    const body = await response.json() as {
      draft: {
        id: string;
        status: string;
        isActive: boolean;
        validationStatus: string;
        validationErrors: Array<{ code: string }>;
      };
    };

    expect(response.status).toBe(201);
    expect(body.draft).toMatchObject({
      status: 'draft',
      isActive: false,
      validationStatus: 'draft_invalid',
    });
    expect(body.draft.validationErrors.map(issue => issue.code)).toContain('PREVIEW_HAS_ERRORS');

    const publishResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules/${body.draft.id}/publish`, {
      method: 'POST',
    });
    const publishBody = await publishResponse.json() as { code: string };
    expect(publishResponse.status).toBe(400);
    expect(publishBody.code).toBe('DRAFT_NOT_PUBLISHABLE');
  });

  it('recomputes overlap validation instead of trusting the submitted summary', async () => {
    const workbook = makeWorkbookBuffer();
    const preview = await previewWorkbook(baseUrl, workbook);
    const overlappingPreview = cloneJson(preview) as {
      slots: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };
    const originalSlot = overlappingPreview.slots[0]!;
    overlappingPreview.slots = [
      originalSlot,
      {
        ...originalSlot,
        row: 3,
        start_time: '08:30',
        end_time: '09:30',
        start_minutes: 510,
        end_minutes: 570,
        computed_end_minutes: 570,
      },
    ];
    overlappingPreview.summary = {
      ...overlappingPreview.summary,
      errors: 0,
      conflicts: 0,
      slotCount: 2,
    };

    const saveResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Overlap draft',
        sourceExcel: {
          filename: 'overlap.xlsx',
          sha256: sha256(workbook),
        },
        preview: overlappingPreview,
      }),
    });
    const body = await saveResponse.json() as {
      draft: {
        validationStatus: string;
        validationErrors: Array<{ code: string }>;
      };
    };

    expect(saveResponse.status).toBe(201);
    expect(body.draft.validationStatus).toBe('draft_invalid');
    expect(body.draft.validationErrors.map(issue => issue.code)).toContain('DRAFT_SLOT_OVERLAP');
  });

  it('marks a draft invalid when timezone or indexed folder matches are inconsistent', async () => {
    const workbook = makeWorkbookBuffer();
    const preview = await previewWorkbook(baseUrl, workbook);
    const hardenedPreview = cloneJson(preview) as {
      settings: Record<string, unknown>;
      schedulePreview: Record<string, unknown>;
      folderMatches: Array<Record<string, unknown>>;
    };
    hardenedPreview.settings.timezone = 'Mars/Base';
    hardenedPreview.schedulePreview.timezone = 'Mars/Base';
    hardenedPreview.folderMatches[0] = {
      ...hardenedPreview.folderMatches[0],
      matched_folder_id: 'missing-folder',
    };

    const saveResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Hardened validation draft',
        sourceExcel: {
          filename: 'hardened.xlsx',
          sha256: sha256(workbook),
        },
        preview: hardenedPreview,
      }),
    });
    const body = await saveResponse.json() as {
      draft: {
        validationStatus: string;
        validationErrors: Array<{ code: string }>;
      };
    };
    const codes = body.draft.validationErrors.map(issue => issue.code);

    expect(saveResponse.status).toBe(201);
    expect(body.draft.validationStatus).toBe('draft_invalid');
    expect(codes).toContain('DRAFT_INVALID_TIMEZONE');
    expect(codes).toContain('DRAFT_FOLDER_MATCH_NOT_INDEXED');
  });

  it('rejects malformed draft payload shapes before saving', async () => {
    const response = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceExcel: {
          filename: 'bad-shape.xlsx',
          sha256: 'a'.repeat(64),
        },
        preview: {
          mode: 'preview',
          settings: {
            timezone: 'Europe/Istanbul',
            schedule_start_date: '2026-06-06',
            schedule_end_date: '2026-06-06',
          },
          summary: { errors: 0, warnings: 0, programCount: 1, slotCount: 1 },
          programs: [{ program_key: 'tafseer' }],
          slots: 'not-an-array',
          folderMatches: [],
          issues: [],
          schedulePreview: { timezone: 'Europe/Istanbul', gapPattern: 'main', truncated: false, days: [] },
          acceptedProgramKeys: ['tafseer'],
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
    expect(body.code).toBe('SLOTS_REQUIRED');
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

async function previewWorkbook(baseUrl: string, workbook: Buffer): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([workbook], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'schedule.xlsx'
  );

  const response = await fetch(`${baseUrl}/api/scheduler-foundation/excel-import/preview`, {
    method: 'POST',
    body: form,
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createDryRunPlaylistArtifact(root: string): string {
  const playlistDir = path.join(root, 'generated', 'playlists', 'test-run');
  fs.mkdirSync(playlistDir, { recursive: true });
  const playlistPath = path.join(playlistDir, 'playlist.json');
  const ffconcatPath = path.join(playlistDir, 'playlist.ffconcat');
  const mediaDir = path.join(root, 'media');
  const mediaPath = path.join(mediaDir, 'expanded-1.mp4');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(mediaPath, 'test media placeholder', 'utf8');
  fs.writeFileSync(playlistPath, JSON.stringify({
    runId: 'test-run',
    dryRun: true,
    mediaExpansionAvailable: true,
    ffconcatPath,
    items: [{
      id: 'expanded-1',
      title: 'Expanded test item',
      timelineStartSeconds: 0,
      timelineEndSeconds: 5,
      durationSeconds: 5,
      validationStatus: 'ready',
      absolutePath: mediaPath,
      isTrimmed: false,
    }],
  }), 'utf8');
  fs.writeFileSync(ffconcatPath, `ffconcat version 1.0\nfile '${mediaPath.replace(/\\/g, '/')}'\n`, 'utf8');
  return playlistPath;
}

function insertMediaFile(
  db: ReturnType<typeof import('../db/schema').getDb>,
  input: {
    id: string;
    filePath: string;
    filename: string;
    type: 'program' | 'filler' | 'emergency';
    folderId: string | null;
    durationSec: number;
  }
): void {
  db.prepare(`
    INSERT INTO media_files
      (id, path, relative_path, filename, type, status, folder_id, duration_sec, duration_ms, file_size)
    VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
  `).run(
    input.id,
    input.filePath,
    input.filename,
    input.filename,
    input.type,
    input.folderId,
    input.durationSec,
    input.durationSec * 1000,
    fs.statSync(input.filePath).size
  );
}

async function saveAndPublishValidDraft(
  baseUrl: string,
  name: string,
  filename: string
): Promise<{ draftId: string; publishedId: string }> {
  const workbook = makeWorkbookBuffer();
  const preview = await previewWorkbook(baseUrl, workbook);

  const saveResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      sourceExcel: {
        filename,
        sha256: sha256(workbook),
      },
      preview,
    }),
  });
  const saved = await saveResponse.json() as { draft: { id: string; validationStatus: string } };
  expect(saveResponse.status).toBe(201);
  expect(saved.draft.validationStatus).toBe('draft_valid');

  const publishResponse = await fetch(`${baseUrl}/api/scheduler-foundation/draft-schedules/${saved.draft.id}/publish`, {
    method: 'POST',
  });
  const published = await publishResponse.json() as { publishedSchedule: { id: string; isActive: boolean } };
  expect(publishResponse.status).toBe(201);
  expect(published.publishedSchedule.isActive).toBe(false);

  return {
    draftId: saved.draft.id,
    publishedId: published.publishedSchedule.id,
  };
}

async function activatePublishedScheduleForTest(baseUrl: string, publishedId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/scheduler-foundation/published-schedules/${publishedId}/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scheduleId: publishedId,
      confirmActivation: true,
      confirmationText: `ACTIVATE SCHEDULE ${publishedId}`,
    }),
  });
  expect(response.status).toBe(200);
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
