import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import { DraftValidationError } from '../schedule/drafts';

export type TestPlayoutOutputMode = 'local_file' | 'localhost_hls';

export interface TestPlayoutPlanInput {
  confirmPrepareOnly?: boolean;
  sourcePlaylistPath?: string;
  outputMode?: TestPlayoutOutputMode;
  outputPath?: string;
  durationLimitSeconds?: number;
  [key: string]: unknown;
}

export interface TestPlayoutRunInput extends Omit<TestPlayoutPlanInput, 'confirmPrepareOnly'> {
  confirmExecution?: boolean;
  confirmationText?: string;
}

export interface TestPlayoutWarning {
  code: string;
  message: string;
}

export interface TestPlayoutError {
  code: string;
  message: string;
}

export interface TestPlayoutCommandPreview {
  executable: 'ffmpeg';
  args: string[];
  command: string;
  prepareOnly: true;
  willExecute: false;
  outputMode: TestPlayoutOutputMode;
  outputPath: string;
  safety: {
    ffmpegExecution: false;
    playoutStarted: false;
    broadcastStarted: false;
    rtmpPush: false;
    streamKeyUsage: false;
    cursorMutation: false;
    mediaAccess: false;
    dnsChanges: false;
  };
  notes: string[];
}

export interface TestPlayoutPlanDetail {
  id: string;
  sourcePlaylistPath: string;
  outputMode: TestPlayoutOutputMode;
  outputPath: string;
  durationLimitSeconds: number;
  status: 'planned';
  commandPreview: TestPlayoutCommandPreview;
  warnings: TestPlayoutWarning[];
  errors: TestPlayoutError[];
  createdAt: string;
}

export interface TestPlayoutRunDetail {
  id: string;
  sourcePlaylistPath: string;
  outputMode: TestPlayoutOutputMode;
  outputPath: string;
  durationLimitSeconds: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  commandPreview: {
    executable: 'ffmpeg';
    args: string[];
    command: string;
    prepareOnly: false;
    willExecute: true;
    outputMode: TestPlayoutOutputMode;
    outputPath: string;
    safety: {
      ffmpegExecution: boolean;
      playoutStarted: boolean;
      broadcastStarted: boolean;
      rtmpPush: boolean;
      streamKeyUsage: boolean;
      cursorMutation: boolean;
      mediaAccess: boolean;
      dnsChanges: boolean;
    };
    notes: string[];
  };
  artifacts: {
    runDir: string;
    statusPath: string;
    reportPath: string;
    ffmpegLogPath: string;
  };
  monitoring: TestPlayoutMonitoringSnapshot;
  safety: {
    ffmpegExecution: true;
    playoutStarted: true;
    broadcastStarted: false;
    rtmpPush: false;
    streamKeyUsage: false;
    cursorMutation: false;
    mediaAccess: true;
    dnsChanges: false;
    productionPaths: false;
  };
  errors: TestPlayoutError[];
}

export interface TestPlayoutMonitoringSnapshot {
  heartbeatAt: string;
  status: 'running' | 'completed' | 'failed';
  currentItem: PlaylistArtifactItem | null;
  nextItem: PlaylistArtifactItem | null;
  elapsedSeconds: number;
  driftSeconds: 0;
  ffmpegStatus: 'not_started' | 'running' | 'completed' | 'failed';
  output: {
    mode: TestPlayoutOutputMode;
    path: string;
    exists: boolean;
    sizeBytes: number | null;
    hlsSegmentCount: number | null;
  };
  process: {
    rssBytes: number;
    heapUsedBytes: number;
  };
}

interface PlaylistArtifactItem {
  id?: string;
  title?: string;
  date?: string;
  type?: string;
  sourceRole?: string;
  startTime?: string;
  endTime?: string;
  timelineStartSeconds?: number;
  timelineEndSeconds?: number;
  durationSeconds?: number;
  mediaFileId?: string | null;
  absolutePath?: string | null;
  validationStatus?: string;
  isTrimmed?: boolean;
}

interface PlaylistArtifact {
  mediaExpansionAvailable?: unknown;
  ffconcatPath?: unknown;
  items?: unknown;
}

interface SafeExpandedPlaylistItem extends PlaylistArtifactItem {
  validationStatus: 'ready';
  absolutePath: string;
  durationSeconds: number;
  isTrimmed: boolean;
}

interface ValidatedTestPlayoutPlan {
  planId: string;
  sourcePlaylistPath: string;
  ffconcatInputPath: string;
  outputMode: TestPlayoutOutputMode;
  outputPath: string;
  durationLimitSeconds: number;
}

