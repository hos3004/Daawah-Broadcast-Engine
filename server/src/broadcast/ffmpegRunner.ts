import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ensureDir } from '../utils/fileUtils';
import { getDb } from '../db/schema';
import { getPlaylistForDate, getCurrentAndNext, type PlaylistItem } from '../playlist/builder';
import { checkEmergencyReadiness } from '../media/scanner';
import { broadcastWs } from '../ws';

export type BroadcastStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error' | 'emergency';

interface BroadcastState {
  status: BroadcastStatus;
  runId: string | null;
  pid: number | null;
  startedAt: string | null;
  currentItem: PlaylistItem | null;
  nextItem: PlaylistItem | null;
  playlistArtifactRunId: string | null;
  artifactItems: PlaylistItem[] | null;
  restartCount: number;
  lastError: string | null;
  isEmergency: boolean;
}

const state: BroadcastState = {
  status: 'idle',
  runId: null,
  pid: null,
  startedAt: null,
  currentItem: null,
  nextItem: null,
  playlistArtifactRunId: null,
  artifactItems: null,
  restartCount: 0,
  lastError: null,
  isEmergency: false,
};

let ffmpegProcess: ChildProcess | null = null;
let logStream: fs.WriteStream | null = null;
let statusInterval: NodeJS.Timeout | null = null;
let restartTimeout: NodeJS.Timeout | null = null;

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 5000;
const RESTART_BACKOFF_MULTIPLIER = 1.5;

interface PreparedArtifactBroadcast {
  runId: string;
  items: PlaylistItem[];
  current: PlaylistItem | null;
  next: PlaylistItem | null;
  command: { args: string[] };
}

export function getBroadcastState(): BroadcastState {
  return { ...state };
}

export async function startBroadcast(emergency = false): Promise<void> {
  if (state.status === 'running' || state.status === 'starting') {
    throw new Error('Broadcast already running');
  }

  // Preflight: refuse to start if emergency fallback has no files present on disk
  const emergencyCheck = checkEmergencyReadiness();
  if (!emergencyCheck.ok) {
    let msg: string;
    if (emergencyCheck.dbCount === 0) {
      msg = 'Preflight failed: no emergency media in DB (run a media scan first)';
    } else {
      msg = `Preflight failed: ${emergencyCheck.missingPaths.length} emergency file(s) in DB are missing from disk — rescan needed`;
    }
    logger.error(msg);
    state.status = 'error';
    state.lastError = msg;
    emitStatus();
    throw new Error(msg);
  }

  state.isEmergency = emergency;
  state.playlistArtifactRunId = null;
  state.artifactItems = null;
  state.status = 'starting';
  state.restartCount = 0;
  emitStatus();

  await launchFfmpeg(emergency);
}

export async function startPlaylistArtifactBroadcast(playlistRunId: string): Promise<void> {
  if (state.status === 'running' || state.status === 'starting') {
    throw new Error('Broadcast already running');
  }

  const prepared = preparePlaylistArtifactBroadcast(playlistRunId);

  const emergencyCheck = checkEmergencyReadiness();
  if (!emergencyCheck.ok) {
    const msg = emergencyCheck.dbCount === 0
      ? 'Preflight failed: no emergency media in DB (run a media scan first)'
      : `Preflight failed: ${emergencyCheck.missingPaths.length} emergency file(s) in DB are missing from disk — rescan needed`;
    logger.error(msg);
    state.status = 'error';
    state.lastError = msg;
    emitStatus();
    throw new Error(msg);
  }

  state.isEmergency = false;
  state.playlistArtifactRunId = prepared.runId;
  state.artifactItems = prepared.items;
  state.status = 'starting';
  state.restartCount = 0;
  emitStatus();

  await launchFfmpeg(false, prepared);
}

