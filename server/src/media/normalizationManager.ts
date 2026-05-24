import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getDb } from '../db/schema';
import { diskUsage, formatBytes } from '../utils/fileUtils';
import { buildAudioNormAf, buildVideoNormVf } from './normalizer';
import {
  getActiveScheduleState,
  getPublishedSchedule,
  type PublishedScheduleDetail,
} from '../schedule/drafts';
import { expandPublishedScheduleToFiles } from '../schedule/playlistExpansion';

export const NORMALIZATION_EXECUTION_CONFIRMATION_TEXT = 'RUN SMART NORMALIZATION';

export type NormalizationScope = 'active_schedule' | 'published_schedule' | 'media_roots';
export type NormalizationDecision = 'ok' | 'remux' | 'audio-only' | 'full-transcode' | 'failed';
export type NormalizationReason =
  | 'missing'
  | 'duration'
  | 'sample_rate'
  | 'audio_codec'
  | 'fps'
  | 'resolution'
  | 'pix_fmt'
  | 'video_codec'
  | 'bitrate'
  | 'container'
  | 'unscanned';

export interface NormalizationTargetProfile {
  width: number;
  height: number;
  fps: number;
  videoCodec: 'h264';
  pixelFormat: 'yuv420p';
  audioCodec: 'aac';
  audioRate: number;
  audioChannels: 2;
  audioBitrate: '192k';
  videoBitrate: '2500k';
  videoMaxrate: '3500k';
  videoBufsize: '7000k';
  maxVideoBitrate: 3500000;
  container: 'mp4';
}

export interface NormalizationPreflightInput {
  scope?: NormalizationScope;
  publishedScheduleId?: string;
  rootKeys?: string[];
  limit?: number;
}

export interface NormalizationPlanInput extends NormalizationPreflightInput {
  confirmDryRun?: boolean;
}

export interface NormalizationRunInput {
  planId?: string;
  confirmExecution?: boolean;
  confirmationText?: string;
}

export interface NormalizationStopInput {
  runId?: string;
}

export interface NormalizationProbeSnapshot {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  pixelFormat: string | null;
  bitrate: number | null;
  audioRate: number | null;
}

export interface NormalizationPreflightItem {
  id: string;
  mediaFileId: string | null;
  sourceRole: string;
  title: string;
  rootKey: string | null;
  absolutePath: string;
  relativePath: string | null;
  normalizedPath: string;
  exists: boolean;
  decision: NormalizationDecision;
  reasons: NormalizationReason[];
  probe: NormalizationProbeSnapshot;
}

export interface NormalizationSummary {
  total: number;
  ok: number;
  remux: number;
  audioOnly: number;
  fullTranscode: number;
  failed: number;
  reasons: Record<NormalizationReason, number>;
  canPublishNormalizedSet: boolean;
  acceptance: {
    failedMustBe: 0;
    durationKnown: true;
    video: '1280x720 25fps h264 yuv420p';
    audio: 'AAC 48k stereo 192k';
    timestamps: 'reset by normalization filtergraph';
  };
}

export interface NormalizationPreflightResult {
  mode: 'normalization-preflight';
  scope: NormalizationScope;
  target: NormalizationTargetProfile;
  outputRoot: string;
  items: NormalizationPreflightItem[];
  summary: NormalizationSummary;
  errors: Array<{ code: string; message: string; itemId?: string }>;
  safety: NormalizationSafety;
}

export interface NormalizationPlanTask {
  id: string;
  mediaFileId: string | null;
  inputPath: string;
  outputPath: string;
  decision: Exclude<NormalizationDecision, 'ok'>;
  reasons: NormalizationReason[];
  ffmpegWillRun: false;
  commandPreview: string;
}

export interface NormalizationPlanDetail {
  id: string;
  scope: NormalizationScope;
  status: 'dry_run_ready' | 'blocked';
  outputRoot: string;
  artifactPath: string;
  target: NormalizationTargetProfile;
  summary: NormalizationSummary;
  items: NormalizationPreflightItem[];
  tasks: NormalizationPlanTask[];
  errors: Array<{ code: string; message: string; itemId?: string }>;
  createdBy: string | null;
  createdAt: string;
  safety: NormalizationSafety;
}

export interface NormalizationRunDetail {
  id: string;
  planId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  outputRoot: string;
  artifactPath: string;
  logPath: string;
  startedAt: string;
  endedAt: string | null;
  currentTaskId: string | null;
  currentFile: string | null;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  outputSizeBytes: number;
  completedCount: number;
  failedCount: number;
  totalCount: number;
  errors: Array<{ code: string; message: string; taskId?: string }>;
  safety: {
    normalizedMediaWrites: true;
    originalMediaModification: false;
    playlistActivation: false;
    playout: false;
    broadcast: false;
    outputRoot: string;
  };
}

export interface NormalizationRunLog {
  runId: string;
  path: string;
  exists: boolean;
  text: string;
}

export interface NormalizedSetInput {
  runId?: string;
  confirmPublish?: boolean;
}

export interface NormalizedSetDiffItem {
  mediaFileId: string | null;
  title: string;
  decision: NormalizationDecision;
  originalPath: string;
  normalizedPath: string;
  normalizedExists: boolean;
  originalSafeFallback: boolean;
}

export interface NormalizedSetDetail {
  id: string;
  runId: string;
  planId: string;
  status: 'ready' | 'blocked';
  outputRoot: string;
  artifactPath: string;
  diffPath: string;
  summary: {
    total: number;
    normalizedReady: number;
    originalSafeFallback: number;
    missingNormalized: number;
    failed: number;
    canUseForPlaylist: boolean;
  };
  diff: NormalizedSetDiffItem[];
  createdAt: string;
  safety: {
    deletesOriginal: false;
    mediaModification: false;
    playlistActivation: false;
    playout: false;
    broadcast: false;
  };
}

export interface NormalizationStatus {
  mode: 'normalization-status';
  target: NormalizationTargetProfile;
  outputRoot: string;
  roots: Array<{ rootKey: string; absolutePath: string; isReadonly: boolean; isOriginalLibrary: boolean }>;
  latestPlan: NormalizationPlanDetail | null;
  safety: {
    readOnly: true;
    ffmpegExecution: false;
    mediaModification: false;
    broadcast: false;
  };
}

export interface ServerNormalizationProcessInfo {
  pid: number;
  ppid: number | null;
  pgid: number | null;
  nice: number | null;
  cpuPercent: number;
  stat: string | null;
  command: string;
}

export interface ServerNormalizationJobStatus {
  key: 'fix_existing_normalized' | 'continue_original_ar' | 'priority_hajj_map' | 'hajj10_source';
  label: string;
  scriptPath: string;
  pidPath: string;
  outputPath: string;
  reportPath: string | null;
  pid: number | null;
  pgid: number | null;
  running: boolean;
  done: boolean;
  progress: {
    current: number | null;
    total: number | null;
    percent: number | null;
  };
  counts: {
    ok: number;
    failed: number;
    fix: number;
    noAction: number;
    remux: number;
    audioOnly: number;
    fullTranscode: number;
    normalized: number;
    existingValid: number;
    promotedReady: number;
    needsNormalize: number;
    deletedOriginal: number;
    other: number;
  };
  cpuPercent: number;
  lastLines: string[];
  processes: ServerNormalizationProcessInfo[];
}

export interface ServerNormalizationStatus {
  mode: 'server-normalization-status';
  phase: 'fix_running' | 'continue_running' | 'priority_hajj_running' | 'hajj10_source_running' | 'ready_for_continue' | 'idle';
  generatedAt: string;
  server: {
    hostname: string;
    platform: string;
    cpuCount: number;
    loadAverage: [number, number, number];
  };
  paths: {
    originalRoot: string;
    normalizedRoot: string;
    originalSize: string;
    normalizedSize: string;
  };
  disk: {
    path: string;
    usedBytes: number;
    totalBytes: number;
    freeBytes: number;
    percent: number;
    usedLabel: string;
    totalLabel: string;
    freeLabel: string;
  };
  throttle: {
    pidPath: string;
    logPath: string;
    pid: number | null;
    running: boolean;
    lastLines: string[];
  };
  fixJob: ServerNormalizationJobStatus;
  continueJob: ServerNormalizationJobStatus;
  priorityHajjJob: ServerNormalizationJobStatus;
  hajj10SourceJob: ServerNormalizationJobStatus;
  guidance: {
    canStartContinue: boolean;
    reason: string;
  };
}

export interface ServerNormalizationNextTaskConfig {
  sourceRoot: string;
  outputRoot: string;
  maxParallel: number;
  nice: number;
  ioniceClass: 2 | 3;
  ioniceLevel: number;
  maxVideoBitrate: number;
  videoBitrate: string;
  videoMaxrate: string;
  videoBufsize: string;
  audioBitrate: string;
  deleteOriginalAfterValidation: boolean;
  requireFixDoneBeforeContinue: boolean;
}

export interface ServerNormalizationNextTask {
  mode: 'server-normalization-next-task';
  config: ServerNormalizationNextTaskConfig;
  envPreview: Record<string, string>;
  commandPreview: string;
  safety: {
    startsAutomatically: false;
    scriptPath: '/tmp/continue_normalize_ar_server.sh';
    pidPath: '/tmp/continue_normalize_ar_server.pid';
    outputPath: '/tmp/continue_normalize_ar_server.out';
    deletesOriginalOnlyAfterValidation: boolean;
    requiresFixDoneBeforeContinue: boolean;
  };
}

export interface NormalizationSafety {
  readOnlyScan: true;
  dryRun: true;
  writesGeneratedArtifactsOnly: true;
  outputRootPreparedOnly: true;
  normalizedMediaWrites: false;
  originalMediaModification: false;
  ffmpegExecution: false;
  playlistActivation: false;
  playout: false;
  broadcast: false;
}

interface MediaFileRow {
  id: string;
  path: string;
  relative_path: string | null;
  original_relative_path: string | null;
  filename: string;
  original_filename: string | null;
  type: string;
  status: string;
  duration_sec: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  pixel_format: string | null;
  bitrate: number | null;
  audio_rate: number | null;
  root_key: string | null;
  root_absolute_path: string | null;
}