interface TestPlayoutPlanRow {
  id: string;
  source_playlist_path: string;
  output_mode: TestPlayoutOutputMode;
  output_path: string;
  duration_limit_seconds: number;
  status: 'planned';
  command_preview_json: string;
  warnings_json: string;
  errors_json: string;
  created_at: string;
}

const MAX_DURATION_LIMIT_SECONDS = 20 * 60;
const EXECUTION_CONFIRMATION_TEXT = 'RUN ISOLATED TEST PLAYOUT';
const DEFAULT_FFMPEG_TIMEOUT_GRACE_SECONDS = 30;
const DEFAULT_FFMPEG_KILL_GRACE_MS = 5_000;
const DEFAULT_FFMPEG_FORCE_CLOSE_MS = 5_000;

export function validateTestPlayoutPlan(input: TestPlayoutPlanInput, planId = '__validation__'): ValidatedTestPlayoutPlan {
  rejectForbiddenInputStrings(input);

  if (input.confirmPrepareOnly !== true) {
    throw new DraftValidationError('Test playout planning requires confirmPrepareOnly=true', 'TEST_PLAYOUT_CONFIRMATION_REQUIRED');
  }

  const outputMode = normalizeOutputMode(input.outputMode);
  const durationLimitSeconds = normalizeDurationLimit(input.durationLimitSeconds);
  const sourcePlaylistPath = validateSourcePlaylistPath(input.sourcePlaylistPath);
  const outputPath = validateOutputPath(input.outputPath, outputMode, planId);

  return {
    planId,
    sourcePlaylistPath,
    ffconcatInputPath: getExpectedFfconcatPath(sourcePlaylistPath),
    outputMode,
    outputPath,
    durationLimitSeconds,
  };
}

export function buildTestPlayoutCommand(input: TestPlayoutPlanInput, planId = '__preview__'): TestPlayoutCommandPreview {
  return buildCommandPreview(validateTestPlayoutPlan(input, planId));
}

export function writeTestPlayoutPlan(input: TestPlayoutPlanInput): TestPlayoutPlanDetail {
  const planId = uuidv4();
  const validated = validateTestPlayoutPlan(input, planId);
  const commandPreview = buildCommandPreview(validated);
  const warnings: TestPlayoutWarning[] = [
    {
      code: 'PLAN_ONLY_NO_EXECUTION',
      message: 'This record only prepares a command preview. It does not run FFmpeg, start playout, or broadcast.',
    },
    {
      code: 'MEDIA_QC_REQUIRED_BEFORE_EXECUTION',
      message: 'Future execution requires explicit approval and QC-passed media inputs.',
    },
  ];
  const errors: TestPlayoutError[] = [];
  const createdAt = new Date().toISOString();

  getDb().prepare(`
    INSERT INTO test_playout_plans (
      id, source_playlist_path, output_mode, output_path, duration_limit_seconds,
      status, command_preview_json, warnings_json, errors_json, created_at
    )
    VALUES (
      @id, @source_playlist_path, @output_mode, @output_path, @duration_limit_seconds,
      @status, @command_preview_json, @warnings_json, @errors_json, @created_at
    )
  `).run({
    id: planId,
    source_playlist_path: validated.sourcePlaylistPath,
    output_mode: validated.outputMode,
    output_path: validated.outputPath,
    duration_limit_seconds: validated.durationLimitSeconds,
    status: 'planned',
    command_preview_json: JSON.stringify(commandPreview),
    warnings_json: JSON.stringify(warnings),
    errors_json: JSON.stringify(errors),
    created_at: createdAt,
  });

  const saved = readTestPlayoutPlan(planId);
  if (!saved) {
    throw new Error('Test playout plan was saved but could not be read back');
  }
  return saved;
}