export async function stopBroadcast(reason = 'manual'): Promise<void> {
  if (restartTimeout) {
    clearTimeout(restartTimeout);
    restartTimeout = null;
  }

  state.status = 'stopping';
  emitStatus();

  if (ffmpegProcess && ffmpegProcess.pid) {
    ffmpegProcess.removeAllListeners();
    ffmpegProcess.kill('SIGTERM');
    await new Promise<void>(resolve => setTimeout(resolve, 2000));
    if (ffmpegProcess && !ffmpegProcess.killed) {
      ffmpegProcess.kill('SIGKILL');
    }
  }

  if (state.runId) {
    getDb().prepare('UPDATE broadcast_runs SET status=?, stopped_at=datetime(\'now\'), stop_reason=? WHERE id=?')
      .run('idle', reason, state.runId);
  }

  ffmpegProcess = null;
  logStream?.end();
  logStream = null;
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }

  state.status = 'idle';
  state.pid = null;
  state.startedAt = null;
  state.runId = null;
  state.currentItem = null;
  state.nextItem = null;
  state.playlistArtifactRunId = null;
  state.artifactItems = null;
  emitStatus();

  logger.info(`Broadcast stopped: ${reason}`);
}

export async function restartBroadcast(): Promise<void> {
  await stopBroadcast('restart');
  await new Promise(r => setTimeout(r, 1000));
  await startBroadcast(state.isEmergency);
}

export async function switchToEmergency(): Promise<void> {
  logger.warn('Switching to emergency broadcast');
  await stopBroadcast('emergency');
  await new Promise(r => setTimeout(r, 500));
  await startBroadcast(true);
}

const MIN_SAFE_HLS_PATH_LENGTH = 10; // e.g. "/var/x/hls" — refuse to clean suspiciously short paths

function isHlsDirSafe(hlsDir: string): boolean {
  if (!hlsDir || hlsDir.trim() === '') return false;
  const resolved = path.resolve(hlsDir);
  if (resolved === '/' || resolved === path.sep) return false;
  if (resolved.length < MIN_SAFE_HLS_PATH_LENGTH) return false;
  // Must not be a filesystem root or common sensitive directory
  const dangerousPaths = ['/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/home', '/root', '/tmp'];
  if (dangerousPaths.includes(resolved)) return false;
  return true;
}

function cleanHlsOutput(): void {
  const hlsDir = config.paths.hlsOutput;

  if (!isHlsDirSafe(hlsDir)) {
    logger.error(`HLS cleanup refused: unsafe or too-short path "${hlsDir}" — skipping cleanup`);
    return;
  }

  if (!fs.existsSync(hlsDir)) return;

  try {
    let cleaned = 0;
    for (const f of fs.readdirSync(hlsDir)) {
      if (f === 'stream.m3u8' || (f.startsWith('seg') && f.endsWith('.ts'))) {
        const full = path.join(hlsDir, f);
        // Double-check: resolved path must remain inside hlsDir
        if (path.resolve(full).startsWith(path.resolve(hlsDir))) {
          fs.unlinkSync(full);
          cleaned++;
        }
      }
    }
    logger.info(`HLS output cleaned: ${cleaned} file(s) removed before start`);
  } catch (err) {
    logger.warn(`HLS cleanup error: ${err}`);
  }
}

