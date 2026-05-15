import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { requireAuth, requireRole } from '../../auth';
import { getDb } from '../../db/schema';
import { checkFfmpeg, checkFfprobe } from '../../media/ffprobe';
import { checkHlsHealth, getBroadcastState } from '../../broadcast/ffmpegRunner';
import { config } from '../../config';
import { diskUsage, formatBytes } from '../../utils/fileUtils';
import { getWsClientCount } from '../../ws';

export const systemRouter = Router();

// Public health endpoint
systemRouter.get('/health', async (_req: Request, res: Response): Promise<void> => {
  const [ffmpegOk, ffprobeOk] = await Promise.all([checkFfmpeg(), checkFfprobe()]);
  const hls = checkHlsHealth();
  const broadcast = getBroadcastState();

  const ok = ffmpegOk && ffprobeOk;

  res.status(ok ? 200 : 503).json({
    ok,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    broadcast: broadcast.status,
    hls: hls.ok ? 'ok' : `stale (${Math.round(hls.ageSeconds)}s)`,
    ffmpeg: ffmpegOk ? 'ok' : 'missing',
    ffprobe: ffprobeOk ? 'ok' : 'missing',
    ws_clients: getWsClientCount(),
  });
});

systemRouter.use(requireAuth);

systemRouter.get('/disk', (_req: Request, res: Response): void => {
  const mediaDisk = diskUsage(config.paths.mediaLibrary);
  const hlsDisk = diskUsage(config.paths.hlsOutput);

  res.json({
    media: { ...mediaDisk, usedStr: formatBytes(mediaDisk.used), totalStr: formatBytes(mediaDisk.total) },
    hls:   { ...hlsDisk,   usedStr: formatBytes(hlsDisk.used),   totalStr: formatBytes(hlsDisk.total) },
    mem: {
      total: os.totalmem(),
      free: os.freemem(),
      percent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    },
    cpu: os.loadavg(),
  });
});

systemRouter.get('/logs', requireRole('admin', 'operator'), (req: Request, res: Response): void => {
  const { type = 'app', lines = '100' } = req.query as Record<string, string>;
  const logDir = config.paths.logs;

  const files: Record<string, string> = {
    app: 'app.log',
    ffmpeg: `ffmpeg-${new Date().toISOString().slice(0, 10)}.log`,
  };

  const filename = files[type] ?? 'app.log';
  const logPath = path.join(logDir, filename);

  if (!fs.existsSync(logPath)) {
    res.json({ lines: [], file: filename });
    return;
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const allLines = content.split('\n').filter(Boolean);
  const n = Math.min(parseInt(lines, 10) || 100, 1000);
  res.json({ lines: allLines.slice(-n), file: filename, total: allLines.length });
});

systemRouter.get('/audit', requireRole('admin'), (req: Request, res: Response): void => {
  const db = getDb();
  const { limit = '50', offset = '0' } = req.query as Record<string, string>;
  const entries = db.prepare(`
    SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(parseInt(limit, 10), parseInt(offset, 10));
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get() as { cnt: number }).cnt;
  res.json({ entries, total });
});

systemRouter.get('/settings', requireRole('admin'), (_req: Request, res: Response): void => {
  const db = getDb();
  const settings = db.prepare('SELECT * FROM settings').all();
  res.json({ settings });
});

systemRouter.put('/settings/:key', requireRole('admin'), (req: Request, res: Response): void => {
  const db = getDb();
  const { key } = req.params;
  const { value } = req.body as { value?: string };
  if (!value) { res.status(400).json({ error: 'value required' }); return; }

  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_by) VALUES (?,?,?)')
    .run(key!, value, req.user!.id);
  res.json({ ok: true });
});