export async function runIsolatedTestPlayout(input: TestPlayoutRunInput): Promise<TestPlayoutRunDetail> {
  const runId = uuidv4();
  const validated = validateTestPlayoutExecution(input, runId);
  const runDir = path.dirname(validated.outputPath);
  const statusPath = path.join(runDir, 'status.json');
  const reportPath = path.join(runDir, 'report.md');
  const ffmpegLogPath = path.join(runDir, 'ffmpeg.log');
  const startedAt = new Date().toISOString();
  const playlistItems = readPlaylistItems(validated.sourcePlaylistPath);
  const errors: TestPlayoutError[] = [];

  fs.mkdirSync(runDir, { recursive: true });
  const verifiedFfconcatPath = writeVerifiedFfconcat(validated.sourcePlaylistPath, runDir, playlistItems);
  const executionPlan: ValidatedTestPlayoutPlan = {
    ...validated,
    ffconcatInputPath: verifiedFfconcatPath,
  };
  const commandPreview = buildExecutableCommandPreview(executionPlan);
  if (validated.outputMode === 'localhost_hls') {
    fs.mkdirSync(validated.outputPath, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(validated.outputPath), { recursive: true });
  }
  const logStream = fs.createWriteStream(ffmpegLogPath, { encoding: 'utf8' });

  let status: TestPlayoutRunDetail['status'] = 'running';
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | string | null = null;
  let endedAt: string | null = null;

  const writeStatus = (ffmpegStatus: TestPlayoutMonitoringSnapshot['ffmpegStatus']): TestPlayoutMonitoringSnapshot => {
    const snapshot = buildMonitoringSnapshot(
      status,
      ffmpegStatus,
      playlistItems,
      Date.parse(startedAt),
      validated.outputMode,
      validated.outputPath
    );
    writeJsonFile(statusPath, snapshot);
    return snapshot;
  };

  writeStatus('running');
  const heartbeat = setInterval(() => {
    writeStatus('running');
  }, 1000);

  let timedOut = false;
  let forcedKill = false;
  let cleanupFailed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = childProcess.spawn(commandPreview.executable, commandPreview.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timeoutMs = getFfmpegTimeoutMs(validated.durationLimitSeconds);
      const killGraceMs = getEnvPositiveInteger('TEST_PLAYOUT_FFMPEG_KILL_GRACE_MS') ?? DEFAULT_FFMPEG_KILL_GRACE_MS;
      const forceCloseMs = getEnvPositiveInteger('TEST_PLAYOUT_FFMPEG_FORCE_CLOSE_MS') ?? DEFAULT_FFMPEG_FORCE_CLOSE_MS;
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let sigkillTimer: NodeJS.Timeout | null = null;
      let forceCloseTimer: NodeJS.Timeout | null = null;

      const clearTimers = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
        timeoutTimer = null;
        sigkillTimer = null;
        forceCloseTimer = null;
      };

      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve();
      };

      const settleReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(err);
      };

      const requestKill = (killSignal: NodeJS.Signals): void => {
        try {
          child.kill(killSignal);
        } catch (err) {
          logStream.write(`\n[watchdog] Failed to send ${killSignal}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      };

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        signal = 'SIGTERM';
        logStream.write(`\n[watchdog] FFmpeg exceeded ${timeoutMs}ms isolated test timeout. Sending SIGTERM.\n`);
        requestKill('SIGTERM');

        sigkillTimer = setTimeout(() => {
          forcedKill = true;
          signal = 'SIGKILL';
          logStream.write('\n[watchdog] FFmpeg did not exit after SIGTERM. Sending SIGKILL.\n');
          requestKill('SIGKILL');

          forceCloseTimer = setTimeout(() => {
            cleanupFailed = true;
            settleReject(new Error('FFmpeg process did not close after timeout cleanup signals'));
          }, forceCloseMs);
        }, killGraceMs);
      }, timeoutMs);

      child.stdout?.on('data', chunk => {
        logStream.write(chunk);
      });
      child.stderr?.on('data', chunk => {
        logStream.write(chunk);
      });
      child.on('error', err => {
        settleReject(err);
      });
      child.on('close', (code, closeSignal) => {
        exitCode = code;
        signal = closeSignal ?? signal;
        settleResolve();
      });
    });

    status = exitCode === 0 && !timedOut ? 'completed' : 'failed';
    if (timedOut) {
      errors.push({
        code: forcedKill ? 'FFMPEG_TIMEOUT_FORCE_KILLED' : 'FFMPEG_TIMEOUT',
        message: `FFmpeg exceeded the isolated test timeout and was stopped${forcedKill ? ' with SIGKILL after SIGTERM did not close it' : ' with SIGTERM'}.`,
      });
    } else if (exitCode !== 0) {
      errors.push({
        code: 'FFMPEG_EXIT_NON_ZERO',
        message: `FFmpeg exited with code ${exitCode ?? 'null'}${signal ? ` and signal ${signal}` : ''}.`,
      });
    }
  } catch (err) {
    status = 'failed';
    errors.push({
      code: cleanupFailed ? 'FFMPEG_CLEANUP_FAILED' : 'FFMPEG_SPAWN_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearInterval(heartbeat);
    endedAt = new Date().toISOString();
    await new Promise<void>(resolve => {
      logStream.end(resolve);
    });
  }

  const monitoring = writeStatus(status === 'completed' ? 'completed' : 'failed');
  const detail: TestPlayoutRunDetail = {
    id: runId,
    sourcePlaylistPath: validated.sourcePlaylistPath,
    outputMode: validated.outputMode,
    outputPath: validated.outputPath,
    durationLimitSeconds: validated.durationLimitSeconds,
    status,
    startedAt,
    endedAt,
    exitCode,
    signal,
    commandPreview,
    artifacts: {
      runDir,
      statusPath,
      reportPath,
      ffmpegLogPath,
    },
    monitoring,
    safety: {
      ffmpegExecution: true,
      playoutStarted: true,
      broadcastStarted: false,
      rtmpPush: false,
      streamKeyUsage: false,
      cursorMutation: false,
      mediaAccess: true,
      dnsChanges: false,
      productionPaths: false,
    },
    errors,
  };

  writeJsonFile(path.join(runDir, 'run.json'), detail);
  fs.writeFileSync(reportPath, renderRunReport(detail), 'utf8');
  return detail;
}

export function readTestPlayoutPlan(id: string): TestPlayoutPlanDetail | null {
  const row = getDb().prepare('SELECT * FROM test_playout_plans WHERE id=?').get(id) as TestPlayoutPlanRow | undefined;
  return row ? rowToPlan(row) : null;
}

export function listTestPlayoutPlans(limit = 50): TestPlayoutPlanDetail[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM test_playout_plans
    ORDER BY created_at DESC
    LIMIT ?
  `).all(clampLimit(limit)) as TestPlayoutPlanRow[];
  return rows.map(rowToPlan);
}

function buildCommandPreview(validated: ValidatedTestPlayoutPlan): TestPlayoutCommandPreview {
  const ffconcatInput = validated.ffconcatInputPath;
  const args = validated.outputMode === 'local_file'
    ? [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'info',
        '-re',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        ffconcatInput,
        '-t',
        String(validated.durationLimitSeconds),
        '-movflags',
        '+faststart',
        '-y',
        validated.outputPath,
      ]
    : [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'info',
        '-re',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        ffconcatInput,
        '-t',
        String(validated.durationLimitSeconds),
        '-f',
        'hls',
        '-hls_time',
        '6',
        '-hls_list_size',
        '12',
        '-hls_segment_filename',
        path.join(validated.outputPath, 'seg%05d.ts'),
        path.join(validated.outputPath, 'index.m3u8'),
      ];

  return {
    executable: 'ffmpeg',
    args,
    command: ['ffmpeg', ...args.map(quoteArg)].join(' '),
    prepareOnly: true,
    willExecute: false,
    outputMode: validated.outputMode,
    outputPath: validated.outputPath,
    safety: {
      ffmpegExecution: false,
      playoutStarted: false,
      broadcastStarted: false,
      rtmpPush: false,
      streamKeyUsage: false,
      cursorMutation: false,
      mediaAccess: false,
      dnsChanges: false,
    },
    notes: [
      'Plan only. This command preview is not executed by this phase.',
      'The source playlist must already be file-expanded and paired with playlist.ffconcat.',
      'Output target is constrained to generated/test-playout.',
    ],
  };
}

function buildExecutableCommandPreview(
  validated: ValidatedTestPlayoutPlan
): TestPlayoutRunDetail['commandPreview'] {
  const preview = buildCommandPreview(validated);
  return {
    ...preview,
    prepareOnly: false,
    willExecute: true,
    safety: {
      ...preview.safety,
      ffmpegExecution: true,
      playoutStarted: true,
      mediaAccess: true,
    },
    notes: [
      'Isolated execution only. Output remains constrained to generated/test-playout.',
      'No RTMP, stream keys, DNS, production paths, OBS, or cursor mutation are allowed.',
      'Input is the approved playlist.ffconcat paired with the expanded playlist.json.',
    ],
  };
}

function validateTestPlayoutExecution(input: TestPlayoutRunInput, runId: string): ValidatedTestPlayoutPlan {
  rejectForbiddenInputStrings(input);

  if (input.confirmExecution !== true) {
    throw new DraftValidationError('Test playout execution requires confirmExecution=true', 'TEST_PLAYOUT_EXECUTION_CONFIRMATION_REQUIRED');
  }
  if (input.confirmationText !== EXECUTION_CONFIRMATION_TEXT) {
    throw new DraftValidationError(
      `Test playout execution requires confirmationText="${EXECUTION_CONFIRMATION_TEXT}"`,
      'TEST_PLAYOUT_EXECUTION_TEXT_REQUIRED'
    );
  }

  return validateTestPlayoutPlan({
    ...input,
    confirmPrepareOnly: true,
  }, runId);
}

function validateSourcePlaylistPath(value: unknown): string {
  const raw = cleanString(value);
  if (!raw) {
    throw new DraftValidationError('Dry-run playlist artifact path is required', 'SOURCE_PLAYLIST_PATH_REQUIRED');
  }

  const playlistRoot = getDefaultPlaylistRoot();
  const resolved = resolveProjectPath(raw);
  if (!isPathInside(resolved, playlistRoot) || path.basename(resolved) !== 'playlist.json') {
    throw new DraftValidationError('Source playlist must be generated/playlists/<runId>/playlist.json', 'UNSAFE_SOURCE_PLAYLIST_PATH');
  }
  if (!fs.existsSync(resolved)) {
    throw new DraftValidationError('Source dry-run playlist artifact was not found', 'SOURCE_PLAYLIST_NOT_FOUND', 404);
  }
  validateSourcePlaylistArtifact(resolved);
  return resolved;
}

function validateSourcePlaylistArtifact(playlistPath: string): void {
  const artifact = readPlaylistArtifact(playlistPath);

  if (artifact.mediaExpansionAvailable !== true) {
    throw new DraftValidationError(
      'Source playlist must be file-expanded before test playout planning',
      'SOURCE_PLAYLIST_NOT_EXPANDED'
    );
  }
  const items = validateExpandedPlaylistItems(artifact.items);

  const expectedFfconcatPath = getExpectedFfconcatPath(playlistPath);
  if (typeof artifact.ffconcatPath === 'string' && path.resolve(artifact.ffconcatPath) !== path.resolve(expectedFfconcatPath)) {
    throw new DraftValidationError('Source playlist ffconcat path does not match its run directory', 'SOURCE_PLAYLIST_FFCONCAT_MISMATCH');
  }
  if (!fs.existsSync(expectedFfconcatPath)) {
    throw new DraftValidationError('Source playlist ffconcat artifact was not found', 'SOURCE_PLAYLIST_FFCONCAT_NOT_FOUND', 404);
  }
  validateFfconcatMatchesExpandedItems(expectedFfconcatPath, items);
}

function readPlaylistArtifact(playlistPath: string): PlaylistArtifact {
  try {
    return JSON.parse(readUtf8JsonText(playlistPath)) as PlaylistArtifact;
  } catch {
    throw new DraftValidationError('Source playlist artifact is not valid JSON', 'SOURCE_PLAYLIST_INVALID');
  }
}

function validateExpandedPlaylistItems(itemsValue: unknown): SafeExpandedPlaylistItem[] {
  if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
    throw new DraftValidationError('Source playlist has no expanded media items', 'SOURCE_PLAYLIST_EMPTY');
  }

  return itemsValue.map((itemValue, index) => {
    if (!itemValue || typeof itemValue !== 'object') {
      throw new DraftValidationError('Source playlist contains an invalid expanded media item', 'SOURCE_PLAYLIST_ITEM_INVALID');
    }
    const item = itemValue as PlaylistArtifactItem;
    const itemLabel = typeof item.id === 'string' ? item.id : `item ${index + 1}`;

    if (item.validationStatus !== 'ready') {
      throw new DraftValidationError(
        `Source playlist item "${itemLabel}" is not ready for isolated playout`,
        'SOURCE_PLAYLIST_ITEM_NOT_READY'
      );
    }
    if (typeof item.absolutePath !== 'string' || item.absolutePath.trim() === '') {
      throw new DraftValidationError(
        `Source playlist item "${itemLabel}" has no absolute media path`,
        'SOURCE_PLAYLIST_MEDIA_PATH_REQUIRED'
      );
    }

    const absolutePath = validateLocalMediaInputPath(item.absolutePath, itemLabel);
    const durationSeconds = Number(item.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new DraftValidationError(
        `Source playlist item "${itemLabel}" has no positive QC duration`,
        'SOURCE_PLAYLIST_MEDIA_DURATION_REQUIRED'
      );
    }

    return {
      ...item,
      validationStatus: 'ready',
      absolutePath,
      durationSeconds,
      isTrimmed: item.isTrimmed === true,
    };
  });
}

