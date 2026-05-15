import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { requireRole } from '../../auth';
import { getDb } from '../../db/schema';
import { config } from '../../config';
import { diskUsage, formatBytes } from '../../utils/fileUtils';
import { getWsClientCount } from '../../ws';

export const systemRouter = Router();

// All routes in this router require auth (applied at app level in index.ts)

systemRouter.get('/disk', (_req: Request, res: Response): void => {
  const mediaDisk = diskUsage(config.paths.mediaLibrary);
  const hlsDisk   = diskUsage(config.paths.hlsOutput);

  res.json({
    media: { ...mediaDisk, usedStr: formatBytes(mediaDisk.used), totalStr: formatBytes(mediaDisk.total) },
    hls:   { ...hlsDisk,   usedStr: formatBytes(hlsDisk.used),   totalStr: formatBytes(hlsDisk.total) },
    mem: {
      total: os.totalmem(),
      free:  os.freemem(),
      percent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    },
    cpu: os.loadavg(),
    wsClients: getWsClientCount(),
  });
});

systemRouter.get('/logs', requireRole('admin', 'operator'), (req: Request, res: Response): void => {
  const { type = 'app', lines = '100' } = req.query as Record<string, string>;
  const logDir = config.paths.logs;

  const fileMap: Record<string, string> = {
    app:    'app.log',
    ffmpeg: `ffmpeg-${new Date().toISOString().slice(0, 10)}.log`,
  };

  const filename = fileMap[type] ?? 'app.log';
  const logPath  = path.join(logDir, filename);

  if (!fs.existsSync(logPath)) {
    res.json({ lines: [], file: filename, total: 0 });
    return;
  }

  const content  = fs.readFileSync(logPath, 'utf-8');
  const allLines = content.split('\n').filter(Boolean);
  const n        = Math.min(parseInt(lines, 10) || 100, 1000);

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
  const db  = getDb();
  const key = req.params['key'];
  const { value } = req.body as { value?: string };
  if (!value || !key) { res.status(400).json({ error: 'key and value required' }); return; }
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_by) VALUES (?,?,?)')
    .run(key, value, req.user!.id);
  res.json({ ok: true });
});
