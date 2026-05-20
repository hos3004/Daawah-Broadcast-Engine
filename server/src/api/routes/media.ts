import { Router, Request, Response } from 'express';
import fs from 'fs';
import { requireRole, auditLog } from '../../auth';
import { getDb } from '../../db/schema';
import { scanMediaFolder, scanMediaLibrary } from '../../media/scanner';
import {
  getMediaBrowserRoots,
  listMediaBrowserDirectory,
  MediaBrowserError,
  resolveMediaBrowserPath,
} from '../../media/browser';
import { broadcastWs } from '../../ws';
import { getTranscodeQueue, cancelTranscodeJob } from '../../workers/transcodeWorker';

export const mediaRouter = Router();

let scanInProgress = false;

mediaRouter.post('/scan', requireRole('admin', 'editor', 'operator'), async (req: Request, res: Response): Promise<void> => {
  if (scanInProgress) {
    res.status(409).json({ error: 'Scan already in progress' });
    return;
  }

  scanInProgress = true;
  auditLog(req.user!.id, req.user!.email, 'MEDIA_SCAN_START', 'media', undefined, undefined, req.ip);

  res.json({ ok: true, message: 'Scan started' });

  try {
    const result = await scanMediaLibrary((progress) => {
      broadcastWs({ type: 'scan_progress', data: progress });
    });
    auditLog(req.user!.id, req.user!.email, 'MEDIA_SCAN_DONE', 'media', undefined, JSON.stringify(result), req.ip);
    broadcastWs({ type: 'scan_complete', data: result });
  } catch (err) {
    broadcastWs({ type: 'scan_error', data: { error: String(err) } });
  } finally {
    scanInProgress = false;
  }
});

mediaRouter.get('/browser/roots', (_req: Request, res: Response): void => {
  res.json({ roots: getMediaBrowserRoots({ includeStats: true }) });
});