function validateLocalMediaInputPath(value: string, itemLabel: string): string {
  const raw = value.trim();
  rejectForbiddenString(raw, `playlist.items.${itemLabel}.absolutePath`);
  if (hasFfconcatControlCharacters(raw)) {
    throw new DraftValidationError(
      `Source playlist item "${itemLabel}" media path contains characters that are unsafe for ffconcat`,
      'SOURCE_PLAYLIST_MEDIA_PATH_UNSAFE'
    );
  }

  if (!path.isAbsolute(raw)) {
    throw new DraftValidationError(
      `Source playlist item "${itemLabel}" media path must be absolute`,
      'SOURCE_PLAYLIST_MEDIA_PATH_UNSAFE'
    );
  }

  const resolved = path.resolve(raw);
  const normalized = resolved.replace(/\\/g, '/').toLowerCase();
  if (
    normalized.includes('/obs') ||
    normalized.includes('obs-studio') ||
    normalized.includes('old-obs') ||
    normalized.includes('/var/www') ||
    normalized.includes('/srv/daawah/live')
  ) {
    throw new DraftValidationError(
      `Source playlist item "${itemLabel}" points at a forbidden playout path`,
      'SOURCE_PLAYLIST_MEDIA_PATH_FORBIDDEN'
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new DraftValidationError(
      `Source playlist item "${itemLabel}" media file was not found`,
      'SOURCE_PLAYLIST_MEDIA_FILE_NOT_FOUND',
      404
    );
  }
  return resolved;
}

function validateFfconcatMatchesExpandedItems(ffconcatPath: string, items: SafeExpandedPlaylistItem[]): void {
  const expected = renderVerifiedFfconcat(items);
  const actual = readTextFile(ffconcatPath).replace(/\r\n/g, '\n');
  if (actual !== expected) {
    throw new DraftValidationError(
      'Source playlist ffconcat does not exactly match expanded playlist media items',
      'SOURCE_PLAYLIST_FFCONCAT_MISMATCH'
    );
  }
}

function writeVerifiedFfconcat(
  playlistPath: string,
  runDir: string,
  items: PlaylistArtifactItem[]
): string {
  const artifact = readPlaylistArtifact(playlistPath);
  const safeItems = validateExpandedPlaylistItems(artifact.items ?? items);
  const verifiedPath = path.join(runDir, 'verified-playlist.ffconcat');
  fs.writeFileSync(verifiedPath, renderVerifiedFfconcat(safeItems), 'utf8');
  return verifiedPath;
}

function getExpectedFfconcatPath(playlistPath: string): string {
  return path.join(path.dirname(playlistPath), 'playlist.ffconcat');
}

function validateOutputPath(value: unknown, outputMode: TestPlayoutOutputMode, planId: string): string {
  const defaultOutput = getDefaultOutputPath(outputMode, planId);
  const raw = cleanString(value);
  if (!raw) {
    return defaultOutput;
  }

  const resolved = resolveProjectPath(raw);
  if (!isPathInside(resolved, getDefaultTestPlayoutRoot())) {
    throw new DraftValidationError('Test playout output must stay under generated/test-playout', 'UNSAFE_TEST_PLAYOUT_OUTPUT_PATH');
  }
  if (path.resolve(resolved) !== path.resolve(defaultOutput)) {
    throw new DraftValidationError('Custom test playout output paths are not allowed in this phase', 'CUSTOM_TEST_PLAYOUT_OUTPUT_NOT_ALLOWED');
  }
  return resolved;
}

function normalizeOutputMode(value: unknown): TestPlayoutOutputMode {
  if (value === 'local_file' || value === undefined || value === null || value === '') {
    return 'local_file';
  }
  if (value === 'localhost_hls') {
    return 'localhost_hls';
  }
  throw new DraftValidationError('Output mode must be local_file or localhost_hls', 'INVALID_TEST_PLAYOUT_OUTPUT_MODE');
}

function normalizeDurationLimit(value: unknown): number {
  const numberValue = value === undefined || value === null || value === ''
    ? MAX_DURATION_LIMIT_SECONDS
    : Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new DraftValidationError('Duration limit must be a positive integer number of seconds', 'INVALID_TEST_PLAYOUT_DURATION_LIMIT');
  }
  if (numberValue > MAX_DURATION_LIMIT_SECONDS) {
    throw new DraftValidationError('Duration limit cannot exceed 20 minutes', 'TEST_PLAYOUT_DURATION_LIMIT_TOO_LONG');
  }
  return numberValue;
}

