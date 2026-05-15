import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth, requireRole, auditLog } from '../../auth';
import { getDb } from '../../db/schema';
import { importScheduleFromJson, importScheduleFromCsv, importScheduleFromXlsx } from '../../schedule/importer';
import { validateSchedule, publishSchedule } from '../../schedule/validator';
import { buildDailyPlaylist, getPlaylistForDate, getCurrentAndNext } from '../../playlist/builder';
import { ensureDir, isSafeUploadMime, sanitizeFilename, preventPathTraversal } from '../../utils/fileUtils';
import { config } from '../../config';
import dayjs from 'dayjs';

export const scheduleRouter = Router();

const uploadDir = path.join(config.paths.data, 'uploads');
ensureDir(uploadDir);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.json', '.csv', '.xlsx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      cb(new Error(`Unsupported file type: ${ext}`));
      return;
    }
    if (!isSafeUploadMime(file.mimetype)) {
      cb(new Error(`Unsupported MIME type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

scheduleRouter.post(
  '/import',
  requireRole('admin', 'editor'),
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    const { name } = req.body as { name?: string };

    if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }

    const safeName = sanitizeFilename(file.originalname);
    const scheduleName = name || `Import ${dayjs().format('YYYY-MM-DD HH:mm')}`;
    const ext = path.extname(safeName).toLowerCase();

    try {
      let result;
      if (ext === '.json') {
        const raw = JSON.parse(fs.readFileSync(file.path, 'utf-8')) as unknown;
        result = importScheduleFromJson(raw, scheduleName, req.user!.id);
      } else if (ext === '.csv') {
        const content = fs.readFileSync(file.path, 'utf-8');
        result = importScheduleFromCsv(content, scheduleName, req.user!.id);
      } else if (ext === '.xlsx') {
        const buffer = fs.readFileSync(file.path);
        result = importScheduleFromXlsx(buffer, scheduleName, req.user!.id);
      } else {
        res.status(400).json({ error: `Unsupported format: ${ext}` });
        return;
      }

      fs.unlinkSync(file.path);
      auditLog(req.user!.id, req.user!.email, 'SCHEDULE_IMPORT', 'schedule', result.scheduleId, scheduleName, req.ip);
      res.status(201).json(result);
    } catch (err) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      res.status(400).json({ error: String(err) });
    }
  }
);

scheduleRouter.post('/validate/:id', requireRole('admin', 'editor'), (req: Request, res: Response): void => {
  try {
    const report = validateSchedule(req.params['id']!);
    auditLog(req.user!.id, req.user!.email, 'SCHEDULE_VALIDATE', 'schedule', req.params['id'], undefined, req.ip);
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

scheduleRouter.post('/publish/:id', requireRole('admin'), (req: Request, res: Response): void => {
  try {
    publishSchedule(req.params['id']!, req.user!.id);
    auditLog(req.user!.id, req.user!.email, 'SCHEDULE_PUBLISH', 'schedule', req.params['id'], undefined, req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

scheduleRouter.get('/', (_req: Request, res: Response): void => {
  const db = getDb();
  const schedules = db.prepare(`
    SELECT s.*, u.email as imported_by_email, p.email as published_by_email
    FROM schedules s
    LEFT JOIN users u ON s.imported_by = u.id
    LEFT JOIN users p ON s.published_by = p.id
    ORDER BY s.created_at DESC
  `).all();
  res.json({ schedules });
});

scheduleRouter.get('/:id', (req: Request, res: Response): void => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params['id']!);
  if (!schedule) { res.status(404).json({ error: 'Not found' }); return; }

  const items = db.prepare(`
    SELECT * FROM schedule_items WHERE schedule_id=? ORDER BY date, start_time
  `).all(req.params['id']!);

  res.json({ schedule, items });
});

scheduleRouter.get('/items/:date', (req: Request, res: Response): void => {
  const db = getDb();
  const { date } = req.params;
  const schedule = db.prepare('SELECT id FROM schedules WHERE status=\'published\' ORDER BY published_at DESC LIMIT 1').get() as { id: string } | undefined;
  if (!schedule) { res.json({ items: [] }); return; }

  const items = db.prepare('SELECT * FROM schedule_items WHERE schedule_id=? AND date=? ORDER BY start_time').all(schedule.id, date!);
  res.json({ items });
});

// Playlist routes
scheduleRouter.get('/playlist/:date', (req: Request, res: Response): void => {
  const playlist = getPlaylistForDate(req.params['date']!);
  if (!playlist) { res.status(404).json({ error: 'Playlist not found for this date. Run /build first.' }); return; }
  res.json(playlist);
});

scheduleRouter.post('/playlist/build/:date', requireRole('admin', 'editor', 'operator'), async (req: Request, res: Response): Promise<void> => {
  try {
    const playlist = await buildDailyPlaylist(req.params['date']!);
    auditLog(req.user!.id, req.user!.email, 'PLAYLIST_BUILD', 'playlist', undefined, req.params['date'], req.ip);
    res.json({ ok: true, itemCount: playlist.items.length, date: req.params['date'] });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