async function launchFfmpeg(emergency: boolean, preparedArtifact?: PreparedArtifactBroadcast): Promise<void> {
  const date = dayjs().format('YYYY-MM-DD');
  let current: PlaylistItem | null = null;
  let next: PlaylistItem | null = null;
  let cmd: { args: string[] } | null = null;

  if (!emergency && (preparedArtifact || state.playlistArtifactRunId)) {
    const prepared = preparedArtifact ?? preparePlaylistArtifactBroadcast(state.playlistArtifactRunId!);
    state.playlistArtifactRunId = prepared.runId;
    state.artifactItems = prepared.items;
    current = prepared.current;
    next = prepared.next;
    cmd = prepared.command;
  } else {
    const live = getCurrentAndNext(date);
    current = live.current;
    next = live.next;
    cmd = emergency
      ? buildEmergencyCommand()
      : buildBroadcastCommand(date, current);
  }

  if (!cmd) {
    logger.error('Could not build FFmpeg command — no media available');
    state.status = 'error';
    state.lastError = 'No media available';
    emitStatus();
    return;
  }

  ensureDir(config.paths.hlsOutput);
  ensureDir(config.paths.logs);

  // Clean stale HLS files so viewers get a fresh stream, not leftovers
  cleanHlsOutput();

  const logFile = path.join(config.paths.logs, `ffmpeg-${dayjs().format('YYYY-MM-DD')}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });

  logger.info(`Launching FFmpeg: ${cmd.args.join(' ').slice(0, 200)}...`);

  const runId = uuidv4();
  state.runId = runId;

  getDb().prepare(`
    INSERT INTO broadcast_runs (id, status, started_at, ffmpeg_cmd)
    VALUES (?, 'running', datetime('now'), ?)
  `).run(runId, cmd.args.join(' '));

  ffmpegProcess = spawn(config.ffmpeg.ffmpegPath, cmd.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.pid = ffmpegProcess.pid ?? null;
  state.startedAt = new Date().toISOString();
  state.status = 'running';
  state.currentItem = current;
  state.nextItem = next;
  emitStatus();

  ffmpegProcess.stdout?.on('data', (data: Buffer) => {
    logStream?.write(data);
  });

  ffmpegProcess.stderr?.on('data', (data: Buffer) => {
    logStream?.write(data);
  });

  ffmpegProcess.on('close', (code) => {
    logStream?.write(`\n[exit code: ${code}]\n`);
    handleFfmpegExit(code ?? -1);
  });

  ffmpegProcess.on('error', (err) => {
    logger.error('FFmpeg process error', err);
    state.lastError = err.message;
    handleFfmpegExit(-1);
  });

  // Periodic status update
  statusInterval = setInterval(updateCurrentItem, 5000);
}

function handleFfmpegExit(code: number): void {
  ffmpegProcess = null;
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }

  if (state.status === 'stopping' || state.status === 'idle') return;

  // Exit 0 = playlist exhausted naturally (day rollover or end of concat list)
  if (code === 0) {
    logger.info('FFmpeg exited cleanly (playlist complete) — rolling over to next day playlist');

    if (state.runId) {
      // 'complete' is not in the DB CHECK constraint — use 'idle' with stop_reason to record clean end
      getDb().prepare('UPDATE broadcast_runs SET status=?, stopped_at=datetime(\'now\'), stop_reason=? WHERE id=?')
        .run('idle', 'playlist_complete', state.runId);
    }

    state.restartCount = 0;
    state.status = 'starting';
    emitStatus();

    // Short delay so the new day's playlist file is ready (built at 23:00)
    restartTimeout = setTimeout(() => {
      logger.info('Day rollover restart');
      launchFfmpeg(false).catch(e => logger.error('Rollover restart failed', e));
    }, 2000);
    return;
  }

  logger.error(`FFmpeg exited with code ${code}. Restarts: ${state.restartCount}/${MAX_RESTART_ATTEMPTS}`);

  if (state.runId) {
    getDb().prepare('UPDATE broadcast_runs SET status=?, stopped_at=datetime(\'now\'), stop_reason=?, error_msg=? WHERE id=?')
      .run('error', `exit:${code}`, `Exit code ${code}`, state.runId);
  }

  broadcastWs({ type: 'alert', data: { level: 'error', message: `FFmpeg stopped (exit ${code})` } });

  if (state.restartCount >= MAX_RESTART_ATTEMPTS) {
    logger.error('Max restart attempts reached — switching to emergency');
    state.status = 'error';
    state.lastError = `FFmpeg died ${MAX_RESTART_ATTEMPTS} times`;
    emitStatus();
    switchToEmergency().catch(e => logger.error('Emergency switch failed', e));
    return;
  }

  const delay = RESTART_DELAY_MS * Math.pow(RESTART_BACKOFF_MULTIPLIER, state.restartCount);
  state.restartCount++;
  state.status = 'starting';
  emitStatus();

  logger.info(`Restarting FFmpeg in ${Math.round(delay)}ms (attempt ${state.restartCount})`);
  restartTimeout = setTimeout(() => {
    launchFfmpeg(state.isEmergency).catch(e => logger.error('Restart failed', e));
  }, delay);
}

function buildBroadcastCommand(date: string, current: PlaylistItem | null): { args: string[] } | null {
  const playlist = getPlaylistForDate(date);

  if (!playlist || playlist.items.length === 0) {
    logger.warn(`No playlist for ${date} — using emergency`);
    return buildEmergencyCommand();
  }

  return buildBroadcastCommandFromItems(playlist.items, current, date);
}

function buildBroadcastCommandFromItems(items: PlaylistItem[], current: PlaylistItem | null, date: string): { args: string[] } | null {
  const now = Date.now();
  const remaining = items.filter(i => i.end_time_ms > now);

  if (remaining.length === 0) {
    return buildEmergencyCommand();
  }

  // Preflight: drop items whose files don't exist on disk
  const available = remaining.filter(i => {
    if (!fs.existsSync(i.media_path)) {
      logger.warn(`Preflight: missing file skipped — ${i.media_path}`);
      return false;
    }
    return true;
  });

  if (available.length === 0) {
    logger.error('Preflight: all playlist files missing — using emergency');
    return buildEmergencyCommand();
  }

  if (available.length < remaining.length) {
    logger.warn(`Preflight: ${remaining.length - available.length} of ${remaining.length} playlist items missing`);
  }

  // Build FFmpeg concat input — -re for real-time pacing
  const concatListPath = path.join(config.paths.data, 'current-concat.txt');
  fs.writeFileSync(concatListPath, buildConcatFileContents(available), 'utf-8');

  const broadcastRes = config.broadcast.resolution.split('x');
  const w = broadcastRes[0] ?? '1280';
  const h = broadcastRes[1] ?? '720';

  const hlsPath = path.join(config.paths.hlsOutput, 'stream.m3u8');
  const segPattern = path.join(config.paths.hlsOutput, 'seg%05d.ts');

  const logoPath = config.overlay.logoLoopPath;
  const hasLogo = fs.existsSync(logoPath);

  const tickerPath = path.join(config.paths.assets, 'overlays', 'tickers', `${date}.webm`);
  const hasTicker = fs.existsSync(tickerPath);

  // Now-playing PNG (lower third): shown for first N seconds of the session
  const nowPlayingPath = current?.lower_third_path ?? null;
  const hasNowPlaying = nowPlayingPath !== null && fs.existsSync(nowPlayingPath);

  // Build filter_complex
  // -re before -i for real-time pacing
  const inputs: string[] = [
    '-re', '-f', 'concat', '-safe', '0', '-i', concatListPath,
  ];

  let filterComplex = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${config.broadcast.fps},settb=1/${config.broadcast.fps}[base]`;
  let lastLabel = '[base]';
  let inputIdx = 1;

  if (hasNowPlaying) {
    inputs.push('-loop', '1', '-i', nowPlayingPath!);
    const duration = config.overlay.nowPlayingDuration;
    filterComplex += `;${lastLabel}[${inputIdx}:v]overlay=10:H-h-80:enable='between(t,0,${duration})'[np]`;
    lastLabel = '[np]';
    inputIdx++;
  }

  if (hasLogo) {
    inputs.push('-stream_loop', '-1', '-i', logoPath);
    filterComplex += `;${lastLabel}[${inputIdx}:v]overlay=${config.overlay.logoPosition}:shortest=0[logo]`;
    lastLabel = '[logo]';
    inputIdx++;
  }

  if (hasTicker) {
    const ty = parseInt(h, 10) - config.overlay.tickerHeight - 10;
    inputs.push('-stream_loop', '-1', '-i', tickerPath);
    filterComplex += `;${lastLabel}[${inputIdx}:v]overlay=0:${ty}:shortest=0[ticker]`;
    lastLabel = '[ticker]';
    inputIdx++;
  }

  filterComplex += `;${lastLabel}null[vout]`;

  const args: string[] = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', config.broadcast.videoBitrate,
    '-maxrate', config.broadcast.videoBitrate,
    '-bufsize', '5000k',
    '-pix_fmt', 'yuv420p',
    '-g', String(config.broadcast.fps * 2),
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', config.broadcast.audioBitrate,
    '-ar', String(config.broadcast.audioRate),
    '-ac', '2',
    '-f', 'hls',
    '-hls_time', String(config.broadcast.hlsSegmentDuration),
    '-hls_list_size', String(config.broadcast.hlsListSize),
    '-hls_flags', 'delete_segments',
    '-hls_segment_filename', segPattern,
    hlsPath,
  ];

  if (config.broadcast.rtmpEnabled && config.broadcast.rtmpUrl) {
    args.push('-f', 'flv', config.broadcast.rtmpUrl);
  }

  return { args };
}

