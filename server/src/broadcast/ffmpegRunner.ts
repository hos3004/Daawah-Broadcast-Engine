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
import { buildAudioSyncAf } from '../media/normalizer';
import {
  buildOverlayEnableExpression,
  prepareProgramBadgeOverlayAssets,
  programBadgeY,
  type ProgramBadgeRange,
} from '../overlay/programBadgeOverlay';

export type BroadcastStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error' | 'emergency';

/** Thrown when a playlist cannot be safely broadcast (e.g. items with no trusted duration). */
export class BroadcastPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastPreflightError';
  }
}

export interface BroadcastDurationReport {
  total: number;
  trustedReal: number;
  slotOrAssumedOnly: number;
  missingUnknown: number;
  fillersNullDuration: number;
  blocking: Array<{ position: number; path: string; reason: string }>;
}

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

interface BroadcastResumeState {
  mode: 'playlist_artifact';
  playlistArtifactRunId: string;
  updatedAt: string;
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
  if (getBroadcastState().status === 'running') {
    clearBroadcastResumeState();
  }
}

export async function startPlaylistArtifactBroadcast(playlistRunId: string): Promise<void> {
  if (state.status === 'running' || state.status === 'starting') {
    throw new Error('Broadcast already running');
  }

  const prepared = await preparePlaylistArtifactBroadcast(playlistRunId);

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
  if (getBroadcastState().status === 'running') {
    writeBroadcastResumeState({
      mode: 'playlist_artifact',
      playlistArtifactRunId: prepared.runId,
      updatedAt: new Date().toISOString(),
    });
  }
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

  if (reason === 'manual' || reason === 'emergency') {
    clearBroadcastResumeState();
  }

  logger.info(`Broadcast stopped: ${reason}`);
}

export async function tryAutoResumeBroadcastOnStartup(): Promise<void> {
  const resume = readBroadcastResumeState();
  if (!resume) return;
  if (state.status !== 'idle') return;

  logger.info(`Auto-resume broadcast requested for playlist artifact ${resume.playlistArtifactRunId}`);
  try {
    await startPlaylistArtifactBroadcast(resume.playlistArtifactRunId);
    logger.info(`Auto-resume broadcast started for playlist artifact ${resume.playlistArtifactRunId}`);
  } catch (err) {
    logger.error('Auto-resume broadcast failed', err);
    state.status = 'error';
    state.lastError = err instanceof Error ? err.message : String(err);
    emitStatus();
  }
}