function rejectForbiddenInputStrings(input: unknown, pathParts: string[] = []): void {
  if (typeof input === 'string') {
    rejectForbiddenString(input, pathParts.join('.'));
    return;
  }
  if (Array.isArray(input)) {
    input.forEach((value, index) => rejectForbiddenInputStrings(value, [...pathParts, String(index)]));
    return;
  }
  if (!input || typeof input !== 'object') return;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    rejectForbiddenInputStrings(value, [...pathParts, key]);
  }
}

function rejectForbiddenString(value: string, keyPath: string): void {
  const raw = value.trim();
  if (!raw) return;
  const normalized = raw.replace(/\\/g, '/').toLowerCase();
  const normalizedKey = keyPath.toLowerCase();

  if (normalized.startsWith('rtmp://') || normalized.startsWith('rtmps://')) {
    throw new DraftValidationError('RTMP and RTMPS targets are forbidden for test playout planning', 'RTMP_TARGET_FORBIDDEN');
  }
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    throw new DraftValidationError('HTTP/HTTPS live output targets are forbidden for test playout planning', 'LIVE_URL_FORBIDDEN');
  }
  if (normalized.includes('/srv/daawah/media') && normalizedKey.includes('output')) {
    throw new DraftValidationError('Media folder paths are forbidden for test playout output planning', 'MEDIA_PATH_FORBIDDEN');
  }
  if (normalized.includes('/obs') || normalized.includes('obs-studio') || normalized.includes('old-obs')) {
    throw new DraftValidationError('Old OBS paths are forbidden for test playout planning', 'OLD_OBS_PATH_FORBIDDEN');
  }
  if (normalized.includes('/var/www') || normalized.includes('/srv/daawah/live') || normalized.includes('production')) {
    throw new DraftValidationError('Production paths are forbidden for test playout planning', 'PRODUCTION_PATH_FORBIDDEN');
  }
  if ((normalizedKey.includes('stream') || normalizedKey.includes('key') || normalizedKey.includes('url')) && raw.length > 0) {
    throw new DraftValidationError('Stream URLs and stream-key fields are forbidden for test playout planning', 'STREAM_KEY_FORBIDDEN');
  }
  if (/stream[_-]?key|sk_live|live[_-]?key/i.test(raw)) {
    throw new DraftValidationError('Stream-key-looking values are forbidden for test playout planning', 'STREAM_KEY_FORBIDDEN');
  }
}

