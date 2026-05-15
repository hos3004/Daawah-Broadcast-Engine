import { Router, Request, Response } from 'express';
import dayjs from 'dayjs';
import { requireAuth, requireRole, auditLog } from '../../auth';
import { startBroadcast, stopBroadcast, restartBroadcast, switchToEmergency, getBroadcastState, checkHlsHealth } from '../../broadcast/ffmpegRunner';
import { getCurrentAndNext } from '../../playlist/builder';

export const broadcastRouter = Router();
broadcastRouter.use(requireAuth);

broadcastRouter.post('/start', requireRole('admin', 'operator'), async (req: Request, res: Response): Promise<void> => {
  try {
    await startBroadcast(false);
    auditLog(req.user!.id, req.user!.email, 'BROADCAST_START', 'broadcast', undefined, undefined, req.ip);
    res.json({ ok: true, status: getBroadcastState() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

broadcastRouter.post('/stop', requireRole('admin', 'operator'), async (req: Request, res: Response): Promise<void> => {
  try {
    await stopBroadcast('manual');
    auditLog(req.user!.id, req.user!.email, 'BROADCAST_STOP', 'broadcast', undefined, undefined, req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

broadcastRouter.post('/restart', requireRole('admin', 'operator'), async (req: Request, res: Response): Promise<void> => {
  try {
    await restartBroadcast();
    auditLog(req.user!.id, req.user!.email, 'BROADCAST_RESTART', 'broadcast', undefined, undefined, req.ip);
    res.json({ ok: true, status: getBroadcastState() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

broadcastRouter.post('/emergency', requireRole('admin', 'operator'), async (req: Request, res: Response): Promise<void> => {
  try {
    await switchToEmergency();
    auditLog(req.user!.id, req.user!.email, 'BROADCAST_EMERGENCY', 'broadcast', undefined, undefined, req.ip);
    res.json({ ok: true, status: getBroadcastState() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

broadcastRouter.get('/status', (_req: Request, res: Response): void => {
  const state = getBroadcastState();
  const hls = checkHlsHealth();
  res.json({ ...state, hls });
});

broadcastRouter.get('/now', (_req: Request, res: Response): void => {
  const date = dayjs().format('YYYY-MM-DD');
  const { current, next, lookahead } = getCurrentAndNext(date);
  res.json({ current, next, lookahead, timestamp: Date.now() });
});

broadcastRouter.get('/next', (_req: Request, res: Response): void => {
  const date = dayjs().format('YYYY-MM-DD');
  const { next } = getCurrentAndNext(date);
  res.json({ next });
});