mediaRouter.get('/browser/list', (req: Request, res: Response): void => {
  const {
    rootId,
    path: relativePath,
    search,
    mp4Only,
    page = '1',
    limit = '100',
  } = req.query as Record<string, string | undefined>;

  if (!rootId) {
    res.status(400).json({ error: 'rootId is required' });
    return;
  }

  try {
    const result = listMediaBrowserDirectory({
      rootId,
      relativePath,
      search,
      mp4Only: mp4Only === 'true' || mp4Only === '1',
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
    res.json(result);
  } catch (err) {
    sendMediaBrowserError(res, err);
  }
});

mediaRouter.post('/browser/scan', requireRole('admin', 'editor', 'operator'), async (req: Request, res: Response): Promise<void> => {
  if (scanInProgress) {
    res.status(409).json({ error: 'Scan already in progress' });
    return;
  }

  const { rootId, path: relativePath } = req.body as { rootId?: string; path?: string };
  if (!rootId) {
    res.status(400).json({ error: 'rootId is required' });
    return;
  }

  let resolved: ReturnType<typeof resolveMediaBrowserPath>;
  try {
    resolved = resolveMediaBrowserPath(rootId, relativePath);
    if (!fs.statSync(resolved.fullPath).isDirectory()) {
      res.status(400).json({ error: 'Selected path is not a directory' });
      return;
    }
  } catch (err) {
    sendMediaBrowserError(res, err);
    return;
  }

  scanInProgress = true;
  auditLog(
    req.user!.id,
    req.user!.email,
    'MEDIA_BROWSER_SCAN_START',
    'media_folder',
    resolved.root.id,
    resolved.fullPath,
    req.ip
  );

  res.json({ ok: true, message: 'Selected folder scan started', path: resolved.fullPath });

  try {
    const result = await scanMediaFolder(resolved.fullPath, (progress) => {
      broadcastWs({ type: 'scan_progress', data: progress });
    });
    auditLog(req.user!.id, req.user!.email, 'MEDIA_BROWSER_SCAN_DONE', 'media_folder', resolved.root.id, JSON.stringify(result), req.ip);
    broadcastWs({ type: 'scan_complete', data: result });
  } catch (err) {
    broadcastWs({ type: 'scan_error', data: { error: String(err) } });
  } finally {
    scanInProgress = false;
  }
});

mediaRouter.get('/files', (req: Request, res: Response): void => {
  const db = getDb();
  const { type, status, page = '1', limit = '50' } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (type) { conditions.push('type = ?'); params.push(type); }
  if (status) { conditions.push('status = ?'); params.push(status); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const files = db.prepare(`SELECT * FROM media_files ${where} ORDER BY filename LIMIT ? OFFSET ?`)
    .all(...params, limitNum, offset);
  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM media_files ${where}`).get(...params) as { cnt: number }).cnt;

  res.json({ files, total, page: pageNum, limit: limitNum });
});

mediaRouter.get('/stats', (_req: Request, res: Response): void => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT status, COUNT(*) as count, SUM(duration_sec) as total_duration, SUM(file_size) as total_size
    FROM media_files GROUP BY status
  `).all();
  res.json({ stats });
});

mediaRouter.get('/programs', (_req: Request, res: Response): void => {
  const db = getDb();
  const programs = db.prepare(`
    SELECT p.*, COUNT(mf.id) as file_count,
           SUM(CASE WHEN mf.status='ready' THEN 1 ELSE 0 END) as ready_count
    FROM programs p
    LEFT JOIN media_files mf ON mf.program_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all();
  res.json({ programs });
});

mediaRouter.post('/programs', requireRole('admin', 'editor'), (req: Request, res: Response): void => {
  const { name, name_ar, folder_path, play_mode } = req.body as Record<string, string>;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const { v4: uuidv4 } = require('uuid') as { v4: () => string };
  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO programs (id, name, name_ar, folder_path, play_mode) VALUES (?,?,?,?,?)')
    .run(id, name, name_ar ?? null, folder_path ?? null, play_mode ?? 'sequential');

  auditLog(req.user!.id, req.user!.email, 'PROGRAM_CREATE', 'program', id, name, req.ip);
  res.status(201).json({ id });
});

mediaRouter.get('/episodes', (req: Request, res: Response): void => {
  const db = getDb();
  const { program_id } = req.query as Record<string, string>;
  const where = program_id ? 'WHERE e.program_id = ?' : '';
  const params = program_id ? [program_id] : [];

  const episodes = db.prepare(`
    SELECT e.*, mf.status as media_status, mf.duration_sec
    FROM episodes e
    LEFT JOIN media_files mf ON e.media_file_id = mf.id
    ${where} ORDER BY e.episode_number
  `).all(...params);

  res.json({ episodes });
});

mediaRouter.post('/transcode', requireRole('admin', 'editor'), (req: Request, res: Response): void => {
  const { media_file_id } = req.body as { media_file_id?: string };
  if (!media_file_id) { res.status(400).json({ error: 'media_file_id is required' }); return; }

  const db = getDb();
  const file = db.prepare('SELECT id, path FROM media_files WHERE id=?').get(media_file_id) as { id: string; path: string } | undefined;
  if (!file) { res.status(404).json({ error: 'Media file not found' }); return; }

  const { v4: uuidv4 } = require('uuid') as { v4: () => string };
  const jobId = uuidv4();
  db.prepare('INSERT INTO transcode_jobs (id, media_file_id, status, created_by) VALUES (?,?,\'pending\',?)')
    .run(jobId, media_file_id, req.user!.id);

  auditLog(req.user!.id, req.user!.email, 'TRANSCODE_JOB_CREATE', 'transcode_job', jobId, media_file_id, req.ip);
  res.status(201).json({ jobId, message: 'Transcode job queued.' });
});

mediaRouter.get('/transcode/queue', requireRole('admin', 'editor', 'operator'), (_req: Request, res: Response): void => {
  res.json({ jobs: getTranscodeQueue() });
});

mediaRouter.delete('/transcode/:jobId', requireRole('admin', 'editor'), async (req: Request, res: Response): Promise<void> => {
  await cancelTranscodeJob(req.params['jobId']!);
  res.json({ ok: true });
});

function sendMediaBrowserError(res: Response, err: unknown): void {
  if (err instanceof MediaBrowserError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'Media browser request failed' });
}
