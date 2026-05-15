import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { logger } from '../utils/logger';
import { verifyToken } from '../auth';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export function initWs(httpServer: Server): void {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    logger.debug(`WS client connected: ${ip}`);
    clients.add(ws);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string; token?: string };
        if (msg.type === 'auth' && msg.token) {
          const payload = verifyToken(msg.token);
          if (payload) {
            (ws as WebSocket & { authenticated?: boolean }).authenticated = true;
            ws.send(JSON.stringify({ type: 'auth_ok', data: { role: payload.role } }));
          } else {
            ws.send(JSON.stringify({ type: 'auth_error' }));
          }
        }
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.debug(`WS client disconnected: ${ip}`);
    });

    ws.on('error', (err) => {
      logger.error('WS client error', err);
      clients.delete(ws);
    });

    ws.send(JSON.stringify({ type: 'connected', data: { serverTime: new Date().toISOString() } }));
  });

  logger.info('WebSocket server initialized on /ws');
}

export function broadcastWs(message: { type: string; data?: unknown }): void {
  if (!wss) return;
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function getWsClientCount(): number {
  return clients.size;
}