interface NormalizationPlanRow {
  id: string;
  scope: NormalizationScope;
  status: 'dry_run_ready' | 'blocked';
  output_root: string;
  artifact_path: string;
  target_json: string;
  summary_json: string;
  items_json: string;
  tasks_json: string;
  errors_json: string;
  created_by: string | null;
  created_at: string;
}

interface NormalizationRunRow {
  id: string;
  plan_id: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  output_root: string;
  artifact_path: string;
  log_path: string;
  started_at: string;
  ended_at: string | null;
  current_task_id: string | null;
  current_file: string | null;
  elapsed_seconds: number;
  estimated_remaining_seconds: number | null;
  output_size_bytes: number;
  completed_count: number;
  failed_count: number;
  total_count: number;
  errors_json: string;
}

interface NormalizedSetRow {
  id: string;
  run_id: string;
  plan_id: string;
  status: 'ready' | 'blocked';
  output_root: string;
  artifact_path: string;
  diff_path: string;
  summary_json: string;
  diff_json: string;
  created_at: string;
}

export class NormalizationManagerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

interface ActiveNormalizationRun {
  runId: string;
  child: childProcess.ChildProcess | null;
  stopRequested: boolean;
}

const DEFAULT_ROOT_KEYS = ['original-ar'];
const ORIGINAL_MEDIA_ROOT = '/srv/daawah/media/original-ar';
const NORMALIZED_MEDIA_ROOT = '/srv/daawah/media/normalized-ar';
const FIX_NORMALIZED_SCRIPT_PATH = '/tmp/fix_normalized_ar_server.sh';
const FIX_NORMALIZED_PID_PATH = '/tmp/fix_normalized_ar_server.pid';
const FIX_NORMALIZED_OUTPUT_PATH = '/tmp/fix_normalized_ar_server.out';
const CONTINUE_NORMALIZE_SCRIPT_PATH = '/tmp/continue_normalize_ar_server.sh';
const CONTINUE_NORMALIZE_PYTHON_PATH = '/tmp/continue_normalize_ar_server.py';
const CONTINUE_NORMALIZE_PID_PATH = '/tmp/continue_normalize_ar_server.pid';
const CONTINUE_NORMALIZE_OUTPUT_PATH = '/tmp/continue_normalize_ar_server.out';
const PRIORITY_HAJJ_NORMALIZE_PID_PATH = '/tmp/priority_hajj_normalize.pid';
const PRIORITY_HAJJ_NORMALIZE_OUTPUT_PATH = '/tmp/priority_hajj_normalize.out';
const HAJJ10_SOURCE_NORMALIZE_PID_PATH = '/tmp/hajj10_source_normalize.pid';
const HAJJ10_SOURCE_NORMALIZE_OUTPUT_PATH = '/tmp/hajj10_source_normalize.out';
const FIX_THROTTLE_PID_PATH = '/tmp/fix_normalized_ar_throttle.pid';
const FIX_THROTTLE_LOG_PATH = '/tmp/fix_normalized_ar_throttle.out';
const CONTINUE_THROTTLE_PID_PATH = '/tmp/continue_normalize_ar_throttle.pid';
const CONTINUE_THROTTLE_LOG_PATH = '/tmp/continue_normalize_ar_throttle.out';
const NORMALIZATION_NEXT_TASK_SETTING_KEY = 'normalization_next_task_config';
const DECISIONS: NormalizationDecision[] = ['ok', 'remux', 'audio-only', 'full-transcode', 'failed'];
const REASONS: NormalizationReason[] = [
  'missing',
  'duration',
  'sample_rate',
  'audio_codec',
  'fps',
  'resolution',
  'pix_fmt',
  'video_codec',
  'bitrate',
  'container',
  'unscanned',
];
const activeNormalizationRuns = new Map<string, ActiveNormalizationRun>();

export function getNormalizationStatus(): NormalizationStatus {
  const db = getDb();
  const roots = db.prepare(`
    SELECT root_key, absolute_path, is_readonly, is_original_library
    FROM media_roots
    WHERE root_key IN ('original-ar','source','bumpers','normalized-ar')
    ORDER BY CASE root_key
      WHEN 'original-ar' THEN 0
      WHEN 'source' THEN 1
      WHEN 'bumpers' THEN 2
      WHEN 'normalized-ar' THEN 3
      ELSE 4
    END
  `).all() as Array<{
    root_key: string;
    absolute_path: string;
    is_readonly: number;
    is_original_library: number;
  }>;

  return {
    mode: 'normalization-status',
    target: getTargetProfile(),
    outputRoot: getNormalizedOutputRoot(),
    roots: roots.map(root => ({
      rootKey: root.root_key,
      absolutePath: root.absolute_path,
      isReadonly: root.is_readonly === 1,
      isOriginalLibrary: root.is_original_library === 1,
    })),
    latestPlan: listNormalizationPlans(1)[0] ?? null,
    safety: {
      readOnly: true,
      ffmpegExecution: false,
      mediaModification: false,
      broadcast: false,
    },
  };
}

export function getServerNormalizationStatus(): ServerNormalizationStatus {
  const fixJob = readServerNormalizationJob({
    key: 'fix_existing_normalized',
    label: 'Fix existing normalized-ar',
    scriptPath: FIX_NORMALIZED_SCRIPT_PATH,
    pidPath: FIX_NORMALIZED_PID_PATH,
    outputPath: FIX_NORMALIZED_OUTPUT_PATH,
    reportPattern: /^fix_existing_normalized_.*\.csv$/,
  });
  const continueJob = readServerNormalizationJob({
    key: 'continue_original_ar',
    label: 'Continue original-ar normalize',
    scriptPath: CONTINUE_NORMALIZE_SCRIPT_PATH,
    alternateScriptPaths: [CONTINUE_NORMALIZE_PYTHON_PATH],
    pidPath: CONTINUE_NORMALIZE_PID_PATH,
    outputPath: CONTINUE_NORMALIZE_OUTPUT_PATH,
    reportPattern: /^(continue|normalize).*\.csv$/,
    inferFromScriptName: false,
  });
  const priorityHajjJob = readServerNormalizationJob({
    key: 'priority_hajj_map',
    label: 'Priority Hajj map normalize',
    scriptPath: CONTINUE_NORMALIZE_SCRIPT_PATH,
    alternateScriptPaths: [CONTINUE_NORMALIZE_PYTHON_PATH],
    pidPath: PRIORITY_HAJJ_NORMALIZE_PID_PATH,
    outputPath: PRIORITY_HAJJ_NORMALIZE_OUTPUT_PATH,
    reportPattern: /^continue_normalize_ar_.*\.csv$/,
    inferFromScriptName: false,
  });
  const hajj10SourceJob = readServerNormalizationJob({
    key: 'hajj10_source',
    label: 'Hajj-10 source normalize',
    scriptPath: CONTINUE_NORMALIZE_SCRIPT_PATH,
    alternateScriptPaths: [CONTINUE_NORMALIZE_PYTHON_PATH],
    pidPath: HAJJ10_SOURCE_NORMALIZE_PID_PATH,
    outputPath: HAJJ10_SOURCE_NORMALIZE_OUTPUT_PATH,
    reportPattern: /^continue_normalize_ar_.*\.csv$/,
    inferFromScriptName: false,
  });
  const activeJob = [hajj10SourceJob, priorityHajjJob, continueJob, fixJob].find(job => job.running) ?? null;
  const throttlePaths = activeJob && activeJob.key !== 'fix_existing_normalized'
    ? {
        pidPath: CONTINUE_THROTTLE_PID_PATH,
        logPath: CONTINUE_THROTTLE_LOG_PATH,
        scriptPath: '/tmp/throttle_continue_normalize_ar.sh',
      }
    : {
        pidPath: FIX_THROTTLE_PID_PATH,
        logPath: FIX_THROTTLE_LOG_PATH,
        scriptPath: '/tmp/throttle_fix_normalized_ar.sh',
      };
  const throttleProcess = readThrottleProcess(throttlePaths.scriptPath);
  const throttlePid = throttleProcess?.pid ?? readPidFile(throttlePaths.pidPath);
  const throttleRunning = (throttlePid !== null && isPidRunning(throttlePid)) || throttleProcess !== null;
  const rawDisk = diskUsage('/srv');
  const freeBytes = Math.max(0, rawDisk.total - rawDisk.used);
  const phase: ServerNormalizationStatus['phase'] = hajj10SourceJob.running
    ? 'hajj10_source_running'
    : priorityHajjJob.running
      ? 'priority_hajj_running'
      : continueJob.running
        ? 'continue_running'
        : fixJob.running
          ? 'fix_running'
          : fixJob.done
            ? 'ready_for_continue'
            : 'idle';
  const canStartContinue = activeJob === null && phase === 'ready_for_continue' && fixJob.counts.failed === 0;

  return {
    mode: 'server-normalization-status',
    phase,
    generatedAt: new Date().toISOString(),
    server: {
      hostname: os.hostname(),
      platform: os.platform(),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg() as [number, number, number],
    },
    paths: {
      originalRoot: ORIGINAL_MEDIA_ROOT,
      normalizedRoot: getNormalizedOutputRoot(),
      originalSize: directorySizeLabel(ORIGINAL_MEDIA_ROOT),
      normalizedSize: directorySizeLabel(getNormalizedOutputRoot()),
    },
    disk: {
      path: '/srv',
      usedBytes: rawDisk.used,
      totalBytes: rawDisk.total,
      freeBytes,
      percent: rawDisk.percent,
      usedLabel: formatBytes(rawDisk.used),
      totalLabel: formatBytes(rawDisk.total),
      freeLabel: formatBytes(freeBytes),
    },
    throttle: {
      pidPath: throttlePaths.pidPath,
      logPath: throttlePaths.logPath,
      pid: throttlePid,
      running: throttleRunning,
      lastLines: tailLines(throttlePaths.logPath, 12),
    },
    fixJob,
    continueJob,
    priorityHajjJob,
    hajj10SourceJob,
    guidance: {
      canStartContinue,
      reason: activeJob
        ? `${activeJob.label} is already running.`
        : fixJob.running
          ? 'Wait for the fix_existing_normalized job to print DONE.'
          : !fixJob.done
            ? 'No completed fix_existing_normalized DONE marker was found yet.'
            : fixJob.counts.failed > 0
              ? 'Fix job is done but has failed rows. Resolve them before continue normalize.'
              : 'Fix job is done with failed=0. Continue normalize can be prepared for the next step.',
    },
  };
}