export async function restartBroadcast(): Promise<void> {
  const restartPlaylistArtifactRunId = state.playlistArtifactRunId;
  const restartEmergency = state.isEmergency;
  await stopBroadcast('restart');
  await new Promise(r => setTimeout(r, 1000));
  if (restartPlaylistArtifactRunId && !restartEmergency) {
    await startPlaylistArtifactBroadcast(restartPlaylistArtifactRunId);
    return;
  }
  await startBroadcast(restartEmergency);
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

  try {
    if (!emergency && (preparedArtifact || state.playlistArtifactRunId)) {
      const prepared = preparedArtifact ?? await preparePlaylistArtifactBroadcast(state.playlistArtifactRunId!);
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
        : await buildBroadcastCommand(date, current);
    }
  } catch (err) {
    if (err instanceof BroadcastPreflightError) {
      logger.error(`Broadcast preflight blocked start: ${err.message}`);
      state.status = 'error';
      state.lastError = err.message;
      emitStatus();
      return;
    }
    throw err;
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

async function buildBroadcastCommand(date: string, current: PlaylistItem | null): Promise<{ args: string[] } | null> {
  const playlist = getPlaylistForDate(date);

  if (!playlist || playlist.items.length === 0) {
    logger.warn(`No playlist for ${date} — using emergency`);
    return buildEmergencyCommand();
  }

  return buildBroadcastCommandFromItems(playlist.items, current, date);
}

async function buildBroadcastCommandFromItems(items: PlaylistItem[], current: PlaylistItem | null, date: string): Promise<{ args: string[] } | null> {
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

  // Duration preflight: refuse to start if any item lacks a trusted real duration
  // (e.g. a filler with NULL duration_sec) instead of silently assuming 60s.
  const durationReport = analyzeBroadcastDurations(available);
  logDurationReport(durationReport);
  if (durationReport.blocking.length > 0) {
    const first = durationReport.blocking[0];
    throw new BroadcastPreflightError(
      `Refusing to start: ${durationReport.blocking.length} playlist item(s) have no trusted duration. ` +
        `First: pos ${first?.position} — ${first?.reason} — ${first?.path}. ` +
        `Run a media scan so media_files.duration_sec is populated.`
    );
  }

  // Build FFmpeg concat input — -re for real-time pacing
  const concatListPath = path.join(config.paths.data, 'current-concat.txt');
  fs.writeFileSync(concatListPath, buildConcatFileContents(available, now), 'utf-8');

  const broadcastRes = config.broadcast.resolution.split('x');
  const w = broadcastRes[0] ?? '1280';
  const h = broadcastRes[1] ?? '720';
  const width = parseInt(w, 10) || 1280;
  const height = parseInt(h, 10) || 720;

  const hlsPath = path.join(config.paths.hlsOutput, 'stream.m3u8');
  const segPattern = path.join(config.paths.hlsOutput, 'seg%05d.ts');

  const logoPath = resolveLogoOverlayPath(config.overlay.logoLoopPath);
  const hasLogo = fs.existsSync(logoPath);

  const tickerPath = resolveTickerOverlayPath(date);

  // Now-playing PNG (lower third): shown for first N seconds of the session
  const nowPlayingPath = current?.lower_third_path ?? null;
  const hasNowPlaying = nowPlayingPath !== null && fs.existsSync(nowPlayingPath);
  const programBadgeOverlay = tryPrepareProgramBadgeOverlayAssets(available, now, date, width, height);

  // Build filter_complex
  // -re before -i for real-time pacing
  const inputs: string[] = [
    '-re', '-f', 'concat', '-safe', '0', '-i', concatListPath,
  ];

  let filterComplex = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${config.broadcast.fps},setpts=N/(${config.broadcast.fps}*TB),settb=1/${config.broadcast.fps}[base]`;
  let lastLabel = '[base]';
  let inputIdx = 1;

  if (hasNowPlaying) {
    inputs.push('-loop', '1', '-i', nowPlayingPath!);
    const duration = config.overlay.nowPlayingDuration;
    filterComplex += `;${lastLabel}[${inputIdx}:v]overlay=10:H-h-80:enable='between(t,0,${duration})'[np]`;
    lastLabel = '[np]';
    inputIdx++;
  }

  if (programBadgeOverlay) {
    const enable = buildOverlayEnableExpression(programBadgeOverlay.backgroundRanges);
    if (enable) {
      // Badge background pill ("الآن" template) — shown whenever any program is on.
      inputs.push('-loop', '1', '-framerate', String(config.broadcast.fps), '-i', programBadgeOverlay.templatePath);
      filterComplex += `;${lastLabel}[${inputIdx}:v]overlay=0:${programBadgeY(height, config.overlay.tickerHeight)}:enable='${enable}':shortest=0[program_badge_bg]`;
      lastLabel = '[program_badge_bg]';
      inputIdx++;

      // Program title text — ALL titles live in one transparent sprite PNG
      // (rendered by canvas with Tajawal, no libass). A time-based `crop` selects
      // the active row, so the text is composited with a single overlay regardless
      // of how many programs the day has. The previous per-title overlay chain
      // dropped the encoder to ~0.40x realtime; this keeps it above 5x.
      const textLayerY = programBadgeOverlay.textLayerY;
      inputs.push('-loop', '1', '-framerate', String(config.broadcast.fps), '-i', programBadgeOverlay.spritePath);
      filterComplex += `;[${inputIdx}:v]crop=${programBadgeOverlay.spriteWidth}:${programBadgeOverlay.rowHeight}:0:'${programBadgeOverlay.cropYExpression}'[program_badge_text_src]`;
      filterComplex += `;${lastLabel}[program_badge_text_src]overlay=0:${textLayerY}:shortest=0[program_badge_text]`;
      lastLabel = '[program_badge_text]';
      inputIdx++;
    }
  }

  if (hasLogo) {
    if (isStaticImageOverlay(logoPath)) {
      inputs.push('-loop', '1', '-framerate', String(config.broadcast.fps), '-i', logoPath);
    } else {
      inputs.push('-stream_loop', '-1', '-i', logoPath);
    }
    const logoEnable = buildLogoOverlayEnableExpression(available, now);
    const logoEnablePart = logoEnable ? `:enable='${logoEnable}'` : '';
    filterComplex += `;[${inputIdx}:v]scale=${config.overlay.logoWidth}:-1:force_original_aspect_ratio=decrease,format=rgba[logo_rgba]`;
    filterComplex += `;${lastLabel}[logo_rgba]overlay=${config.overlay.logoPosition}${logoEnablePart}:shortest=0[logo]`;
    lastLabel = '[logo]';
    inputIdx++;
  }

  if (tickerPath) {
    const ty = Math.max(0, parseInt(h, 10) - config.overlay.tickerHeight);
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
    // Normalise audio timestamps so audio never drifts ahead of video.
    // Source bumpers/episodes often have audio tails (audio longer than video)
    // or non-zero start_pts; without this the audio PTS accumulates a large
    // positive offset relative to video (observed: 13+ s ahead after 5 min).
    '-af', buildAudioSyncAf({ audioRate: config.broadcast.audioRate }),
    '-c:v', 'libx264',
    '-preset', config.broadcast.encoderPreset,
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
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${config.broadcast.fps},setpts=N/(${config.broadcast.fps}*TB),settb=1/${config.broadcast.fps}`,
      '-c:v', 'libx264', '-preset', config.broadcast.encoderPreset,
      '-b:v', config.broadcast.videoBitrate,
      '-pix_fmt', 'yuv420p',
      '-af', buildAudioSyncAf({ audioRate: config.broadcast.audioRate }),
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

export function buildConcatFileContents(items: PlaylistItem[], playbackStartMs?: number): string {
  // ffconcat `duration` MUST only come from a trusted real duration.
  // For trimmed items the trim length is the intended (real, bounded) duration,
  // so we emit outpoint+duration. For non-trimmed items we emit NO duration and
  // let the demuxer play each file to its natural EOF — this can never freeze
  // (EOF is always the true end). Any A/V drift from audio tails is corrected
  // downstream by aresample=async=1 in the encode filter.
  //
  // We deliberately do NOT use item.duration_ms here: for fillers it is the
  // slot/gap length (or an assumed 60s), not the real file duration, and trusting
  // it caused frozen-frame gaps when duration_ms > the real file length.
  const firstOffsetMs = playbackStartMs === undefined || items.length === 0
    ? 0
    : getPlaybackOffsetMs(items[0]!, playbackStartMs);
  const hasTrimmedItems = items.some(item => getTrimDurationMs(item) !== null);
  const needsFfconcatHeader = hasTrimmedItems || firstOffsetMs > 0;
  const lines: string[] = needsFfconcatHeader ? ['ffconcat version 1.0'] : [];

  for (const [index, item] of items.entries()) {
    const trimDurationMs = getTrimDurationMs(item);
    const offsetMs = index === 0 && playbackStartMs !== undefined
      ? getPlaybackOffsetMs(item, playbackStartMs)
      : 0;

    if (trimDurationMs !== null && offsetMs >= trimDurationMs) {
      continue;
    }

    lines.push(formatConcatFileLine(item.media_path));

    if (offsetMs > 0) {
      lines.push(`inpoint ${formatSeconds(offsetMs)}`);
    }

    if (trimDurationMs !== null) {
      const outpointSeconds = formatSeconds(trimDurationMs);
      const remainingSeconds = formatSeconds(trimDurationMs - offsetMs);
      lines.push(`outpoint ${outpointSeconds}`);
      lines.push(`duration ${remainingSeconds}`);
    }
  }

  return lines.join('\n');
}

function getPlaybackOffsetMs(item: PlaylistItem, playbackStartMs: number): number {
  if (!Number.isFinite(item.start_time_ms) || playbackStartMs <= item.start_time_ms) {
    return 0;
  }
  return Math.max(0, Math.round(playbackStartMs - item.start_time_ms));
}

function getTrimDurationMs(item: PlaylistItem): number | null {
  if (item.is_trimmed !== true && item.trim_out_ms == null && item.forced_duration_ms == null) {
    return null;
  }

  return item.trim_out_ms ?? item.forced_duration_ms ?? item.duration_ms;
}

function resolveLogoOverlayPath(configuredPath: string): string {
  const ext = path.extname(configuredPath);
  if (ext) {
    const pngCandidate = path.join(path.dirname(configuredPath), `${path.basename(configuredPath, ext)}.png`);
    if (fs.existsSync(pngCandidate)) {
      return pngCandidate;
    }
  }
  return configuredPath;
}

function resolveTickerOverlayPath(date: string): string | null {
  const tickerDir = path.join(config.paths.assets, 'overlays', 'tickers');
  const stablePath = path.join(tickerDir, 'current-schedule.webm');
  if (fs.existsSync(stablePath)) return stablePath;

  const datePath = path.join(tickerDir, `${date}.webm`);
  return fs.existsSync(datePath) ? datePath : null;
}

function isStaticImageOverlay(filePath: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(filePath).toLowerCase());
}

function tryPrepareProgramBadgeOverlayAssets(
  items: PlaylistItem[],
  playbackStartMs: number,
  date: string,
  width: number,
  height: number
): ReturnType<typeof prepareProgramBadgeOverlayAssets> {
  try {
    return prepareProgramBadgeOverlayAssets(items, playbackStartMs, {
      date,
      width,
      height,
      tickerHeight: config.overlay.tickerHeight,
    });
  } catch (err) {
    logger.warn(`Program badge overlay was skipped: ${err}`);
    return null;
  }
}

export function buildLogoOverlayEnableExpression(items: PlaylistItem[], playbackStartMs: number): string | null {
  const hideRanges = items
    .filter(item => item.hide_logo === true && (item.source_role === 'program' || item.type === 'program'))
    .map(item => ({
      startSeconds: Math.max(0, (item.start_time_ms - playbackStartMs) / 1000),
      endSeconds: Math.max(0, (item.end_time_ms - playbackStartMs) / 1000),
    }))
    .filter(range => range.endSeconds - range.startSeconds >= 0.5);

  const hideExpression = buildOverlayEnableExpression(mergeTimelineRanges(hideRanges));
  return hideExpression ? `not(${hideExpression})` : null;
}

function mergeTimelineRanges(ranges: ProgramBadgeRange[]): ProgramBadgeRange[] {
  const sorted = [...ranges].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  const merged: ProgramBadgeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startSeconds <= last.endSeconds + 0.05) {
      last.endSeconds = Math.max(last.endSeconds, range.endSeconds);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Classifies each playlist item by how trustworthy its real duration is.
 *
 * "Trusted real" = trimmed (intentional bounded cut), OR media_files.duration_sec > 0,
 * OR an artifact item (no media_files row) that carries a positive declared duration.
 *
 * Items that are neither trimmed nor have a real known duration are reported and,
 * when they are fillers/programs backed by a media record with NULL duration_sec,
 * marked as BLOCKING — we refuse to start rather than silently assume 60s.
 */
export function analyzeBroadcastDurations(items: PlaylistItem[]): BroadcastDurationReport {
  const ids = [...new Set(items.map(i => i.media_file_id).filter((v): v is string => !!v))];
  const durById = new Map<string, number | null>();
  const knownIds = new Set<string>();

  if (ids.length > 0) {
    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = getDb()
        .prepare(`SELECT id, duration_sec FROM media_files WHERE id IN (${placeholders})`)
        .all(...ids) as Array<{ id: string; duration_sec: number | null }>;
      for (const r of rows) {
        knownIds.add(r.id);
        durById.set(r.id, r.duration_sec);
      }
    } catch (err) {
      logger.warn(`Duration preflight DB lookup failed (continuing without DB durations): ${err}`);
    }
  }

  const report: BroadcastDurationReport = {
    total: items.length,
    trustedReal: 0,
    slotOrAssumedOnly: 0,
    missingUnknown: 0,
    fillersNullDuration: 0,
    blocking: [],
  };

  for (const item of items) {
    const trimmed = getTrimDurationMs(item) !== null;
    const hasDbRow = knownIds.has(item.media_file_id);
    const dbDur = durById.get(item.media_file_id);
    const dbDurOk = typeof dbDur === 'number' && dbDur > 0;
    const isFiller = item.source_role === 'filler' || item.type === 'filler';

    if (trimmed || dbDurOk) {
      report.trustedReal++;
      continue;
    }

    if (!hasDbRow) {
      // No media_files record (e.g. prepared artifact item). Trust a positive
      // declared duration; otherwise it is genuinely unknown.
      if (item.duration_ms > 0) {
        report.trustedReal++;
      } else {
        report.missingUnknown++;
        report.blocking.push({
          position: item.position,
          path: item.media_path,
          reason: 'no media record and no declared duration',
        });
      }
      continue;
    }

    // Has a media_files record but duration_sec is NULL/0 → cannot be trusted.
    report.slotOrAssumedOnly++;
    if (isFiller) {
      report.fillersNullDuration++;
      report.blocking.push({
        position: item.position,
        path: item.media_path,
        reason: 'filler has NULL duration_sec in media library (rescan needed)',
      });
    } else {
      report.missingUnknown++;
      report.blocking.push({
        position: item.position,
        path: item.media_path,
        reason: 'media has no known duration_sec (rescan needed)',
      });
    }
  }

  return report;
}

function logDurationReport(report: BroadcastDurationReport): void {
  logger.info(
    '[Preflight] duration report — ' +
      `total=${report.total}, trustedReal=${report.trustedReal}, ` +
      `slotOrAssumedOnly=${report.slotOrAssumedOnly}, missingUnknown=${report.missingUnknown}, ` +
      `fillersNullDuration=${report.fillersNullDuration}, blocking=${report.blocking.length}`
  );
  for (const b of report.blocking.slice(0, 10)) {
    logger.warn(`[Preflight] BLOCKING item pos=${b.position} — ${b.reason} — ${b.path}`);
  }
  if (report.blocking.length > 10) {
    logger.warn(`[Preflight] …and ${report.blocking.length - 10} more blocking item(s)`);
  }
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

async function preparePlaylistArtifactBroadcast(runId: string): Promise<PreparedArtifactBroadcast> {
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
    days?: Array<{ date?: string; itemCount?: number }>;
    items?: Array<{
      id?: string;
      date?: string;
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
      hideLogo?: boolean;
      hide_logo?: boolean;
    }>;
  };

  const items: PlaylistItem[] = [];
  let fallbackCursorMs = Date.now();
  const fallbackDate = findFirstArtifactDate(artifact);
  let skipped = 0;

  for (const [index, item] of (artifact.items ?? []).entries()) {
    const mediaPath = item.absolutePath;
    if (!mediaPath || !fs.existsSync(mediaPath)) {
      skipped++;
      continue;
    }

    const declaredDurationMs = Math.max(
      1000,
      Math.round(
        (typeof item.durationSeconds === 'number' && item.durationSeconds > 0
          ? item.durationSeconds
          : Math.max(1, (item.timelineEndSeconds ?? 0) - (item.timelineStartSeconds ?? 0))) * 1000
      )
    );
    const timelineMs = getArtifactTimelineMs(item, fallbackDate);
    const startMs = timelineMs?.startMs ?? fallbackCursorMs;
    const endMs = timelineMs?.endMs ?? (startMs + declaredDurationMs);
    const durationMs = Math.max(1000, endMs - startMs);
    fallbackCursorMs = endMs;

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
      hide_logo: item.hideLogo === true || item.hide_logo === true,
    });
  }

  if (items.length === 0) {
    throw new Error(`Prepared playlist has no playable media files${skipped > 0 ? ` (${skipped} missing)` : ''}.`);
  }

  items.sort((a, b) => a.start_time_ms - b.start_time_ms || a.position - b.position);
  items.forEach((item, index) => { item.position = index; });

  const now = Date.now();
  const current = items.find(item => item.start_time_ms <= now && item.end_time_ms > now) ?? null;
  const next = items.find(item => item.start_time_ms > now) ?? null;
  const command = await buildBroadcastCommandFromItems(items, current, dayjs().format('YYYY-MM-DD'));
  if (!command) {
    throw new Error('Could not build FFmpeg command for prepared playlist.');
  }

  return { runId: safeRunId, items, current, next, command };
}