function getDefaultOutputPath(outputMode: TestPlayoutOutputMode, planId: string): string {
  const runRoot = path.join(getDefaultTestPlayoutRoot(), planId);
  return outputMode === 'local_file'
    ? path.join(runRoot, 'output.mp4')
    : path.join(runRoot, 'hls');
}

function getDefaultPlaylistRoot(): string {
  return path.join(getProjectRoot(), 'generated', 'playlists');
}

function getDefaultTestPlayoutRoot(): string {
  return path.join(getProjectRoot(), 'generated', 'test-playout');
}

function getProjectRoot(): string {
  return path.resolve(
    process.env['TEST_PLAYOUT_PROJECT_ROOT'] ??
    process.env['PLAYLIST_MATERIALIZATION_PROJECT_ROOT'] ??
    path.resolve(__dirname, '../../..')
  );
}

function resolveProjectPath(value: string): string {
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(getProjectRoot(), value);
}

function rowToPlan(row: TestPlayoutPlanRow): TestPlayoutPlanDetail {
  return {
    id: row.id,
    sourcePlaylistPath: row.source_playlist_path,
    outputMode: row.output_mode,
    outputPath: row.output_path,
    durationLimitSeconds: row.duration_limit_seconds,
    status: row.status,
    commandPreview: JSON.parse(row.command_preview_json) as TestPlayoutCommandPreview,
    warnings: JSON.parse(row.warnings_json) as TestPlayoutWarning[],
    errors: JSON.parse(row.errors_json) as TestPlayoutError[],
    createdAt: row.created_at,
  };
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit)) return 50;
  return Math.min(Math.max(limit, 1), 100);
}

