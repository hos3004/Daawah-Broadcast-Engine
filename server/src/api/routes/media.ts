import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireRole, auditLog, verifyPassword } from '../../auth';
import { config } from '../../config';
import { getDb } from '../../db/schema';
import { scanMediaFolder, scanMediaLibrary } from '../../media/scanner';
import { listMediaRoots } from '../../media/safeRoots';
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

mediaRouter.get('/browser/stream', (req: Request, res: Response): void => {
  const { rootId, path: relativePath } = req.query as Record<string, string | undefined>;

  if (!rootId) {
    res.status(400).json({ error: 'rootId is required' });
    return;
  }

  try {
    const resolved = resolveMediaBrowserPath(rootId, relativePath);
    if (!fs.statSync(resolved.fullPath).isFile()) {
      res.status(400).json({ error: 'Selected path is not a file' });
      return;
    }
    streamMediaFile(req, res, resolved.fullPath, path.basename(resolved.fullPath));
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

mediaRouter.get('/program-folders', (_req: Request, res: Response): void => {
  const db = getDb();
  const folders = db.prepare(`
    SELECT
      mf.id,
      mf.root_id,
      mr.root_key,
      mr.absolute_path as root_path,
      mf.original_relative_path,
      mf.display_name_ar,
      mf.safe_slug,
      mf.parent_folder_id,
      0 as active_file_count,
      mf.total_duration_ms as active_total_duration_ms,
      mf.longest_file_duration_ms as active_longest_file_duration_ms,
      mf.file_count,
      mf.total_duration_ms,
      mf.longest_file_duration_ms,
      mf.status,
      COALESCE(mf.trash_status, 'active') as trash_status,
      mf.updated_at
    FROM media_folders mf
    JOIN media_roots mr ON mr.id = mf.root_id
    WHERE COALESCE(mf.trash_status, 'active') = 'active'
    ORDER BY mr.root_key, mf.original_relative_path
  `).all() as Array<{
    id: string;
    active_file_count: number;
    active_total_duration_ms: number | null;
    active_longest_file_duration_ms: number | null;
  }>;

  for (const folder of folders) {
    const folderIds = collectFolderTreeIds(db, folder.id);
    const placeholders = folderIds.map(() => '?').join(',');
    const stats = db.prepare(`
      SELECT
        COUNT(*) as file_count,
        SUM(COALESCE(duration_ms, CAST(duration_sec * 1000 AS INTEGER))) as total_duration_ms,
        MAX(COALESCE(duration_ms, CAST(duration_sec * 1000 AS INTEGER))) as longest_file_duration_ms
      FROM media_files
      WHERE folder_id IN (${placeholders})
        AND COALESCE(trash_status, 'active') = 'active'
    `).get(...folderIds) as {
      file_count: number;
      total_duration_ms: number | null;
      longest_file_duration_ms: number | null;
    };
    folder.active_file_count = stats.file_count;
    folder.active_total_duration_ms = stats.total_duration_ms;
    folder.active_longest_file_duration_ms = stats.longest_file_duration_ms;
  }

  res.json({ folders });
});

mediaRouter.get('/program-folders/:folderId/episodes', (req: Request, res: Response): void => {
  const db = getDb();
  const folder = db.prepare(`
    SELECT id FROM media_folders
    WHERE id=? AND COALESCE(trash_status, 'active') = 'active'
  `).get(req.params['folderId']) as { id: string } | undefined;

  if (!folder) {
    res.status(404).json({ error: 'Program folder not found' });
    return;
  }

  const folderIds = collectFolderTreeIds(db, folder.id);
  const placeholders = folderIds.map(() => '?').join(',');
  const episodes = db.prepare(`
    SELECT
      mf.*,
      folders.display_name_ar as folder_name_ar,
      roots.root_key
    FROM media_files mf
    LEFT JOIN media_folders folders ON folders.id = mf.folder_id
    LEFT JOIN media_roots roots ON roots.id = mf.root_id
    WHERE mf.folder_id IN (${placeholders})
      AND COALESCE(mf.trash_status, 'active') = 'active'
    ORDER BY folders.original_relative_path, COALESCE(mf.original_filename, mf.filename)
  `).all(...folderIds);

  res.json({ episodes });
});

mediaRouter.get('/files/:fileId/stream', (req: Request, res: Response): void => {
  const db = getDb();
  const file = db.prepare(`
    SELECT id, path, filename, status
    FROM media_files
    WHERE id=? AND COALESCE(trash_status, 'active') = 'active'
  `).get(req.params['fileId']) as { id: string; path: string; filename: string; status: string } | undefined;

  if (!file) {
    res.status(404).json({ error: 'Media file not found' });
    return;
  }

  if (!fs.existsSync(file.path) || !fs.statSync(file.path).isFile()) {
    res.status(404).json({ error: 'Media file is missing on disk' });
    return;
  }

  if (!isDeletablePathInsideAllowedRoot(file.path)) {
    res.status(403).json({ error: 'Media file is outside allowed media roots' });
    return;
  }

  streamMediaFile(req, res, file.path, file.filename);
});

mediaRouter.get('/files', (req: Request, res: Response): void => {
  const db = getDb();
  const { type, status, includeTrash, page = '1', limit = '50' } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (includeTrash !== 'true') conditions.push("COALESCE(trash_status, 'active') = 'active'");
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
    FROM media_files
    WHERE COALESCE(trash_status, 'active') = 'active'
    GROUP BY status
  `).all();
  res.json({ stats });
});

mediaRouter.get('/programs', (_req: Request, res: Response): void => {
  const db = getDb();
  const programs = db.prepare(`
    SELECT p.*, COUNT(mf.id) as file_count,
           SUM(CASE WHEN mf.status='ready' THEN 1 ELSE 0 END) as ready_count,
           MAX(COALESCE(mf.duration_ms, CAST(mf.duration_sec * 1000 AS INTEGER))) as longest_episode_duration_ms
    FROM programs p
    LEFT JOIN media_files mf
      ON mf.program_id = p.id
     AND COALESCE(mf.trash_status, 'active') = 'active'
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
    SELECT e.*, mf.status as media_status, mf.duration_sec, mf.duration_ms
    FROM episodes e
    LEFT JOIN media_files mf ON e.media_file_id = mf.id
    ${where}
      ${where ? 'AND' : 'WHERE'} COALESCE(mf.trash_status, 'active') = 'active'
    ORDER BY e.episode_number
  `).all(...params);

  res.json({ episodes });
});

mediaRouter.get('/trash', requireRole('admin', 'editor', 'operator'), (_req: Request, res: Response): void => {
  const db = getDb();
  const files = db.prepare(`
    SELECT
      'file' as kind,
      mf.id,
      COALESCE(mf.display_title_ar, mf.original_filename, mf.filename) as title,
      mf.path,
      mf.filename,
      mf.duration_sec,
      mf.duration_ms,
      mf.file_size,
      mf.status,
      mf.trashed_at,
      mf.trash_reason,
      users.email as trashed_by_email,
      folders.display_name_ar as folder_name_ar,
      roots.root_key
    FROM media_files mf
    LEFT JOIN users ON users.id = mf.trashed_by
    LEFT JOIN media_folders folders ON folders.id = mf.folder_id
    LEFT JOIN media_roots roots ON roots.id = mf.root_id
    WHERE COALESCE(mf.trash_status, 'active') = 'trashed'
    ORDER BY mf.trashed_at DESC, title
  `).all();

  const folders = db.prepare(`
    SELECT
      'folder' as kind,
      folders.id,
      folders.display_name_ar as title,
      roots.absolute_path || '/' || folders.original_relative_path as path,
      folders.original_relative_path,
      folders.file_count,
      folders.total_duration_ms,
      folders.longest_file_duration_ms,
      folders.status,
      folders.trashed_at,
      folders.trash_reason,
      users.email as trashed_by_email,
      roots.root_key
    FROM media_folders folders
    JOIN media_roots roots ON roots.id = folders.root_id
    LEFT JOIN users ON users.id = folders.trashed_by
    WHERE COALESCE(folders.trash_status, 'active') = 'trashed'
    ORDER BY folders.trashed_at DESC, folders.display_name_ar
  `).all();

  res.json({ items: [...folders, ...files] });
});

mediaRouter.post('/files/:fileId/trash', requireRole('admin', 'editor'), (req: Request, res: Response): void => {
  const db = getDb();
  const { reason } = req.body as { reason?: string };
  const file = db.prepare(`
    SELECT id, filename FROM media_files
    WHERE id=? AND COALESCE(trash_status, 'active') = 'active'
  `).get(req.params['fileId']) as { id: string; filename: string } | undefined;

  if (!file) {
    res.status(404).json({ error: 'Media file not found' });
    return;
  }

  db.prepare(`
    UPDATE media_files
    SET trash_status='trashed', trashed_at=datetime('now'), trashed_by=?, trash_reason=?
    WHERE id=?
  `).run(req.user!.id, cleanOptionalText(reason), file.id);

  auditLog(req.user!.id, req.user!.email, 'MEDIA_FILE_TRASH', 'media_file', file.id, file.filename, req.ip);
  res.json({ ok: true });
});

mediaRouter.post('/program-folders/:folderId/trash', requireRole('admin', 'editor'), (req: Request, res: Response): void => {
  const db = getDb();
  const { reason } = req.body as { reason?: string };
  const folder = db.prepare(`
    SELECT id, display_name_ar FROM media_folders
    WHERE id=? AND COALESCE(trash_status, 'active') = 'active'
  `).get(req.params['folderId']) as { id: string; display_name_ar: string } | undefined;

  if (!folder) {
    res.status(404).json({ error: 'Program folder not found' });
    return;
  }

  const folderIds = collectFolderTreeIds(db, folder.id);
  const placeholders = folderIds.map(() => '?').join(',');
  const trashFolder = db.transaction(() => {
    db.prepare(`
      UPDATE media_folders
      SET trash_status='trashed', trashed_at=datetime('now'), trashed_by=?, trash_reason=?
      WHERE id IN (${placeholders})
    `).run(req.user!.id, cleanOptionalText(reason), ...folderIds);
    db.prepare(`
      UPDATE media_files
      SET trash_status='trashed', trashed_at=datetime('now'), trashed_by=?, trash_reason=?
      WHERE folder_id IN (${placeholders})
    `).run(req.user!.id, cleanOptionalText(reason), ...folderIds);
  });

  trashFolder();
  auditLog(req.user!.id, req.user!.email, 'MEDIA_FOLDER_TRASH', 'media_folder', folder.id, folder.display_name_ar, req.ip);
  res.json({ ok: true, affectedFolders: folderIds.length });
});

mediaRouter.post('/trash/:kind/:id/restore', requireRole('admin', 'editor'), (req: Request, res: Response): void => {
  const kind = req.params['kind'];
  const id = req.params['id'];
  const db = getDb();

  if (kind === 'file') {
    const result = db.prepare(`
      UPDATE media_files
      SET trash_status='active', trashed_at=NULL, trashed_by=NULL, trash_reason=NULL
      WHERE id=? AND COALESCE(trash_status, 'active') = 'trashed'
    `).run(id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }
    auditLog(req.user!.id, req.user!.email, 'MEDIA_FILE_RESTORE', 'media_file', id, undefined, req.ip);
    res.json({ ok: true });
    return;
  }

  if (kind === 'folder') {
    const folder = db.prepare(`
      SELECT id FROM media_folders
      WHERE id=? AND COALESCE(trash_status, 'active') = 'trashed'
    `).get(id) as { id: string } | undefined;
    if (!folder) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }
    const folderIds = collectFolderTreeIds(db, folder.id);
    const placeholders = folderIds.map(() => '?').join(',');
    const restoreFolder = db.transaction(() => {
      db.prepare(`
        UPDATE media_folders
        SET trash_status='active', trashed_at=NULL, trashed_by=NULL, trash_reason=NULL
        WHERE id IN (${placeholders})
      `).run(...folderIds);
      db.prepare(`
        UPDATE media_files
        SET trash_status='active', trashed_at=NULL, trashed_by=NULL, trash_reason=NULL
        WHERE folder_id IN (${placeholders})
      `).run(...folderIds);
    });
    restoreFolder();
    auditLog(req.user!.id, req.user!.email, 'MEDIA_FOLDER_RESTORE', 'media_folder', id, undefined, req.ip);
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'Invalid trash item kind' });
});

mediaRouter.delete('/trash/:kind/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const kind = req.params['kind'];
  const id = req.params['id'];
  const { adminPassword } = req.body as { adminPassword?: string };
  const db = getDb();

  if (!verifyAdminPassword(db, req.user!.id, adminPassword)) {
    res.status(401).json({ error: 'Admin password is required' });
    return;
  }

  if (kind === 'file') {
    const file = db.prepare(`
      SELECT id, path, filename FROM media_files
      WHERE id=? AND COALESCE(trash_status, 'active') = 'trashed'
    `).get(id) as { id: string; path: string; filename: string } | undefined;
    if (!file) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }

    try {
      safeRemoveFile(file.path);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not delete media file' });
      return;
    }
    db.prepare('DELETE FROM media_files WHERE id=?').run(file.id);
    auditLog(req.user!.id, req.user!.email, 'MEDIA_FILE_DELETE_PERMANENT', 'media_file', file.id, file.filename, req.ip);
    res.json({ ok: true });
    return;
  }

  if (kind === 'folder') {
    const folder = db.prepare(`
      SELECT
        folders.id,
        folders.original_relative_path,
        folders.display_name_ar,
        roots.absolute_path as root_path
      FROM media_folders folders
      JOIN media_roots roots ON roots.id = folders.root_id
      WHERE folders.id=? AND COALESCE(folders.trash_status, 'active') = 'trashed'
    `).get(id) as { id: string; original_relative_path: string; display_name_ar: string; root_path: string } | undefined;
    if (!folder) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }

    const folderIds = collectFolderTreeIds(db, folder.id);
    const placeholders = folderIds.map(() => '?').join(',');
    const folderPath = joinRootRelativePath(folder.root_path, folder.original_relative_path);

    try {
      safeRemoveDirectory(folderPath);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not delete media folder' });
      return;
    }
    const deleteFolderRecords = db.transaction(() => {
      db.prepare(`DELETE FROM program_candidates WHERE folder_id IN (${placeholders})`).run(...folderIds);
      db.prepare(`DELETE FROM media_files WHERE folder_id IN (${placeholders})`).run(...folderIds);
      for (const folderId of [...folderIds].reverse()) {
        db.prepare('DELETE FROM media_folders WHERE id=?').run(folderId);
      }
    });
    deleteFolderRecords();
    auditLog(req.user!.id, req.user!.email, 'MEDIA_FOLDER_DELETE_PERMANENT', 'media_folder', folder.id, folder.display_name_ar, req.ip);
    res.json({ ok: true, affectedFolders: folderIds.length });
    return;
  }

  res.status(400).json({ error: 'Invalid trash item kind' });
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

type Db = ReturnType<typeof getDb>;

interface ByteRange {
  start: number;
  end: number;
}

function collectFolderTreeIds(db: Db, rootFolderId: string): string[] {
  const ids: string[] = [];
  const stack = [rootFolderId];
  const childStmt = db.prepare('SELECT id FROM media_folders WHERE parent_folder_id=?');

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || ids.includes(current)) continue;
    ids.push(current);

    const children = childStmt.all(current) as Array<{ id: string }>;
    for (const child of children) {
      stack.push(child.id);
    }
  }

  return ids;
}

function verifyAdminPassword(db: Db, userId: string, adminPassword: string | undefined): boolean {
  if (!adminPassword) return false;
  const user = db.prepare(`
    SELECT password_hash FROM users
    WHERE id=? AND role='admin' AND is_active=1
  `).get(userId) as { password_hash: string } | undefined;
  return !!user && verifyPassword(adminPassword, user.password_hash);
}

function cleanOptionalText(value: string | undefined): string | null {
  const clean = String(value ?? '').trim();
  return clean ? clean.slice(0, 500) : null;
}

function parseByteRange(rangeHeader: string, fileSize: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return null;

  let start: number;
  let end: number;

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : fileSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= fileSize) return null;

  return { start, end: Math.min(end, fileSize - 1) };
}

function streamMediaFile(req: Request, res: Response, filePath: string, filename: string): void {
  const stat = fs.statSync(filePath);
  const contentType = videoContentType(filePath);
  const range = req.headers.range;

  if (range) {
    const parsed = parseByteRange(range, stat.size);
    if (!parsed) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': parsed.end - parsed.start + 1,
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
    });
    fs.createReadStream(filePath, parsed).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size,
    'Content-Type': contentType,
    'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

function videoContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.ts') return 'video/mp2t';
  return 'application/octet-stream';
}

function safeRemoveFile(filePath: string): void {
  const targetPath = validateDeletablePath(filePath);
  if (!fs.existsSync(targetPath)) return;

  const stat = fs.statSync(targetPath);
  if (!stat.isFile()) {
    throw new Error('Trash item is not a file on disk');
  }
  fs.unlinkSync(targetPath);
}

function safeRemoveDirectory(folderPath: string): void {
  const targetPath = validateDeletablePath(folderPath);
  if (!fs.existsSync(targetPath)) return;

  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    throw new Error('Trash item is not a directory on disk');
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function validateDeletablePath(targetPath: string): string {
  if (!targetPath || targetPath.includes('\0')) {
    throw new Error('Invalid media path');
  }

  const resolvedTarget = fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath);
  const root = getAllowedDeleteRoots().find(rootPath => isPathInside(resolvedTarget, rootPath));
  if (!root) {
    throw new Error('Media path is outside allowed roots');
  }
  if (samePath(resolvedTarget, root)) {
    throw new Error('Deleting a media root is not allowed');
  }

  return resolvedTarget;
}

function isDeletablePathInsideAllowedRoot(targetPath: string): boolean {
  try {
    validateDeletablePath(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getAllowedDeleteRoots(): string[] {
  const roots = [
    ...listMediaRoots().map(root => root.absolute_path),
    config.paths.mediaLibrary,
    config.paths.mediaEmergency,
    config.gapFiller.mainStingPath,
    config.gapFiller.seasonalStingPath,
    config.gapFiller.generalBumpersPath,
  ].filter(Boolean);

  return Array.from(new Set(roots.map(root => fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root))));
}

function joinRootRelativePath(rootPath: string, relativePath: string): string {
  if (isPosixStylePath(rootPath)) {
    return path.posix.normalize(path.posix.join(rootPath, relativePath.replace(/\\/g, '/')));
  }
  return path.resolve(rootPath, relativePath);
}

function isPathInside(childPath: string, parentPath: string): boolean {
  if (isPosixStylePath(parentPath)) {
    const relative = path.posix.relative(
      path.posix.normalize(parentPath),
      path.posix.normalize(childPath.replace(/\\/g, '/'))
    );
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.posix.isAbsolute(relative));
  }

  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(a: string, b: string): boolean {
  if (isPosixStylePath(a) || isPosixStylePath(b)) {
    return path.posix.normalize(a.replace(/\\/g, '/')) === path.posix.normalize(b.replace(/\\/g, '/'));
  }
  return path.resolve(a) === path.resolve(b);
}

function isPosixStylePath(value: string): boolean {
  return value.startsWith('/') && !/^[a-zA-Z]:/.test(value);
}

function sendMediaBrowserError(res: Response, err: unknown): void {
  if (err instanceof MediaBrowserError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'Media browser request failed' });
}