export function getServerNormalizationNextTask(): ServerNormalizationNextTask {
  return buildServerNormalizationNextTask(readServerNormalizationNextTaskConfig());
}

export function saveServerNormalizationNextTask(
  input: Partial<ServerNormalizationNextTaskConfig>
): ServerNormalizationNextTask {
  const configValue = sanitizeServerNormalizationNextTaskConfig(input, readServerNormalizationNextTaskConfig());
  getDb().prepare(`
    INSERT OR REPLACE INTO settings (key, value, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), NULL)
  `).run(NORMALIZATION_NEXT_TASK_SETTING_KEY, JSON.stringify(configValue));
  return buildServerNormalizationNextTask(configValue);
}

export function createNormalizationPreflight(input: NormalizationPreflightInput = {}): NormalizationPreflightResult {
  const scope = input.scope ?? 'media_roots';
  const rows = readMediaRowsForScope(scope, input);
  const items = rows.map((row, index) => buildPreflightItem(row, index));
  const errors = buildPreflightErrors(items);

  return {
    mode: 'normalization-preflight',
    scope,
    target: getTargetProfile(),
    outputRoot: getNormalizedOutputRoot(),
    items,
    summary: buildSummary(items),
    errors,
    safety: getDryRunSafety(),
  };
}

export function createNormalizationPlanDryRun(
  input: NormalizationPlanInput,
  createdBy: string | null
): NormalizationPlanDetail {
  if (input.confirmDryRun !== true) {
    throw new NormalizationManagerError(
      'Normalization plan dry-run requires confirmDryRun=true',
      'NORMALIZATION_DRY_RUN_CONFIRMATION_REQUIRED'
    );
  }

  const preflight = createNormalizationPreflight(input);
  const planId = uuidv4();
  const createdAt = new Date().toISOString();
  const generatedRoot = getGeneratedNormalizationRoot();
  const planDir = path.join(generatedRoot, planId);
  const artifactPath = path.join(planDir, 'plan.json');
  const tasks = buildPlanTasks(planId, preflight.items);
  const status: NormalizationPlanDetail['status'] = preflight.summary.failed === 0 ? 'dry_run_ready' : 'blocked';
  const detail: NormalizationPlanDetail = {
    id: planId,
    scope: preflight.scope,
    status,
    outputRoot: preflight.outputRoot,
    artifactPath,
    target: preflight.target,
    summary: preflight.summary,
    items: preflight.items,
    tasks,
    errors: preflight.errors,
    createdBy,
    createdAt,
    safety: preflight.safety,
  };

  const db = getDb();
  fs.mkdirSync(planDir, { recursive: true });
  writeJsonWithin(generatedRoot, artifactPath, detail);
  writeTextWithin(generatedRoot, path.join(planDir, 'report.md'), renderPlanMarkdown(detail));

  db.prepare(`
    INSERT INTO normalization_plans (
      id, scope, status, output_root, artifact_path, target_json,
      summary_json, items_json, tasks_json, errors_json, created_by, created_at
    )
    VALUES (
      @id, @scope, @status, @output_root, @artifact_path, @target_json,
      @summary_json, @items_json, @tasks_json, @errors_json, @created_by, @created_at
    )
  `).run({
    id: detail.id,
    scope: detail.scope,
    status: detail.status,
    output_root: detail.outputRoot,
    artifact_path: detail.artifactPath,
    target_json: JSON.stringify(detail.target),
    summary_json: JSON.stringify(detail.summary),
    items_json: JSON.stringify(detail.items),
    tasks_json: JSON.stringify(detail.tasks),
    errors_json: JSON.stringify(detail.errors),
    created_by: detail.createdBy,
    created_at: detail.createdAt,
  });

  return detail;
}

export function listNormalizationPlans(limit = 20): NormalizationPlanDetail[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT *
    FROM normalization_plans
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit) as NormalizationPlanRow[];

  return rows.map(mapPlanRow);
}

export function getNormalizationPlan(id: string): NormalizationPlanDetail | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM normalization_plans
    WHERE id = ?
  `).get(id) as NormalizationPlanRow | undefined;

  return row ? mapPlanRow(row) : null;
}

export function startNormalizationRun(input: NormalizationRunInput): NormalizationRunDetail {
  validateNormalizationExecutionInput(input);
  const plan = getNormalizationPlan(input.planId!.trim());
  if (!plan) {
    throw new NormalizationManagerError('Normalization plan not found', 'NORMALIZATION_PLAN_NOT_FOUND', 404);
  }
  if (plan.status !== 'dry_run_ready' || plan.summary.failed > 0) {
    throw new NormalizationManagerError('Normalization plan is blocked by failed preflight items', 'NORMALIZATION_PLAN_BLOCKED');
  }
  if (plan.tasks.length === 0) {
    throw new NormalizationManagerError('Normalization plan has no tasks to run', 'NORMALIZATION_PLAN_EMPTY');
  }

  const runId = uuidv4();
  const runDir = path.join(getGeneratedNormalizationRunRoot(), runId);
  const artifactPath = path.join(runDir, 'run.json');
  const logPath = path.join(runDir, 'ffmpeg.log');
  const startedAt = new Date().toISOString();
  const detail: NormalizationRunDetail = {
    id: runId,
    planId: plan.id,
    status: 'running',
    outputRoot: plan.outputRoot,
    artifactPath,
    logPath,
    startedAt,
    endedAt: null,
    currentTaskId: null,
    currentFile: null,
    elapsedSeconds: 0,
    estimatedRemainingSeconds: null,
    outputSizeBytes: 0,
    completedCount: 0,
    failedCount: 0,
    totalCount: plan.tasks.length,
    errors: [],
    safety: {
      normalizedMediaWrites: true,
      originalMediaModification: false,
      playlistActivation: false,
      playout: false,
      broadcast: false,
      outputRoot: plan.outputRoot,
    },
  };

  fs.mkdirSync(runDir, { recursive: true });
  writeRunDetail(detail);
  insertNormalizationRun(detail);
  activeNormalizationRuns.set(runId, { runId, child: null, stopRequested: false });
  void executeNormalizationRun(plan, detail);
  return detail;
}

export function listNormalizationRuns(limit = 20): NormalizationRunDetail[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT *
    FROM normalization_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(safeLimit) as NormalizationRunRow[];
  return rows.map(mapRunRow);
}

export function getNormalizationRun(id: string): NormalizationRunDetail | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM normalization_runs
    WHERE id = ?
  `).get(id) as NormalizationRunRow | undefined;
  return row ? mapRunRow(row) : null;
}

export function readNormalizationRunLog(id: string, lines = 240): NormalizationRunLog {
  const run = getNormalizationRun(id);
  if (!run) {
    throw new NormalizationManagerError('Normalization run not found', 'NORMALIZATION_RUN_NOT_FOUND', 404);
  }
  if (!isPathInside(getGeneratedNormalizationRunRoot(), run.logPath)) {
    throw new NormalizationManagerError('Normalization log path is outside generated/normalization-runs', 'UNSAFE_NORMALIZATION_LOG_PATH');
  }
  if (!fs.existsSync(run.logPath)) {
    return { runId: run.id, path: run.logPath, exists: false, text: '' };
  }
  const safeLines = Math.max(1, Math.min(2000, Math.floor(lines)));
  const text = fs.readFileSync(run.logPath, 'utf8').split(/\r?\n/).slice(-safeLines).join('\n');
  return { runId: run.id, path: run.logPath, exists: true, text };
}

export function stopNormalizationRun(input: NormalizationStopInput): NormalizationRunDetail {
  const runId = cleanString(input.runId);
  if (!runId) {
    throw new NormalizationManagerError('Normalization run id is required', 'NORMALIZATION_RUN_ID_REQUIRED');
  }
  const run = getNormalizationRun(runId);
  if (!run) {
    throw new NormalizationManagerError('Normalization run not found', 'NORMALIZATION_RUN_NOT_FOUND', 404);
  }
  if (run.status !== 'running') {
    return run;
  }

  const active = activeNormalizationRuns.get(runId);
  if (active) {
    active.stopRequested = true;
    active.child?.kill('SIGTERM');
  }
  return getNormalizationRun(runId) ?? run;
}

export function publishNormalizedSet(input: NormalizedSetInput): NormalizedSetDetail {
  const runId = cleanString(input.runId);
  if (!runId) {
    throw new NormalizationManagerError('Normalization run id is required', 'NORMALIZATION_RUN_ID_REQUIRED');
  }
  if (input.confirmPublish !== true) {
    throw new NormalizationManagerError('Publish normalized set requires confirmPublish=true', 'NORMALIZED_SET_CONFIRMATION_REQUIRED');
  }

  const run = getNormalizationRun(runId);
  if (!run) {
    throw new NormalizationManagerError('Normalization run not found', 'NORMALIZATION_RUN_NOT_FOUND', 404);
  }
  if (run.status !== 'completed' || run.failedCount !== 0) {
    throw new NormalizationManagerError('Only completed normalization runs with failedCount=0 can publish a normalized set', 'NORMALIZATION_RUN_NOT_PUBLISHABLE');
  }

  const plan = getNormalizationPlan(run.planId);
  if (!plan) {
    throw new NormalizationManagerError('Normalization plan not found for run', 'NORMALIZATION_PLAN_NOT_FOUND', 404);
  }

  const id = uuidv4();
  const setDir = path.join(getGeneratedNormalizedSetRoot(), id);
  const artifactPath = path.join(setDir, 'mapping.json');
  const diffPath = path.join(setDir, 'diff.md');
  const createdAt = new Date().toISOString();
  const diff = plan.items.map(item => {
    const originalSafeFallback = item.decision === 'ok' && item.exists;
    const normalizedExists = !originalSafeFallback && fs.existsSync(item.normalizedPath);
    return {
      mediaFileId: item.mediaFileId,
      title: item.title,
      decision: item.decision,
      originalPath: item.absolutePath,
      normalizedPath: item.normalizedPath,
      normalizedExists,
      originalSafeFallback,
    };
  });
  const missingNormalized = diff.filter(item => !item.normalizedExists && !item.originalSafeFallback).length;
  const summary = {
    total: diff.length,
    normalizedReady: diff.filter(item => item.normalizedExists).length,
    originalSafeFallback: diff.filter(item => item.originalSafeFallback).length,
    missingNormalized,
    failed: run.failedCount,
    canUseForPlaylist: missingNormalized === 0 && run.failedCount === 0,
  };
  const detail: NormalizedSetDetail = {
    id,
    runId: run.id,
    planId: plan.id,
    status: summary.canUseForPlaylist ? 'ready' : 'blocked',
    outputRoot: run.outputRoot,
    artifactPath,
    diffPath,
    summary,
    diff,
    createdAt,
    safety: {
      deletesOriginal: false,
      mediaModification: false,
      playlistActivation: false,
      playout: false,
      broadcast: false,
    },
  };

  fs.mkdirSync(setDir, { recursive: true });
  writeJsonWithin(getGeneratedNormalizedSetRoot(), artifactPath, detail);
  writeTextWithin(getGeneratedNormalizedSetRoot(), diffPath, renderNormalizedSetDiff(detail));
  getDb().prepare(`
    INSERT INTO normalized_sets (
      id, run_id, plan_id, status, output_root, artifact_path,
      diff_path, summary_json, diff_json, created_at
    )
    VALUES (
      @id, @run_id, @plan_id, @status, @output_root, @artifact_path,
      @diff_path, @summary_json, @diff_json, @created_at
    )
  `).run({
    id: detail.id,
    run_id: detail.runId,
    plan_id: detail.planId,
    status: detail.status,
    output_root: detail.outputRoot,
    artifact_path: detail.artifactPath,
    diff_path: detail.diffPath,
    summary_json: JSON.stringify(detail.summary),
    diff_json: JSON.stringify(detail.diff),
    created_at: detail.createdAt,
  });

  return detail;
}