function readPlaylistItems(playlistPath: string): PlaylistArtifactItem[] {
  const artifact = JSON.parse(readUtf8JsonText(playlistPath)) as { items?: unknown };
  return Array.isArray(artifact.items) ? artifact.items as PlaylistArtifactItem[] : [];
}

function readUtf8JsonText(filePath: string): string {
  return readTextFile(filePath);
}

function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

function renderVerifiedFfconcat(items: SafeExpandedPlaylistItem[]): string {
  const lines = ['ffconcat version 1.0'];
  for (const item of items) {
    lines.push(formatConcatFileLine(item.absolutePath));
    if (item.isTrimmed) {
      const seconds = formatSeconds(item.durationSeconds);
      lines.push(`outpoint ${seconds}`);
      lines.push(`duration ${seconds}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatConcatFileLine(filePath: string): string {
  assertFfconcatPathSafe(filePath);
  return `file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

function formatSeconds(seconds: number): string {
  return seconds.toFixed(3);
}

function assertFfconcatPathSafe(filePath: string): void {
  if (hasFfconcatControlCharacters(filePath)) {
    throw new DraftValidationError(
      'Media path contains characters that are unsafe for ffconcat',
      'SOURCE_PLAYLIST_MEDIA_PATH_UNSAFE'
    );
  }
}

function hasFfconcatControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function getFfmpegTimeoutMs(durationLimitSeconds: number): number {
  return getEnvPositiveInteger('TEST_PLAYOUT_FFMPEG_TIMEOUT_MS') ??
    (durationLimitSeconds + DEFAULT_FFMPEG_TIMEOUT_GRACE_SECONDS) * 1000;
}

function getEnvPositiveInteger(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildMonitoringSnapshot(
  status: TestPlayoutMonitoringSnapshot['status'],
  ffmpegStatus: TestPlayoutMonitoringSnapshot['ffmpegStatus'],
  items: PlaylistArtifactItem[],
  startedAtMs: number,
  outputMode: TestPlayoutOutputMode,
  outputPath: string
): TestPlayoutMonitoringSnapshot {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const currentItem = items.find(item =>
    typeof item.timelineStartSeconds === 'number' &&
    typeof item.timelineEndSeconds === 'number' &&
    item.timelineStartSeconds <= elapsedSeconds &&
    item.timelineEndSeconds > elapsedSeconds
  ) ?? null;
  const nextItem = items.find(item =>
    typeof item.timelineStartSeconds === 'number' &&
    item.timelineStartSeconds > elapsedSeconds
  ) ?? null;
  const output = inspectOutput(outputMode, outputPath);
  const memory = process.memoryUsage();

  return {
    heartbeatAt: new Date().toISOString(),
    status,
    currentItem,
    nextItem,
    elapsedSeconds,
    driftSeconds: 0,
    ffmpegStatus,
    output,
    process: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
  };
}

function inspectOutput(outputMode: TestPlayoutOutputMode, outputPath: string): TestPlayoutMonitoringSnapshot['output'] {
  if (outputMode === 'localhost_hls') {
    const exists = fs.existsSync(path.join(outputPath, 'index.m3u8'));
    const hlsSegmentCount = fs.existsSync(outputPath)
      ? fs.readdirSync(outputPath).filter(file => file.endsWith('.ts')).length
      : 0;
    return {
      mode: outputMode,
      path: outputPath,
      exists,
      sizeBytes: null,
      hlsSegmentCount,
    };
  }

  const exists = fs.existsSync(outputPath);
  return {
    mode: outputMode,
    path: outputPath,
    exists,
    sizeBytes: exists ? fs.statSync(outputPath).size : null,
    hlsSegmentCount: null,
  };
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function renderRunReport(detail: TestPlayoutRunDetail): string {
  const errorLines = detail.errors.length > 0
    ? detail.errors.map(error => `- ${error.code}: ${error.message}`).join('\n')
    : '- none';
  return `# Isolated Test Playout Report

## Summary

- Run ID: ${detail.id}
- Status: ${detail.status}
- Source playlist: ${detail.sourcePlaylistPath}
- Output mode: ${detail.outputMode}
- Output path: ${detail.outputPath}
- Duration limit seconds: ${detail.durationLimitSeconds}
- Started at: ${detail.startedAt}
- Ended at: ${detail.endedAt ?? 'running'}
- FFmpeg exit code: ${detail.exitCode ?? 'null'}

## Monitoring

- Last heartbeat: ${detail.monitoring.heartbeatAt}
- Current item: ${detail.monitoring.currentItem?.title ?? 'none'}
- Next item: ${detail.monitoring.nextItem?.title ?? 'none'}
- Drift seconds: ${detail.monitoring.driftSeconds}
- Output exists: ${detail.monitoring.output.exists}
- HLS segment count: ${detail.monitoring.output.hlsSegmentCount ?? 'n/a'}

## Safety

- ffmpeg execution: true
- broadcast started: false
- RTMP push: false
- stream key usage: false
- cursor mutation: false
- DNS changes: false
- production paths: false

## Errors

${errorLines}
`;
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