function buildEmergencyCommand(): { args: string[] } | null {
  const db = getDb();
  const files = db.prepare(`
    SELECT path FROM media_files WHERE type='emergency' AND status='ready' ORDER BY RANDOM() LIMIT 20
  `).all() as { path: string }[];

  if (files.length === 0) {
    logger.error('No emergency media available!');
    return null;
  }

  const concatPath = path.join(config.paths.data, 'emergency-concat.txt');
  const lines = files.flatMap(f => [formatConcatFileLine(f.path)]);
  fs.writeFileSync(concatPath, lines.join('\n'), 'utf-8');

  const hlsPath = path.join(config.paths.hlsOutput, 'stream.m3u8');
  const segPattern = path.join(config.paths.hlsOutput, 'seg%05d.ts');
  const broadcastRes = config.broadcast.resolution.split('x');
  const w = broadcastRes[0] ?? '1280';
  const h = broadcastRes[1] ?? '720';

  return {
    args: [
      '-y',
      '-stream_loop', '-1',
      '-re', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${config.broadcast.fps},settb=1/${config.broadcast.fps}`,
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', config.broadcast.videoBitrate,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', config.broadcast.audioBitrate,
      '-ar', String(config.broadcast.audioRate), '-ac', '2',
      '-f', 'hls',
      '-hls_time', String(config.broadcast.hlsSegmentDuration),
      '-hls_list_size', String(config.broadcast.hlsListSize),
      '-hls_flags', 'delete_segments',
      '-hls_segment_filename', segPattern,
      hlsPath,
    ],
  };
}

export function buildConcatFileContents(items: PlaylistItem[]): string {
  const hasTrimmedItems = items.some(item => getTrimDurationMs(item) !== null);
  const lines: string[] = hasTrimmedItems ? ['ffconcat version 1.0'] : [];

  for (const item of items) {
    lines.push(formatConcatFileLine(item.media_path));

    const trimDurationMs = getTrimDurationMs(item);
    if (trimDurationMs !== null) {
      const seconds = formatSeconds(trimDurationMs);
      lines.push(`outpoint ${seconds}`);
      lines.push(`duration ${seconds}`);
    }
  }

  return lines.join('\n');
}

function getTrimDurationMs(item: PlaylistItem): number | null {
  if (item.is_trimmed !== true && item.trim_out_ms == null && item.forced_duration_ms == null) {
    return null;
  }

  return item.trim_out_ms ?? item.forced_duration_ms ?? item.duration_ms;
}

function formatConcatFileLine(filePath: string): string {
  return `file '${filePath.replace(/'/g, "'\\''")}'`;
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function updateCurrentItem(): void {
  if (state.playlistArtifactRunId && state.artifactItems) {
    const now = Date.now();
    const current = state.artifactItems.find(item => item.start_time_ms <= now && item.end_time_ms > now) ?? null;
    const next = state.artifactItems.find(item => item.start_time_ms > now) ?? null;
    const changed = current?.id !== state.currentItem?.id;

    state.currentItem = current;
    state.nextItem = next;

    if (changed) {
      emitStatus();
      broadcastWs({ type: 'now_playing', data: { current, next } });
    }
    return;
  }

  const date = dayjs().format('YYYY-MM-DD');
  const { current, next } = getCurrentAndNext(date);
  const changed = current?.id !== state.currentItem?.id;

  state.currentItem = current;
  state.nextItem = next;

  if (changed) {
    emitStatus();
    broadcastWs({ type: 'now_playing', data: { current, next } });
  }
}

function preparePlaylistArtifactBroadcast(runId: string): PreparedArtifactBroadcast {
  const safeRunId = sanitizePlaylistRunId(runId);
  const playlistRoot = path.join(getProjectRoot(), 'generated', 'playlists');
  const runDir = path.join(playlistRoot, safeRunId);
  const playlistPath = path.join(runDir, 'playlist.json');
  const reportPath = path.join(runDir, 'report.json');

  if (!path.resolve(runDir).startsWith(`${path.resolve(playlistRoot)}${path.sep}`)) {
    throw new Error('Unsafe playlist run id');
  }
  if (!fs.existsSync(playlistPath)) {
    throw new Error(`Prepared playlist not found: ${safeRunId}`);
  }

  if (fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      summary?: {
        status?: string;
        testPlayoutEligible?: boolean;
        missingMediaFileCount?: number;
        itemCount?: number;
      };
      errors?: Array<{ code?: string; message?: string }>;
    };
    const summary = report.summary;
    if (summary?.status && summary.status !== 'completed') {
      throw new Error(`Prepared playlist is not playable: ${summary.missingMediaFileCount ?? 0} media items are missing.`);
    }
    if (summary?.testPlayoutEligible === false) {
      throw new Error('Prepared playlist is not eligible for playout. Review materialization errors first.');
    }
    if (report.errors && report.errors.length > 0) {
      throw new Error(report.errors[0]?.message ?? 'Prepared playlist has errors.');
    }
  }

  const artifact = JSON.parse(fs.readFileSync(playlistPath, 'utf8')) as {
    items?: Array<{
      id?: string;
      type?: string;
      sourceRole?: string;
      mediaFileId?: string | null;
      absolutePath?: string | null;
      title?: string;
      durationSeconds?: number;
      timelineStartSeconds?: number;
      timelineEndSeconds?: number;
      isTrimmed?: boolean;
      trimEndSeconds?: number | null;
    }>;
  };

  const baseMs = Date.now();
  const items: PlaylistItem[] = [];
  let cursorMs = baseMs;
  let skipped = 0;

  for (const [index, item] of (artifact.items ?? []).entries()) {
    const mediaPath = item.absolutePath;
    if (!mediaPath || !fs.existsSync(mediaPath)) {
      skipped++;
      continue;
    }

    const durationMs = Math.max(
      1000,
      Math.round(
        (typeof item.durationSeconds === 'number' && item.durationSeconds > 0
          ? item.durationSeconds
          : Math.max(1, (item.timelineEndSeconds ?? 0) - (item.timelineStartSeconds ?? 0))) * 1000
      )
    );
    const startMs = cursorMs;
    const endMs = startMs + durationMs;
    cursorMs = endMs;

    items.push({
      id: item.id ?? `${safeRunId}-${index}`,
      position: index,
      start_time_ms: startMs,
      end_time_ms: endMs,
      type: item.type ?? 'program',
      program_id: null,
      media_file_id: item.mediaFileId ?? item.id ?? `${safeRunId}-${index}`,
      media_path: mediaPath,
      title: item.title ?? path.basename(mediaPath),
      title_ar: item.title ?? null,
      duration_ms: durationMs,
      show_lower_third: false,
      lower_third_path: null,
      is_emergency: false,
      source_role: (item.sourceRole as PlaylistItem['source_role']) ?? 'program',
      is_trimmed: item.isTrimmed === true,
      trim_out_ms: item.isTrimmed === true ? durationMs : null,
      forced_duration_ms: item.isTrimmed === true ? durationMs : null,
    });
  }

  if (items.length === 0) {
    throw new Error(`Prepared playlist has no playable media files${skipped > 0 ? ` (${skipped} missing)` : ''}.`);
  }

  const current = items[0] ?? null;
  const next = items[1] ?? null;
  const command = buildBroadcastCommandFromItems(items, current, dayjs().format('YYYY-MM-DD'));
  if (!command) {
    throw new Error('Could not build FFmpeg command for prepared playlist.');
  }

  return { runId: safeRunId, items, current, next, command };
}