export function listNormalizedSets(limit = 20): NormalizedSetDetail[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM normalized_sets
    ORDER BY created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(100, Math.floor(limit)))) as NormalizedSetRow[];
  return rows.map(mapNormalizedSetRow);
}

export function rejectNormalizationExecution(input: NormalizationRunInput): never {
  validateNormalizationExecutionInput(input);
  throw new NormalizationManagerError(
    'Smart normalization execution is available through startNormalizationRun, not rejectNormalizationExecution',
    'NORMALIZATION_EXECUTION_REJECTED'
  );
}

function validateNormalizationExecutionInput(input: NormalizationRunInput): void {
  if (!input.planId || input.planId.trim() === '') {
    throw new NormalizationManagerError('Normalization plan id is required', 'NORMALIZATION_PLAN_ID_REQUIRED');
  }
  if (input.confirmExecution !== true) {
    throw new NormalizationManagerError(
      'Smart normalization execution requires confirmExecution=true',
      'NORMALIZATION_EXECUTION_CONFIRMATION_REQUIRED'
    );
  }
  if (input.confirmationText !== NORMALIZATION_EXECUTION_CONFIRMATION_TEXT) {
    throw new NormalizationManagerError(
      `Smart normalization execution requires confirmationText="${NORMALIZATION_EXECUTION_CONFIRMATION_TEXT}"`,
      'NORMALIZATION_EXECUTION_TEXT_REQUIRED'
    );
  }
}

async function executeNormalizationRun(plan: NormalizationPlanDetail, initial: NormalizationRunDetail): Promise<void> {
  let detail = initial;
  const active = activeNormalizationRuns.get(detail.id);
  const startedAtMs = Date.parse(detail.startedAt);

  appendRunLog(detail, `Normalization run ${detail.id} started for plan ${plan.id}\n`);
  try {
    for (const task of plan.tasks) {
      if (active?.stopRequested) {
        detail = finishRun(detail, 'stopped', 'NORMALIZATION_STOP_REQUESTED', 'Normalization run was stopped by user request.');
        return;
      }
      if (task.decision === 'failed') {
        detail = {
          ...detail,
          failedCount: detail.failedCount + 1,
          errors: [...detail.errors, { code: 'NORMALIZATION_TASK_BLOCKED', message: 'Blocked task was skipped.', taskId: task.id }],
        };
        persistRunProgress(detail, startedAtMs);
        continue;
      }

      const taskStartMs = Date.now();
      detail = {
        ...detail,
        currentTaskId: task.id,
        currentFile: task.inputPath,
      };
      persistRunProgress(detail, startedAtMs);
      appendRunLog(detail, `\n[${new Date().toISOString()}] ${task.id} ${task.decision}: ${task.inputPath}\n`);

      try {
        await runNormalizationTask(detail, task, active);
        detail = {
          ...detail,
          completedCount: detail.completedCount + 1,
          outputSizeBytes: totalExistingOutputSize(plan.tasks),
        };
        const averageSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000 / Math.max(1, detail.completedCount)));
        detail = {
          ...detail,
          estimatedRemainingSeconds: averageSeconds * Math.max(0, detail.totalCount - detail.completedCount - detail.failedCount),
        };
        appendRunLog(detail, `[done] ${task.id} in ${Math.round((Date.now() - taskStartMs) / 1000)}s\n`);
      } catch (err) {
        const stopped = active?.stopRequested === true;
        detail = {
          ...detail,
          failedCount: stopped ? detail.failedCount : detail.failedCount + 1,
          errors: stopped
            ? detail.errors
            : [...detail.errors, {
                code: 'NORMALIZATION_TASK_FAILED',
                message: err instanceof Error ? err.message : String(err),
                taskId: task.id,
              }],
        };
        appendRunLog(detail, `[${stopped ? 'stopped' : 'failed'}] ${task.id}: ${err instanceof Error ? err.message : String(err)}\n`);
        if (stopped) {
          detail = finishRun(detail, 'stopped', 'NORMALIZATION_STOP_REQUESTED', 'Normalization run was stopped by user request.');
          return;
        }
      } finally {
        detail = {
          ...detail,
          elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
          outputSizeBytes: totalExistingOutputSize(plan.tasks),
        };
        persistRunProgress(detail, startedAtMs);
      }
    }

    const status: NormalizationRunDetail['status'] = detail.failedCount === 0 ? 'completed' : 'failed';
    detail = {
      ...detail,
      status,
      endedAt: new Date().toISOString(),
      currentTaskId: null,
      currentFile: null,
      elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
      outputSizeBytes: totalExistingOutputSize(plan.tasks),
      estimatedRemainingSeconds: 0,
    };
    appendRunLog(detail, `\nNormalization run ${detail.id} ${status} with ${detail.failedCount} failed task(s).\n`);
    writeRunDetail(detail);
    updateNormalizationRun(detail);
  } finally {
    activeNormalizationRuns.delete(detail.id);
  }
}

async function runNormalizationTask(
  run: NormalizationRunDetail,
  task: NormalizationPlanTask,
  active: ActiveNormalizationRun | undefined
): Promise<void> {
  assertOutputPathInsideRoot(run.outputRoot, task.outputPath);
  fs.mkdirSync(path.dirname(task.outputPath), { recursive: true });
  const args = buildExecutionArgs(task);

  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(config.ffmpeg.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (active) active.child = child;

    child.stdout?.on('data', chunk => appendRunLog(run, chunk.toString()));
    child.stderr?.on('data', chunk => appendRunLog(run, chunk.toString()));
    child.on('error', reject);
    child.on('close', code => {
      if (active) active.child = null;
      if (active?.stopRequested) {
        reject(new Error('Stopped by user request'));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`FFmpeg exited with code ${code ?? 'null'}`));
    });
  });
}

function buildExecutionArgs(task: NormalizationPlanTask): string[] {
  if (task.decision === 'remux') {
    return [
      '-hide_banner',
      '-nostdin',
      '-i', task.inputPath,
      '-map', '0',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      task.outputPath,
    ];
  }

  if (task.decision === 'audio-only') {
    const target = getTargetProfile();
    return [
      '-hide_banner',
      '-nostdin',
      '-i', task.inputPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'copy',
      '-c:a', target.audioCodec,
      '-b:a', target.audioBitrate,
      '-ar', String(target.audioRate),
      '-ac', String(target.audioChannels),
      '-movflags', '+faststart',
      '-y',
      task.outputPath,
    ];
  }

  const target = getTargetProfile();
  return [
    '-hide_banner',
    '-nostdin',
    '-i', task.inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', buildVideoNormVf({ width: target.width, height: target.height, fps: target.fps }),
    '-af', buildAudioNormAf({ audioRate: target.audioRate }),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', target.videoBitrate,
    '-maxrate', target.videoMaxrate,
    '-bufsize', target.videoBufsize,
    '-pix_fmt', target.pixelFormat,
    '-r', String(target.fps),
    '-c:a', target.audioCodec,
    '-b:a', target.audioBitrate,
    '-ar', String(target.audioRate),
    '-ac', String(target.audioChannels),
    '-movflags', '+faststart',
    '-y',
    task.outputPath,
  ];
}

function finishRun(
  detail: NormalizationRunDetail,
  status: 'failed' | 'stopped',
  code: string,
  message: string
): NormalizationRunDetail {
  const next = {
    ...detail,
    status,
    endedAt: new Date().toISOString(),
    currentTaskId: null,
    currentFile: null,
    errors: [...detail.errors, { code, message }],
  };
  appendRunLog(next, `\n${message}\n`);
  writeRunDetail(next);
  updateNormalizationRun(next);
  return next;
}

function persistRunProgress(detail: NormalizationRunDetail, startedAtMs: number): void {
  const next = {
    ...detail,
    elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
  };
  writeRunDetail(next);
  updateNormalizationRun(next);
}

function insertNormalizationRun(detail: NormalizationRunDetail): void {
  getDb().prepare(`
    INSERT INTO normalization_runs (
      id, plan_id, status, output_root, artifact_path, log_path, started_at,
      ended_at, current_task_id, current_file, elapsed_seconds,
      estimated_remaining_seconds, output_size_bytes, completed_count,
      failed_count, total_count, errors_json
    )
    VALUES (
      @id, @plan_id, @status, @output_root, @artifact_path, @log_path, @started_at,
      @ended_at, @current_task_id, @current_file, @elapsed_seconds,
      @estimated_remaining_seconds, @output_size_bytes, @completed_count,
      @failed_count, @total_count, @errors_json
    )
  `).run(runDbParams(detail));
}

