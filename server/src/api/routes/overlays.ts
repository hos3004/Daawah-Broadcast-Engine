import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth, requireRole, auditLog } from '../../auth';
import { convertLogoSequenceToWebm } from '../../overlay/logoConverter';
import { generateTickerWebm, generateTickerMonth } from '../../overlay/tickerGenerator';
import { generateNowPlayingPng } from '../../overlay/nowPlayingGenerator';
import { getDb } from '../../db/schema';
import { config } from '../../config';
import { ensureDir, sanitizeFilename } from '../../utils/fileUtils';
import type { PlaylistItem } from '../../playlist/builder';

export const overlaysRouter = Router();
overlaysRouter.use(requireAuth);

const logoUploadDir = path.join(config.paths.assets, 'logo-source');
ensureDir(logoUploadDir);

const logoUpload = multer({
  dest: logoUploadDir,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      cb(new Error('Only PNG/JPG images allowed for logo'));
      return;
    }
    cb(null, true);
  },
});

overlaysRouter.post(
  '/logo/upload',
  requireRole('admin', 'editor'),
  logoUpload.array('frames', 5000),
  (req: Request, res: Response): void => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) { res.status(400).json({ error: 'No files uploaded' }); return; }
    auditLog(req.user!.id, req.user!.email, 'LOGO_UPLOAD', 'overlay', undefined, `${files.length} frames`, req.ip);
    res.json({ ok: true, frameCount: files.length, uploadDir: logoUploadDir });
  }
);

overlaysRouter.post('/logo/convert', requireRole('admin', 'editor'), async (req: Request, res: Response): Promise<void> => {
  const { source_path, fps } = req.body as { source_path?: string; fps?: number };
  const sourcePath = source_path ?? logoUploadDir;

  try {
    const result = await convertLogoSequenceToWebm(sourcePath, fps ?? 25);
    auditLog(req.user!.id, req.user!.email, 'LOGO_CONVERT', 'overlay', undefined, result.outputPath, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

overlaysRouter.post('/ticker/generate/:date', requireRole('admin', 'editor', 'operator'), async (req: Request, res: Response): Promise<void> => {
  const { date } = req.params;
  try {
    const result = await generateTickerWebm(date!);
    auditLog(req.user!.id, req.user!.email, 'TICKER_GENERATE', 'overlay', undefined, date, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

overlaysRouter.post('/ticker/generate-month', requireRole('admin', 'editor'), async (req: Request, res: Response): Promise<void> => {
  const { year_month } = req.body as { year_month?: string };
  if (!year_month || !/^\d{4}-\d{2}$/.test(year_month)) {
    res.status(400).json({ error: 'year_month must be YYYY-MM' });
    return;
  }
  res.json({ ok: true, message: `Generating tickers for ${year_month} in background` });
  generateTickerMonth(year_month).catch(err => console.error('Ticker month generation failed:', err));
  auditLog(req.user!.id, req.user!.email, 'TICKER_GENERATE_MONTH', 'overlay', undefined, year_month, req.ip);
});

overlaysRouter.post('/now-playing/:playlistItemId', requireRole('admin', 'editor', 'operator'), async (req: Request, res: Response): Promise<void> => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM playlist_items WHERE id=?').get(req.params['playlistItemId']!) as PlaylistItem | undefined;

  if (!item) { res.status(404).json({ error: 'Playlist item not found' }); return; }

  try {
    const pngPath = await generateNowPlayingPng(item);
    db.prepare('UPDATE playlist_items SET lower_third_path=?, show_lower_third=1 WHERE id=?')
      .run(pngPath, item.id);
    auditLog(req.user!.id, req.user!.email, 'NOW_PLAYING_GENERATE', 'overlay', item.id, undefined, req.ip);
    res.json({ ok: true, pngPath });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

overlaysRouter.get('/preview/ticker/:date', requireAuth, (req: Request, res: Response): void => {
  const webmPath = path.join(config.paths.assets, 'overlays', 'tickers', `${req.params['date']!}.webm`);
  const pngPath = path.join(config.paths.assets, 'overlays', 'tickers', `${req.params['date']!}.png`);

  if (fs.existsSync(webmPath)) {
    res.sendFile(webmPath);
  } else if (fs.existsSync(pngPath)) {
    res.sendFile(pngPath);
  } else {
    res.status(404).json({ error: 'Ticker not generated yet' });
  }
});

overlaysRouter.get('/list', requireAuth, (req: Request, res: Response): void => {
  const db = getDb();
  const assets = db.prepare('SELECT * FROM overlay_assets ORDER BY created_at DESC LIMIT 100').all();
  res.json({ assets });
});
