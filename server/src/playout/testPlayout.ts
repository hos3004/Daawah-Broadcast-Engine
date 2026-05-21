import fs from 'fs';
import path from 'path';
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

interface ValidatedTestPlayoutPlan {
  planId: string;
  sourcePlaylistPath: string;
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
  const futureInput = '<future-ffconcat-from-approved-playlist-json>';
  const args = validated.outputMode === 'local_file'
    ? [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'info',
        '-i',
        futureInput,
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
        '-i',
        futureInput,
        '-t',
        String(validated.durationLimitSeconds),
        '-f',
        'hls',
        '-hls_time',
        '6',
        '-hls_list_size',
        '12',
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
      'Playlist JSON to executable input conversion is reserved for a later approved phase.',
      'Output target is constrained to generated/test-playout.',
    ],
  };
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
  return resolved;
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

function rejectForbiddenInputStrings(input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    const raw = value.trim();
    if (!raw) continue;
    const normalized = raw.replace(/\\/g, '/').toLowerCase();
    const normalizedKey = key.toLowerCase();

    if (normalized.startsWith('rtmp://') || normalized.startsWith('rtmps://')) {
      throw new DraftValidationError('RTMP and RTMPS targets are forbidden for test playout planning', 'RTMP_TARGET_FORBIDDEN');
    }
    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
      throw new DraftValidationError('HTTP/HTTPS live output targets are forbidden for test playout planning', 'LIVE_URL_FORBIDDEN');
    }
    if (normalized.includes('/srv/daawah/media')) {
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

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