function updateNormalizationRun(detail: NormalizationRunDetail): void {
  getDb().prepare(`
    UPDATE normalization_runs
    SET
      status=@status,
      ended_at=@ended_at,
      current_task_id=@current_task_id,
      current_file=@current_file,
      elapsed_seconds=@elapsed_seconds,
      estimated_remaining_seconds=@estimated_remaining_seconds,
      output_size_bytes=@output_size_bytes,
      completed_count=@completed_count,
      failed_count=@failed_count,
      total_count=@total_count,
      errors_json=@errors_json
    WHERE id=@id
  `).run(runDbParams(detail));
}

function runDbParams(detail: NormalizationRunDetail): Record<string, unknown> {
  return {
    id: detail.id,
    plan_id: detail.planId,
    status: detail.status,
    output_root: detail.outputRoot,
    artifact_path: detail.artifactPath,
    log_path: detail.logPath,
    started_at: detail.startedAt,
    ended_at: detail.endedAt,
    current_task_id: detail.currentTaskId,
    current_file: detail.currentFile,
    elapsed_seconds: detail.elapsedSeconds,
    estimated_remaining_seconds: detail.estimatedRemainingSeconds,
    output_size_bytes: detail.outputSizeBytes,
    completed_count: detail.completedCount,
    failed_count: detail.failedCount,
    total_count: detail.totalCount,
    errors_json: JSON.stringify(detail.errors),
  };
}

function writeRunDetail(detail: NormalizationRunDetail): void {
  writeJsonWithin(getGeneratedNormalizationRunRoot(), detail.artifactPath, detail);
}

function appendRunLog(detail: NormalizationRunDetail, text: string): void {
  if (!isPathInside(getGeneratedNormalizationRunRoot(), detail.logPath)) {
    throw new NormalizationManagerError('Normalization log path is outside generated/normalization-runs', 'UNSAFE_NORMALIZATION_LOG_PATH');
  }
  fs.mkdirSync(path.dirname(detail.logPath), { recursive: true });
  fs.appendFileSync(detail.logPath, text, 'utf8');
}

function totalExistingOutputSize(tasks: NormalizationPlanTask[]): number {
  return tasks.reduce((total, task) => {
    if (!fs.existsSync(task.outputPath)) return total;
    return total + fs.statSync(task.outputPath).size;
  }, 0);
}

function assertOutputPathInsideRoot(outputRoot: string, outputPath: string): void {
  if (!isPathInside(outputRoot, outputPath)) {
    throw new NormalizationManagerError('Normalization output path must stay inside normalized media root', 'UNSAFE_NORMALIZATION_OUTPUT_PATH');
  }
}

export function classifyNormalizationDecision(row: {
  path: string;
  status?: string | null;
  duration_sec?: number | null;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  pixel_format?: string | null;
  bitrate?: number | null;
  audio_rate?: number | null;
}, exists: boolean, target: NormalizationTargetProfile = getTargetProfile()): { decision: NormalizationDecision; reasons: NormalizationReason[] } {
  const reasons = new Set<NormalizationReason>();

  if (!exists || row.status === 'missing') reasons.add('missing');
  if (mediaDurationSeconds(row.duration_sec ?? null, row.duration_ms ?? null) === null) reasons.add('duration');
  if (!hasProbeSnapshot(row)) reasons.add('unscanned');
  if ((row.video_codec ?? '').toLowerCase() !== target.videoCodec) reasons.add('video_codec');
  if (row.width !== target.width || row.height !== target.height) reasons.add('resolution');
  if (!fpsMatches(row.fps ?? null, target.fps)) reasons.add('fps');
  if ((row.pixel_format ?? '').toLowerCase() !== target.pixelFormat) reasons.add('pix_fmt');
  if (typeof row.bitrate === 'number' && Number.isFinite(row.bitrate) && row.bitrate > target.maxVideoBitrate) {
    reasons.add('bitrate');
  }
  if ((row.audio_codec ?? '').toLowerCase() !== target.audioCodec) reasons.add('audio_codec');
  if (row.audio_rate !== target.audioRate) reasons.add('sample_rate');
  if (path.extname(row.path).toLowerCase() !== '.mp4') reasons.add('container');

  const reasonList = [...reasons];
  if (reasons.has('missing') || reasons.has('duration')) {
    return { decision: 'failed', reasons: reasonList };
  }

  if (hasAnyReason(reasons, ['video_codec', 'resolution', 'fps', 'pix_fmt', 'bitrate', 'unscanned'])) {
    return { decision: 'full-transcode', reasons: reasonList };
  }

  if (hasAnyReason(reasons, ['audio_codec', 'sample_rate'])) {
    return { decision: 'audio-only', reasons: reasonList };
  }

  if (reasons.has('container')) {
    return { decision: 'remux', reasons: reasonList };
  }

  return { decision: 'ok', reasons: [] };
}

function readMediaRowsForScope(scope: NormalizationScope, input: NormalizationPreflightInput): MediaFileRow[] {
  if (scope === 'active_schedule') {
    const activeState = getActiveScheduleState();
    if (!activeState) {
      throw new NormalizationManagerError('No active published schedule is available for normalization preflight', 'NO_ACTIVE_SCHEDULE', 404);
    }
    return readMediaRowsForScheduleId(activeState.publishedScheduleId, input.limit);
  }

  if (scope === 'published_schedule') {
    const id = cleanString(input.publishedScheduleId);
    if (!id) {
      throw new NormalizationManagerError('publishedScheduleId is required for published_schedule normalization scope', 'PUBLISHED_SCHEDULE_ID_REQUIRED');
    }
    return readMediaRowsForScheduleId(id, input.limit);
  }

  return readMediaRowsForRoots(input.rootKeys, input.limit);
}

function readMediaRowsForScheduleId(scheduleId: string, limit?: number): MediaFileRow[] {
  const schedule = getPublishedSchedule(scheduleId);
  if (!schedule) {
    throw new NormalizationManagerError('Published schedule not found for normalization preflight', 'PUBLISHED_SCHEDULE_NOT_FOUND', 404);
  }

  const expansion = expandPublishedScheduleToFiles(schedule as PublishedScheduleDetail);
  const ids = [
    ...new Set(
      expansion.items
        .map(item => item.mediaFileId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ];
  if (ids.length === 0) return [];

  const rows = readMediaRowsByIds(ids);
  const byId = new Map(rows.map(row => [row.id, row]));
  const ordered: MediaFileRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) ordered.push(row);
  }

  return ordered.slice(0, normalizeLimit(limit));
}

function readMediaRowsForRoots(rootKeys?: string[], limit?: number): MediaFileRow[] {
  const keys = normalizeRootKeys(rootKeys);
  const placeholders = keys.map(() => '?').join(',');
  const db = getDb();
  return db.prepare(`
    SELECT
      mf.id,
      mf.path,
      mf.relative_path,
      mf.original_relative_path,
      mf.filename,
      mf.original_filename,
      mf.type,
      mf.status,
      mf.duration_sec,
      mf.duration_ms,
      mf.width,
      mf.height,
      mf.fps,
      mf.video_codec,
      mf.audio_codec,
      mf.pixel_format,
      mf.bitrate,
      mf.audio_rate,
      mr.root_key,
      mr.absolute_path as root_absolute_path
    FROM media_files mf
    LEFT JOIN media_roots mr ON mr.id = mf.root_id
    WHERE mr.root_key IN (${placeholders})
    ORDER BY mr.root_key, COALESCE(mf.relative_path, mf.original_relative_path, mf.filename), mf.id
    LIMIT ?
  `).all(...keys, normalizeLimit(limit)) as MediaFileRow[];
}

function readMediaRowsByIds(ids: string[]): MediaFileRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const db = getDb();
  return db.prepare(`
    SELECT
      mf.id,
      mf.path,
      mf.relative_path,
      mf.original_relative_path,
      mf.filename,
      mf.original_filename,
      mf.type,
      mf.status,
      mf.duration_sec,
      mf.duration_ms,
      mf.width,
      mf.height,
      mf.fps,
      mf.video_codec,
      mf.audio_codec,
      mf.pixel_format,
      mf.bitrate,
      mf.audio_rate,
      mr.root_key,
      mr.absolute_path as root_absolute_path
    FROM media_files mf
    LEFT JOIN media_roots mr ON mr.id = mf.root_id
    WHERE mf.id IN (${placeholders})
  `).all(...ids) as MediaFileRow[];
}

function buildPreflightItem(row: MediaFileRow, index: number): NormalizationPreflightItem {
  const exists = fs.existsSync(row.path);
  const classified = classifyNormalizationDecision(row, exists);
  const relativePath = outputRelativePath(row);
  return {
    id: `${row.id || 'media'}-${index}`,
    mediaFileId: row.id,
    sourceRole: row.type,
    title: row.original_filename ?? row.filename,
    rootKey: row.root_key,
    absolutePath: row.path,
    relativePath,
    normalizedPath: joinNormalizedOutputPath(getNormalizedOutputRoot(), replaceExtension(relativePath, '.mp4')),
    exists,
    decision: classified.decision,
    reasons: classified.reasons,
    probe: {
      durationSec: mediaDurationSeconds(row.duration_sec, row.duration_ms),
      width: row.width,
      height: row.height,
      fps: row.fps,
      videoCodec: row.video_codec,
      audioCodec: row.audio_codec,
      pixelFormat: row.pixel_format,
      bitrate: row.bitrate,
      audioRate: row.audio_rate,
    },
  };
}

function buildPreflightErrors(items: NormalizationPreflightItem[]): Array<{ code: string; message: string; itemId?: string }> {
  return items
    .filter(item => item.decision === 'failed')
    .map(item => ({
      code: item.reasons.includes('missing') ? 'NORMALIZATION_INPUT_MISSING' : 'NORMALIZATION_INPUT_INVALID',
      itemId: item.id,
      message: `${item.title} cannot be normalized until ${item.reasons.join(', ')} is resolved.`,
    }));
}

