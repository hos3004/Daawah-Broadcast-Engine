import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function optionalInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return n;
}

const appRoot = path.resolve(__dirname, '../../..');

export const config = {
  env: optional('NODE_ENV', 'development') as 'development' | 'production' | 'test',
  port: optionalInt('PORT', 3000),
  host: optional('HOST', '127.0.0.1'),

  security: {
    jwtSecret: optional('JWT_SECRET', 'dev-secret-change-in-production'),
    cookieSecret: optional('COOKIE_SECRET', 'dev-cookie-secret'),
    corsOrigin: optional('CORS_ORIGIN', 'http://localhost:5173'),
    bcryptRounds: optionalInt('BCRYPT_ROUNDS', 12),
  },

  db: {
    path: optional('DB_PATH', path.join(appRoot, 'data', 'daawah.db')),
  },

  paths: {
    mediaLibrary: optional('MEDIA_LIBRARY_PATH', path.join(appRoot, 'media', 'library')),
    mediaEmergency: optional('MEDIA_EMERGENCY_PATH', path.join(appRoot, 'media', 'emergency')),
    hlsOutput: optional('HLS_OUTPUT_PATH', path.join(appRoot, 'hls')),
    logs: optional('LOG_PATH', path.join(appRoot, 'logs')),
    data: optional('DATA_PATH', path.join(appRoot, 'data')),
    assets: optional('ASSETS_PATH', path.join(appRoot, 'assets')),
    playlists: optional('PLAYLISTS_PATH', path.join(appRoot, 'data', 'playlists')),
  },

  ffmpeg: {
    ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: optional('FFPROBE_PATH', 'ffprobe'),
  },

  broadcast: {
    resolution: optional('BROADCAST_RESOLUTION', '1280x720'),
    fps: optionalInt('BROADCAST_FPS', 25),
    videoBitrate: optional('BROADCAST_VIDEO_BITRATE', '2500k'),
    audioBitrate: optional('BROADCAST_AUDIO_BITRATE', '192k'),
    audioRate: optionalInt('BROADCAST_AUDIO_RATE', 48000),
    hlsSegmentDuration: optionalInt('HLS_SEGMENT_DURATION', 4),
    hlsListSize: optionalInt('HLS_LIST_SIZE', 10),
    rtmpEnabled: optionalBool('RTMP_ENABLED', false),
    rtmpUrl: optional('RTMP_URL', ''),
  },

  overlay: {
    fontPath: optional('OVERLAY_FONT_PATH', path.join(appRoot, 'assets', 'fonts', 'NotoSansArabic-Regular.ttf')),
    logoLoopPath: optional('OVERLAY_LOGO_LOOP_PATH', path.join(appRoot, 'assets', 'overlays', 'logo', 'logo-loop.webm')),
    logoPosition: optional('OVERLAY_LOGO_POSITION', '10:10'),
    tickerHeight: optionalInt('TICKER_HEIGHT', 60),
    tickerFontSize: optionalInt('TICKER_FONT_SIZE', 32),
    tickerTextColor: optional('TICKER_TEXT_COLOR', '#FFFFFF'),
    tickerBgColor: optional('TICKER_BG_COLOR', '#00000099'),
    tickerSpeed: optionalInt('TICKER_SPEED', 80),
    tickerSafeMargin: optionalInt('TICKER_SAFE_MARGIN', 20),
    nowPlayingDuration: optionalInt('NOW_PLAYING_DURATION', 10),
    nowPlayingFontSize: optionalInt('NOW_PLAYING_FONT_SIZE', 36),
    nowPlayingPosition: optional('NOW_PLAYING_POSITION', 'left') as 'left' | 'center' | 'right',
  },

  playlist: {
    buildHour: optionalInt('PLAYLIST_BUILD_HOUR', 23),
    lookahead: optionalInt('PLAYLIST_LOOKAHEAD', 3),
  },

  gapFiller: {
    mainStingPath: optional('GAP_MAIN_STING_PATH', '/srv/daawah/media/bumpers/logo-sting'),
    seasonalStingPath: optional('GAP_SEASONAL_STING_PATH', '/srv/daawah/media/bumpers/sting-hag'),
    generalBumpersPath: optional('GAP_GENERAL_BUMPERS_PATH', '/srv/daawah/media/bumpers/general'),
    pattern: optional('GAP_PATTERN', 'main,seasonal,general,general,general'),
    minFillMs: optionalInt('GAP_MIN_FILL_MS', 1000),
  },

  monitoring: {
    healthCheckInterval: optionalInt('HEALTH_CHECK_INTERVAL', 30000),
    hlsStaleThreshold: optionalInt('HLS_STALE_THRESHOLD', 30),
    diskAlertThreshold: optionalInt('DISK_ALERT_THRESHOLD', 85),
  },

  telegram: {
    enabled: optionalBool('TELEGRAM_ENABLED', false),
    botToken: optional('TELEGRAM_BOT_TOKEN', ''),
    chatId: optional('TELEGRAM_CHAT_ID', ''),
  },

  rateLimit: {
    windowMs: optionalInt('AUTH_RATE_LIMIT_WINDOW_MS', 900000),
    max: optionalInt('AUTH_RATE_LIMIT_MAX', 10),
  },

  transcode: {
    threads: optionalInt('TRANSCODE_THREADS', 2),
  },

  admin: {
    email: optional('ADMIN_EMAIL', 'admin@daawah.local'),
    password: optional('ADMIN_PASSWORD', 'changeme'),
  },
} as const;

export type Config = typeof config;
