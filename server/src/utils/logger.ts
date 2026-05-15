import fs from 'fs';
import path from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LOG_LEVEL: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) ?? 'info';
const LOG_PATH = process.env['LOG_PATH'] ?? './logs';

let logStream: fs.WriteStream | null = null;

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_PATH)) {
      fs.mkdirSync(LOG_PATH, { recursive: true });
    }
    if (!logStream) {
      const logFile = path.join(LOG_PATH, 'app.log');
      logStream = fs.createWriteStream(logFile, { flags: 'a' });
    }
  } catch {
    // ignore
  }
}

function write(level: LogLevel, msg: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;

  const ts = new Date().toISOString();
  const metaStr = meta !== undefined ? ' ' + JSON.stringify(meta) : '';
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}`;

  const colored = colorize(level, line);
  console.log(colored);

  ensureLogDir();
  logStream?.write(line + '\n');
}

function colorize(level: LogLevel, line: string): string {
  if (process.env['NO_COLOR']) return line;
  const colors: Record<LogLevel, string> = {
    debug: '\x1b[36m',
    info:  '\x1b[32m',
    warn:  '\x1b[33m',
    error: '\x1b[31m',
  };
  return colors[level] + line + '\x1b[0m';
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write('debug', msg, meta),
  info:  (msg: string, meta?: unknown) => write('info',  msg, meta),
  warn:  (msg: string, meta?: unknown) => write('warn',  msg, meta),
  error: (msg: string, meta?: unknown) => write('error', msg, meta),
};