function buildSummary(items: NormalizationPreflightItem[]): NormalizationSummary {
  const counts = Object.fromEntries(DECISIONS.map(decision => [decision, 0])) as Record<NormalizationDecision, number>;
  const reasons = Object.fromEntries(REASONS.map(reason => [reason, 0])) as Record<NormalizationReason, number>;

  for (const item of items) {
    counts[item.decision] += 1;
    for (const reason of item.reasons) {
      reasons[reason] += 1;
    }
  }

  return {
    total: items.length,
    ok: counts.ok,
    remux: counts.remux,
    audioOnly: counts['audio-only'],
    fullTranscode: counts['full-transcode'],
    failed: counts.failed,
    reasons,
    canPublishNormalizedSet: items.length > 0 && counts.failed === 0,
    acceptance: {
      failedMustBe: 0,
      durationKnown: true,
      video: '1280x720 25fps h264 yuv420p',
      audio: 'AAC 48k stereo 192k',
      timestamps: 'reset by normalization filtergraph',
    },
  };
}

function buildPlanTasks(planId: string, items: NormalizationPreflightItem[]): NormalizationPlanTask[] {
  return items
    .filter((item): item is NormalizationPreflightItem & { decision: Exclude<NormalizationDecision, 'ok'> } => item.decision !== 'ok')
    .map((item, index) => ({
      id: `${planId}-task-${index + 1}`,
      mediaFileId: item.mediaFileId,
      inputPath: item.absolutePath,
      outputPath: item.normalizedPath,
      decision: item.decision,
      reasons: item.reasons,
      ffmpegWillRun: false,
      commandPreview: item.decision === 'failed'
        ? 'blocked: resolve failed preflight reasons before normalization'
        : buildCommandPreview(item),
    }));
}

function buildCommandPreview(item: NormalizationPreflightItem): string {
  const target = getTargetProfile();
  if (item.decision === 'remux') {
    return [
      config.ffmpeg.ffmpegPath,
      '-i',
      quoteArg(item.absolutePath),
      '-map',
      '0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      quoteArg(item.normalizedPath),
    ].join(' ');
  }

  if (item.decision === 'audio-only') {
    return [
      config.ffmpeg.ffmpegPath,
      '-i',
      quoteArg(item.absolutePath),
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'copy',
      '-c:a',
      target.audioCodec,
      '-b:a',
      target.audioBitrate,
      '-ar',
      String(target.audioRate),
      '-ac',
      String(target.audioChannels),
      '-movflags',
      '+faststart',
      quoteArg(item.normalizedPath),
    ].join(' ');
  }

  return [
    config.ffmpeg.ffmpegPath,
    '-i',
    quoteArg(item.absolutePath),
    '-vf',
    quoteArg(`scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${target.fps},setpts=N/(${target.fps}*TB),settb=1/${target.fps}`),
    '-c:v',
    'libx264',
    '-b:v',
    target.videoBitrate,
    '-maxrate',
    target.videoMaxrate,
    '-bufsize',
    target.videoBufsize,
    '-pix_fmt',
    target.pixelFormat,
    '-c:a',
    target.audioCodec,
    '-b:a',
    target.audioBitrate,
    '-ar',
    String(target.audioRate),
    '-ac',
    String(target.audioChannels),
    quoteArg(item.normalizedPath),
  ].join(' ');
}

function getTargetProfile(): NormalizationTargetProfile {
  const [rawWidth, rawHeight] = config.broadcast.resolution.split('x');
  const width = Number.parseInt(rawWidth ?? '', 10);
  const height = Number.parseInt(rawHeight ?? '', 10);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1280,
    height: Number.isFinite(height) && height > 0 ? height : 720,
    fps: config.broadcast.fps,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    audioCodec: 'aac',
    audioRate: config.broadcast.audioRate,
    audioChannels: 2,
    audioBitrate: '192k',
    videoBitrate: '2500k',
    videoMaxrate: '3500k',
    videoBufsize: '7000k',
    maxVideoBitrate: 3500000,
    container: 'mp4',
  };
}

function getNormalizedOutputRoot(): string {
  const configured = process.env['NORMALIZED_MEDIA_PATH'] ?? NORMALIZED_MEDIA_ROOT;
  if (configured.startsWith('/')) {
    return path.posix.normalize(configured);
  }
  return path.resolve(configured);
}

function getGeneratedNormalizationRoot(): string {
  return path.join(getProjectRoot(), 'generated', 'normalization');
}

function getGeneratedNormalizationRunRoot(): string {
  return path.join(getProjectRoot(), 'generated', 'normalization-runs');
}

function getGeneratedNormalizedSetRoot(): string {
  return path.join(getProjectRoot(), 'generated', 'normalized-sets');
}

function getProjectRoot(): string {
  return path.resolve(process.env['NORMALIZATION_PROJECT_ROOT'] ?? path.resolve(__dirname, '../../..'));
}

function getDryRunSafety(): NormalizationSafety {
  return {
    readOnlyScan: true,
    dryRun: true,
    writesGeneratedArtifactsOnly: true,
    outputRootPreparedOnly: true,
    normalizedMediaWrites: false,
    originalMediaModification: false,
    ffmpegExecution: false,
    playlistActivation: false,
    playout: false,
    broadcast: false,
  };
}

function normalizeRootKeys(rootKeys?: string[]): string[] {
  const allowed = new Set(['original-ar', 'source', 'bumpers']);
  const keys = (rootKeys && rootKeys.length > 0 ? rootKeys : DEFAULT_ROOT_KEYS)
    .map(key => key.trim())
    .filter(key => allowed.has(key));
  return keys.length > 0 ? [...new Set(keys)] : DEFAULT_ROOT_KEYS;
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return 500;
  return Math.max(1, Math.min(5000, Math.floor(limit)));
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mediaDurationSeconds(durationSec: number | null, durationMs: number | null): number | null {
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) return durationSec;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) return durationMs / 1000;
  return null;
}

function hasProbeSnapshot(row: {
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  pixel_format?: string | null;
  audio_rate?: number | null;
}): boolean {
  return row.width !== null
    && row.width !== undefined
    && row.height !== null
    && row.height !== undefined
    && row.fps !== null
    && row.fps !== undefined
    && !!row.video_codec
    && !!row.audio_codec
    && !!row.pixel_format
    && row.audio_rate !== null
    && row.audio_rate !== undefined;
}

function fpsMatches(actual: number | null, expected: number): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= 0.05;
}

function hasAnyReason(reasons: Set<NormalizationReason>, values: NormalizationReason[]): boolean {
  return values.some(value => reasons.has(value));
}

function outputRelativePath(row: MediaFileRow): string {
  const raw = row.relative_path
    ?? row.original_relative_path
    ?? relativeToRoot(row)
    ?? row.filename
    ?? `${row.id}.mp4`;
  return sanitizeRelativePath(raw);
}

function relativeToRoot(row: MediaFileRow): string | null {
  if (!row.root_absolute_path) return null;
  const root = path.resolve(row.root_absolute_path);
  const filePath = path.resolve(row.path);
  if (filePath === root || !filePath.startsWith(`${root}${path.sep}`)) return null;
  return path.relative(root, filePath);
}

function sanitizeRelativePath(value: string): string {
  const segments = value
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '.' && segment !== '..')
    .map(segment => segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_'));
  return segments.length > 0 ? path.join(...segments) : 'media.mp4';
}