function findFirstArtifactDate(artifact: {
  days?: Array<{ date?: string }>;
  items?: Array<{ date?: string }>;
}): string | null {
  for (const item of artifact.items ?? []) {
    const date = normalizeArtifactDate(item.date);
    if (date) return date;
  }
  for (const day of artifact.days ?? []) {
    const date = normalizeArtifactDate(day.date);
    if (date) return date;
  }
  return null;
}

function getArtifactTimelineMs(
  item: { date?: string; timelineStartSeconds?: number; timelineEndSeconds?: number },
  fallbackDate: string | null
): { startMs: number; endMs: number } | null {
  const date = normalizeArtifactDate(item.date) ?? fallbackDate;
  const startSeconds = finiteNumber(item.timelineStartSeconds);
  const endSeconds = finiteNumber(item.timelineEndSeconds);
  if (!date || startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
    return null;
  }

  const dayStartMs = getLocalDayStartMs(date);
  if (dayStartMs === null) {
    return null;
  }

  return {
    startMs: dayStartMs + Math.round(startSeconds * 1000),
    endMs: dayStartMs + Math.round(endSeconds * 1000),
  };
}

function normalizeArtifactDate(date: unknown): string | null {
  if (typeof date !== 'string') return null;
  const trimmed = date.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function getLocalDayStartMs(date: string): number | null {
  const parsed = dayjs(`${date}T00:00:00`);
  return parsed.isValid() ? parsed.valueOf() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function getBroadcastResumeStatePath(): string {
  return path.join(config.paths.data, 'broadcast-resume.json');
}

function writeBroadcastResumeState(resume: BroadcastResumeState): void {
  try {
    ensureDir(config.paths.data);
    fs.writeFileSync(getBroadcastResumeStatePath(), `${JSON.stringify(resume, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.warn(`Could not write broadcast resume state: ${err}`);
  }
}

function readBroadcastResumeState(): BroadcastResumeState | null {
  const resumePath = getBroadcastResumeStatePath();
  if (!fs.existsSync(resumePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(resumePath, 'utf8')) as Partial<BroadcastResumeState>;
    if (
      parsed.mode !== 'playlist_artifact' ||
      typeof parsed.playlistArtifactRunId !== 'string' ||
      !parsed.playlistArtifactRunId.trim()
    ) {
      return null;
    }
    return {
      mode: 'playlist_artifact',
      playlistArtifactRunId: parsed.playlistArtifactRunId.trim(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch (err) {
    logger.warn(`Could not read broadcast resume state: ${err}`);
    return null;
  }
}

function clearBroadcastResumeState(): void {
  const resumePath = getBroadcastResumeStatePath();
  try {
    if (fs.existsSync(resumePath)) fs.unlinkSync(resumePath);
  } catch (err) {
    logger.warn(`Could not clear broadcast resume state: ${err}`);
  }
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