function sanitizePlaylistRunId(runId: string): string {
  const safe = runId.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(safe) || safe.includes('..')) {
    throw new Error('Invalid playlist run id');
  }
  return safe;
}

function getProjectRoot(): string {
  return path.resolve(
    process.env['PLAYLIST_MATERIALIZATION_PROJECT_ROOT'] ??
    process.env['TEST_PLAYOUT_PROJECT_ROOT'] ??
    path.resolve(__dirname, '../../..')
  );
}

function emitStatus(): void {
  broadcastWs({ type: 'broadcast_status', data: getBroadcastState() });
}

export function checkHlsHealth(): { ok: boolean; lastModified: number | null; ageSeconds: number } {
  const m3u8 = path.join(config.paths.hlsOutput, 'stream.m3u8');
  if (!fs.existsSync(m3u8)) return { ok: false, lastModified: null, ageSeconds: Infinity };

  const stat = fs.statSync(m3u8);
  const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
  const ok = ageSeconds <= config.monitoring.hlsStaleThreshold;

  if (!ok) {
    broadcastWs({ type: 'alert', data: { level: 'warn', message: `HLS stream stale: ${Math.round(ageSeconds)}s since last update` } });
  }

  return { ok, lastModified: stat.mtimeMs, ageSeconds };
}