function replaceExtension(value: string, extension: string): string {
  const parsed = path.parse(value);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function joinNormalizedOutputPath(rootPath: string, relativePath: string): string {
  if (rootPath.startsWith('/')) {
    return path.posix.join(rootPath, relativePath.replace(/\\/g, '/'));
  }
  return path.join(rootPath, relativePath);
}

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function writeJsonWithin(rootPath: string, filePath: string, value: unknown): void {
  writeTextWithin(rootPath, filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextWithin(rootPath: string, filePath: string, value: string): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(filePath);
  if (!isPathInside(root, target)) {
    throw new NormalizationManagerError('Normalization artifact path is outside generated/normalization', 'UNSAFE_NORMALIZATION_ARTIFACT_PATH');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, 'utf8');
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

interface ServerNormalizationJobDescriptor {
  key: ServerNormalizationJobStatus['key'];
  label: string;
  scriptPath: string;
  alternateScriptPaths?: string[];
  pidPath: string;
  outputPath: string;
  reportPattern: RegExp;
  inferFromScriptName?: boolean;
}

function readServerNormalizationJob(descriptor: ServerNormalizationJobDescriptor): ServerNormalizationJobStatus {
  let pid = readPidFile(descriptor.pidPath);
  if (pid !== null && !isPidRunning(pid)) pid = null;
  let pgid = pid ? getProcessGroupId(pid) : null;
  const includeScriptMatch = descriptor.inferFromScriptName !== false;
  let processes = readProcessesForJob(pgid, pid, descriptor.scriptPath, descriptor.alternateScriptPaths, includeScriptMatch);
  if (pid === null && includeScriptMatch) {
    const inferred = inferMainProcess(processes, descriptor.scriptPath, descriptor.alternateScriptPaths);
    if (inferred) {
      pid = inferred.pid;
      pgid = inferred.pgid ?? getProcessGroupId(inferred.pid);
      processes = readProcessesForJob(pgid, pid, descriptor.scriptPath, descriptor.alternateScriptPaths, includeScriptMatch);
    }
  }
  const running = (pid !== null && isPidRunning(pid)) || processes.length > 0;
  const outputText = readTextTail(descriptor.outputPath, 1024 * 1024);
  const reportPath = reportPathFromOutput(outputText, descriptor.reportPattern) ?? latestReportPath(descriptor.reportPattern);
  const logProgress = parseNormalizationProgress(outputText);
  const logCounts = parseNormalizationCounts(outputText);
  const reportCounts = reportPath ? parseNormalizationReportCounts(reportPath) : null;
  const counts = reportCounts ?? logCounts;
  const progress = inferNormalizationProgress(logProgress, counts, descriptor.key);
  const cpuPercent = processes.reduce((sum, processInfo) => sum + processInfo.cpuPercent, 0);

  return {
    key: descriptor.key,
    label: descriptor.label,
    scriptPath: descriptor.scriptPath,
    pidPath: descriptor.pidPath,
    outputPath: descriptor.outputPath,
    reportPath,
    pid,
    pgid,
    running,
    done: /\bDONE\b/i.test(outputText),
    progress,
    counts,
    cpuPercent: Number(cpuPercent.toFixed(2)),
    lastLines: tailLinesFromText(outputText, 24),
    processes,
  };
}

function readServerNormalizationNextTaskConfig(): ServerNormalizationNextTaskConfig {
  const defaults = defaultServerNormalizationNextTaskConfig();
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(NORMALIZATION_NEXT_TASK_SETTING_KEY) as { value: string } | undefined;
    if (!row) return defaults;
    return sanitizeServerNormalizationNextTaskConfig(parseJson<Partial<ServerNormalizationNextTaskConfig>>(row.value), defaults);
  } catch {
    return defaults;
  }
}

function buildServerNormalizationNextTask(configValue: ServerNormalizationNextTaskConfig): ServerNormalizationNextTask {
  const ioniceArgs = configValue.ioniceClass === 3
    ? `ionice -c3`
    : `ionice -c2 -n${configValue.ioniceLevel}`;
  const envPreview = {
    NORMALIZE_SOURCE_ROOT: configValue.sourceRoot,
    NORMALIZE_OUTPUT_ROOT: configValue.outputRoot,
    NORMALIZE_MAX_PARALLEL: String(configValue.maxParallel),
    NORMALIZE_MAX_VIDEO_BITRATE: String(configValue.maxVideoBitrate),
    NORMALIZE_VIDEO_BITRATE: configValue.videoBitrate,
    NORMALIZE_VIDEO_MAXRATE: configValue.videoMaxrate,
    NORMALIZE_VIDEO_BUFSIZE: configValue.videoBufsize,
    NORMALIZE_AUDIO_BITRATE: configValue.audioBitrate,
    DELETE_ORIGINAL_AFTER_VALIDATION: configValue.deleteOriginalAfterValidation ? '1' : '0',
    ...(configValue.deleteOriginalAfterValidation
      ? { DELETE_CONFIRMATION: 'DELETE ORIGINAL AFTER VALIDATION' }
      : {}),
    REQUIRE_FIX_DONE_BEFORE_CONTINUE: configValue.requireFixDoneBeforeContinue ? '1' : '0',
  };
  const envPrefix = Object.entries(envPreview)
    .map(([key, value]) => `${key}=${quoteArg(value)}`)
    .join(' ');

  return {
    mode: 'server-normalization-next-task',
    config: configValue,
    envPreview,
    commandPreview: `${envPrefix} nohup nice -n ${configValue.nice} ${ioniceArgs} ${CONTINUE_NORMALIZE_SCRIPT_PATH} > ${CONTINUE_NORMALIZE_OUTPUT_PATH} 2>&1 & echo $! > ${CONTINUE_NORMALIZE_PID_PATH}`,
    safety: {
      startsAutomatically: false,
      scriptPath: CONTINUE_NORMALIZE_SCRIPT_PATH,
      pidPath: CONTINUE_NORMALIZE_PID_PATH,
      outputPath: CONTINUE_NORMALIZE_OUTPUT_PATH,
      deletesOriginalOnlyAfterValidation: configValue.deleteOriginalAfterValidation,
      requiresFixDoneBeforeContinue: configValue.requireFixDoneBeforeContinue,
    },
  };
}

function defaultServerNormalizationNextTaskConfig(): ServerNormalizationNextTaskConfig {
  const target = getTargetProfile();
  return {
    sourceRoot: ORIGINAL_MEDIA_ROOT,
    outputRoot: getNormalizedOutputRoot(),
    maxParallel: 5,
    nice: 10,
    ioniceClass: 2,
    ioniceLevel: 7,
    maxVideoBitrate: target.maxVideoBitrate,
    videoBitrate: target.videoBitrate,
    videoMaxrate: target.videoMaxrate,
    videoBufsize: target.videoBufsize,
    audioBitrate: target.audioBitrate,
    deleteOriginalAfterValidation: true,
    requireFixDoneBeforeContinue: true,
  };
}

function sanitizeServerNormalizationNextTaskConfig(
  input: Partial<ServerNormalizationNextTaskConfig>,
  fallback: ServerNormalizationNextTaskConfig
): ServerNormalizationNextTaskConfig {
  const ioniceClass = Number(input.ioniceClass);
  return {
    sourceRoot: sanitizeServerMediaPath(input.sourceRoot, fallback.sourceRoot),
    outputRoot: sanitizeServerMediaPath(input.outputRoot, fallback.outputRoot),
    maxParallel: clampInteger(input.maxParallel, 1, 10, fallback.maxParallel),
    nice: clampInteger(input.nice, 0, 19, fallback.nice),
    ioniceClass: ioniceClass === 3 ? 3 : 2,
    ioniceLevel: clampInteger(input.ioniceLevel, 0, 7, fallback.ioniceLevel),
    maxVideoBitrate: clampInteger(input.maxVideoBitrate, 500000, 20000000, fallback.maxVideoBitrate),
    videoBitrate: sanitizeBitrateLabel(input.videoBitrate, fallback.videoBitrate),
    videoMaxrate: sanitizeBitrateLabel(input.videoMaxrate, fallback.videoMaxrate),
    videoBufsize: sanitizeBitrateLabel(input.videoBufsize, fallback.videoBufsize),
    audioBitrate: sanitizeBitrateLabel(input.audioBitrate, fallback.audioBitrate),
    deleteOriginalAfterValidation: input.deleteOriginalAfterValidation ?? fallback.deleteOriginalAfterValidation,
    requireFixDoneBeforeContinue: input.requireFixDoneBeforeContinue ?? fallback.requireFixDoneBeforeContinue,
  };
}

function sanitizeServerMediaPath(value: unknown, fallback: string): string {
  const cleaned = cleanString(value);
  if (!cleaned.startsWith('/srv/daawah/media/')) return fallback;
  return path.posix.normalize(cleaned);
}

function sanitizeBitrateLabel(value: unknown, fallback: string): string {
  const cleaned = cleanString(value);
  return /^\d+[kKmM]?$/.test(cleaned) ? cleaned.toLowerCase() : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function readPidFile(pidPath: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  if (fs.existsSync(`/proc/${pid}`)) return true;
  try {
    const output = childProcess.execFileSync('ps', ['-p', String(pid), '-o', 'pid='], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    }).trim();
    if (output === String(pid)) return true;
  } catch {
    // Fall through to process.kill for platforms without ps.
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function getProcessGroupId(pid: number): number | null {
  try {
    const output = childProcess.execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    }).trim();
    const pgid = Number.parseInt(output, 10);
    return Number.isFinite(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

function readProcessesForJob(
  pgid: number | null,
  pid: number | null,
  scriptPath: string,
  alternateScriptPaths: string[] = [],
  includeScriptMatch = true
): ServerNormalizationProcessInfo[] {
  try {
    const output = childProcess.execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,ni=,pcpu=,stat=,args='], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    const scriptPaths = [scriptPath, ...alternateScriptPaths];
    const scriptNames = scriptPaths.map(script => path.basename(script));
    return output
      .split(/\r?\n/)
      .map(parseProcessLine)
      .filter((processInfo): processInfo is ServerNormalizationProcessInfo => Boolean(processInfo))
      .filter(processInfo => (
        (pgid !== null && processInfo.pgid === pgid)
        || (pid !== null && (processInfo.pid === pid || processInfo.ppid === pid))
        || (includeScriptMatch && scriptPaths.some(script => processInfo.command.includes(script)))
        || (includeScriptMatch && scriptNames.some(scriptName => processInfo.command.includes(scriptName)))
        || (includeScriptMatch && pgid !== null && scriptNames.some(scriptName => isLikelyNormalizationFfmpeg(processInfo.command, scriptName)))
      ))
      .slice(0, 40);
  } catch {
    return [];
  }
}

function inferMainProcess(
  processes: ServerNormalizationProcessInfo[],
  scriptPath: string,
  alternateScriptPaths: string[] = []
): ServerNormalizationProcessInfo | null {
  const scriptPaths = [scriptPath, ...alternateScriptPaths];
  const scriptNames = scriptPaths.map(script => path.basename(script));
  return processes.find(processInfo => (
    scriptPaths.some(script => processInfo.command.includes(script))
    || scriptNames.some(scriptName => processInfo.command.includes(scriptName))
  )) ?? null;
}

function readThrottleProcess(scriptPath: string): ServerNormalizationProcessInfo | null {
  const processes = readProcessesForJob(null, null, scriptPath);
  const directWatcher = new RegExp(`\\bbash\\s+${escapeRegExp(scriptPath)}\\b`);
  return processes.find(processInfo => directWatcher.test(processInfo.command))
    ?? inferMainProcess(processes, scriptPath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLikelyNormalizationFfmpeg(command: string, scriptName: string): boolean {
  const lower = command.toLowerCase();
  if (!lower.includes('ffmpeg')) return false;
  if (scriptName.includes('fix_normalized')) {
    return lower.includes('/srv/daawah/media/normalized-ar');
  }
  if (scriptName.includes('continue_normalize')) {
    return lower.includes('/srv/daawah/media/original-ar') || lower.includes('/srv/daawah/media/normalized-ar');
  }
  return false;
}

function parseProcessLine(line: string): ServerNormalizationProcessInfo | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
  if (!match) return null;
  const [, pid, ppid, pgid, nice, cpuPercent, stat, command] = match;
  if (!pid || !ppid || !pgid || !nice || !cpuPercent || !stat || !command) return null;
  return {
    pid: Number.parseInt(pid, 10),
    ppid: Number.parseInt(ppid, 10),
    pgid: Number.parseInt(pgid, 10),
    nice: Number.parseInt(nice, 10),
    cpuPercent: Number.parseFloat(cpuPercent),
    stat,
    command,
  };
}

function readTextTail(filePath: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function tailLines(filePath: string, lines: number): string[] {
  return tailLinesFromText(readTextTail(filePath, 128 * 1024), lines);
}

function tailLinesFromText(text: string, lines: number): string[] {
  if (!text.trim()) return [];
  return text.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-lines);
}

function parseNormalizationProgress(text: string): ServerNormalizationJobStatus['progress'] {
  let current: number | null = null;
  let total: number | null = null;
  for (const match of text.matchAll(/\bCHECK\b[^\d]*(\d+)\s*\/\s*(\d+)/gi)) {
    const rawCurrent = match[1];
    const rawTotal = match[2];
    if (!rawCurrent || !rawTotal) continue;
    current = Number.parseInt(rawCurrent, 10);
    total = Number.parseInt(rawTotal, 10);
  }
  const percent = current !== null && total !== null && total > 0
    ? Number(((current / total) * 100).toFixed(1))
    : null;
  return { current, total, percent };
}

function inferNormalizationProgress(
  progress: ServerNormalizationJobStatus['progress'],
  counts: ServerNormalizationJobStatus['counts'],
  jobKey: ServerNormalizationJobStatus['key']
): ServerNormalizationJobStatus['progress'] {
  if (progress.current !== null || progress.total !== null) return progress;
  const statusCount = counts.ok + counts.failed + counts.other;
  const actionCount = counts.normalized
    + counts.existingValid
    + counts.promotedReady
    + counts.needsNormalize
    + counts.fix
    + counts.noAction;
  const decisionCount = counts.remux + counts.audioOnly + counts.fullTranscode;
  const processed = Math.max(statusCount, actionCount, decisionCount);
  if (processed === 0) return progress;
  const total = jobKey === 'fix_existing_normalized' ? 178 : null;
  const percent = total !== null && total > 0 ? Number(((processed / total) * 100).toFixed(1)) : null;
  return {
    current: processed,
    total,
    percent,
  };
}

function parseNormalizationCounts(text: string): ServerNormalizationJobStatus['counts'] {
  const counts = emptyNormalizationCounts();
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim().toLowerCase();
    if (!normalized) continue;
    if (/^(ok|pass|valid)\b/.test(normalized)) counts.ok += 1;
    else if (/^(failed|fail|error)\b/.test(normalized)) counts.failed += 1;
    else if (/^(unknown|other)\b/.test(normalized)) counts.other += 1;
    if (/\bnormalized\b/.test(normalized)) counts.normalized += 1;
    if (/existing[-_ ]valid/.test(normalized)) counts.existingValid += 1;
    if (/promoted[-_ ]ready/.test(normalized)) counts.promotedReady += 1;
    if (/needs[-_ ]normalize/.test(normalized)) counts.needsNormalize += 1;
    if (/^(fix|fixed|rewrite|recompress)\b/.test(normalized)) counts.fix += 1;
    if (/remux/.test(normalized)) counts.remux += 1;
    if (/audio[-_ ]only/.test(normalized)) counts.audioOnly += 1;
    if (/full[-_ ]transcode|transcode/.test(normalized)) counts.fullTranscode += 1;
    if (/no[-_ ]?action|skip/.test(normalized)) counts.noAction += 1;
    if (/deleted[_ ]original|original deleted/.test(normalized)) counts.deletedOriginal += 1;
  }
  return counts;
}

function parseNormalizationReportCounts(reportPath: string): ServerNormalizationJobStatus['counts'] | null {
  const text = readTextTail(reportPath, 8 * 1024 * 1024);
  if (!text.trim()) return null;
  const counts = emptyNormalizationCounts();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines[0] ?? '').map(value => value.toLowerCase());
  const columnIndex = (name: string, fallback: number) => {
    const index = headers.indexOf(name);
    return index >= 0 ? index : fallback;
  };
  const statusIndex = columnIndex('status', 1);
  const actionIndex = columnIndex('action', 2);
  const decisionIndex = columnIndex('decision', 3);
  const deletedIndex = columnIndex('deleted_original', 7);
  for (const line of lines.slice(1)) {
    const columns = splitCsvLine(line);
    const status = (columns[statusIndex] ?? '').toLowerCase();
    const action = (columns[actionIndex] ?? '').toLowerCase();
    const decision = (columns[decisionIndex] ?? '').toLowerCase();
    const deleted = (columns[deletedIndex] ?? '').toLowerCase();
    if (status.includes('failed') || status.includes('fail') || status.includes('error')) counts.failed += 1;
    else if (status.includes('ok') || status.includes('valid') || status.includes('pass')) counts.ok += 1;
    else counts.other += 1;

    if (action.includes('normalized')) counts.normalized += 1;
    if (action.includes('existing_valid') || action.includes('existing valid')) {
      counts.existingValid += 1;
      counts.noAction += 1;
    }
    if (action.includes('promoted_ready') || action.includes('promoted ready')) {
      counts.promotedReady += 1;
      counts.noAction += 1;
    }
    if (action.includes('needs_normalize') || action.includes('needs normalize')) counts.needsNormalize += 1;
    if (action.includes('fix') || action.includes('fixed') || action.includes('rewrite')) counts.fix += 1;
    if (action.includes('skip') || action.includes('no_action') || action.includes('no action')) counts.noAction += 1;

    if (decision.includes('remux')) counts.remux += 1;
    if (decision.includes('audio')) counts.audioOnly += 1;
    if (decision.includes('transcode')) counts.fullTranscode += 1;
    if (deleted === 'yes' || deleted === 'true' || deleted === '1') counts.deletedOriginal += 1;
  }
  return counts;
}

function emptyNormalizationCounts(): ServerNormalizationJobStatus['counts'] {
  return {
    ok: 0,
    failed: 0,
    fix: 0,
    noAction: 0,
    remux: 0,
    audioOnly: 0,
    fullTranscode: 0,
    normalized: 0,
    existingValid: 0,
    promotedReady: 0,
    needsNormalize: 0,
    deletedOriginal: 0,
    other: 0,
  };
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result.map(value => value.trim());
}

function reportPathFromOutput(text: string, pattern: RegExp): string | null {
  for (const match of text.matchAll(/\/srv\/daawah\/media\/normalized-ar\/reports\/[^\s'"<>]+\.csv/g)) {
    const reportPath = match[0];
    if (reportPath && pattern.test(path.posix.basename(reportPath)) && fs.existsSync(reportPath)) {
      return reportPath;
    }
  }
  return null;
}

function latestReportPath(pattern: RegExp): string | null {
  const reportDir = path.posix.join(getNormalizedOutputRoot(), 'reports');
  try {
    const candidates = fs.readdirSync(reportDir)
      .filter(name => pattern.test(name))
      .map(name => path.posix.join(reportDir, name))
      .filter(filePath => fs.statSync(filePath).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

function directorySizeLabel(dirPath: string): string {
  if (!fs.existsSync(dirPath)) return 'missing';
  try {
    const output = childProcess.execFileSync('du', ['-sh', dirPath], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    }).trim();
    return output.split(/\s+/)[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function renderPlanMarkdown(detail: NormalizationPlanDetail): string {
  return `# Normalization Dry-Run Plan

- Plan: ${detail.id}
- Status: ${detail.status}
- Scope: ${detail.scope}
- Output root: ${detail.outputRoot}
- Total files: ${detail.summary.total}
- OK: ${detail.summary.ok}
- Remux: ${detail.summary.remux}
- Audio-only: ${detail.summary.audioOnly}
- Full transcode: ${detail.summary.fullTranscode}
- Failed: ${detail.summary.failed}
- FFmpeg execution: false
- Original media modification: false
- Normalized media writes: false

Acceptance gate:
- failed: 0
- video: ${detail.summary.acceptance.video}
- audio: ${detail.summary.acceptance.audio}
- timestamps: ${detail.summary.acceptance.timestamps}
`;
}

function renderNormalizedSetDiff(detail: NormalizedSetDetail): string {
  const rows = detail.diff
    .map(item => `| ${item.title.replace(/\|/g, '/')} | ${item.decision} | ${item.normalizedExists ? 'yes' : 'no'} | ${item.originalSafeFallback ? 'yes' : 'no'} | ${item.originalPath.replace(/\|/g, '/')} | ${item.normalizedPath.replace(/\|/g, '/')} |`)
    .join('\n');
  return `# Normalized Set Diff

- Set: ${detail.id}
- Run: ${detail.runId}
- Plan: ${detail.planId}
- Status: ${detail.status}
- Total: ${detail.summary.total}
- Normalized ready: ${detail.summary.normalizedReady}
- Original safe fallback: ${detail.summary.originalSafeFallback}
- Missing normalized: ${detail.summary.missingNormalized}
- Playlist activation: false
- Playout: false
- Broadcast: false

| Title | Decision | Normalized exists | Original safe fallback | Original | Normalized |
| --- | --- | --- | --- | --- | --- |
${rows}
`;
}

function mapPlanRow(row: NormalizationPlanRow): NormalizationPlanDetail {
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    outputRoot: row.output_root,
    artifactPath: row.artifact_path,
    target: parseJson<NormalizationTargetProfile>(row.target_json),
    summary: parseJson<NormalizationSummary>(row.summary_json),
    items: parseJson<NormalizationPreflightItem[]>(row.items_json),
    tasks: parseJson<NormalizationPlanTask[]>(row.tasks_json),
    errors: parseJson<Array<{ code: string; message: string; itemId?: string }>>(row.errors_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    safety: getDryRunSafety(),
  };
}

function mapRunRow(row: NormalizationRunRow): NormalizationRunDetail {
  return {
    id: row.id,
    planId: row.plan_id,
    status: row.status,
    outputRoot: row.output_root,
    artifactPath: row.artifact_path,
    logPath: row.log_path,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    currentTaskId: row.current_task_id,
    currentFile: row.current_file,
    elapsedSeconds: row.elapsed_seconds,
    estimatedRemainingSeconds: row.estimated_remaining_seconds,
    outputSizeBytes: row.output_size_bytes,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    totalCount: row.total_count,
    errors: parseJson<Array<{ code: string; message: string; taskId?: string }>>(row.errors_json),
    safety: {
      normalizedMediaWrites: true,
      originalMediaModification: false,
      playlistActivation: false,
      playout: false,
      broadcast: false,
      outputRoot: row.output_root,
    },
  };
}

function mapNormalizedSetRow(row: NormalizedSetRow): NormalizedSetDetail {
  return {
    id: row.id,
    runId: row.run_id,
    planId: row.plan_id,
    status: row.status,
    outputRoot: row.output_root,
    artifactPath: row.artifact_path,
    diffPath: row.diff_path,
    summary: parseJson<NormalizedSetDetail['summary']>(row.summary_json),
    diff: parseJson<NormalizedSetDiffItem[]>(row.diff_json),
    createdAt: row.created_at,
    safety: {
      deletesOriginal: false,
      mediaModification: false,
      playlistActivation: false,
      playout: false,
      broadcast: false,
    },
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