const HLS_STALE_REACTION_COOLDOWN_MS = 120_000; // 2 minutes between reactions
let hlsStaleReactionActiveAt: number | null = null;

/**
 * Called by monitoring when HLS is stale while broadcast is running.
 * Enforces a 2-minute cooldown to prevent restart loops.
 * Tries one restart; if that also fails, switches to emergency.
 */
export async function reactToHlsStale(): Promise<void> {
  if (state.status !== 'running' && state.status !== 'emergency') return;

  const now = Date.now();

  if (hlsStaleReactionActiveAt !== null) {
    const elapsed = now - hlsStaleReactionActiveAt;
    if (elapsed < HLS_STALE_REACTION_COOLDOWN_MS) {
      logger.info(`HLS stale reaction skipped — cooldown active (${Math.round(elapsed / 1000)}s / ${HLS_STALE_REACTION_COOLDOWN_MS / 1000}s)`);
      return;
    }
  }

  hlsStaleReactionActiveAt = now;
  logger.warn('HLS stale reaction started — attempting restart');

  try {
    await restartBroadcast();
    logger.info('HLS stale reaction: restart succeeded');
  } catch (err) {
    logger.error('HLS stale reaction: restart failed — switching to emergency', err);
    try {
      await switchToEmergency();
    } catch (emergErr) {
      logger.error('HLS stale reaction: emergency switch also failed', emergErr);
    }
  }
}
