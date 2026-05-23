import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getDb } from '../db/schema';
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
    audio: 'AAC 48k stereo';
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

const DEFAULT_ROOT_KEYS = ['source', 'bumpers'];
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
  'container',
  'unscanned',
];
const activeNormalizationRuns = new Map<string, ActiveNormalizationRun>();

export function getNormalizationStatus(): NormalizationStatus {
  const db = getDb();
  const roots = db.prepare(`
    SELECT root_key, absolute_path, is_readonly, is_original_library
    FROM media_roots
    WHERE root_key IN ('source','bumpers','normalized-ar')
    ORDER BY CASE root_key
      WHEN 'source' THEN 0
      WHEN 'bumpers' THEN 1
      WHEN 'normalized-ar' THEN 2
      ELSE 3
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
    '-crf', '20',
    '-pix_fmt', target.pixelFormat,
    '-r', String(target.fps),
    '-c:a', target.audioCodec,
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
  if ((row.audio_codec ?? '').toLowerCase() !== target.audioCodec) reasons.add('audio_codec');
  if (row.audio_rate !== target.audioRate) reasons.add('sample_rate');
  if (path.extname(row.path).toLowerCase() !== '.mp4') reasons.add('container');

  const reasonList = [...reasons];
  if (reasons.has('missing') || reasons.has('duration')) {
    return { decision: 'failed', reasons: reasonList };
  }

  if (hasAnyReason(reasons, ['video_codec', 'resolution', 'fps', 'pix_fmt', 'unscanned'])) {
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
      audio: 'AAC 48k stereo',
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
  return [
    config.ffmpeg.ffmpegPath,
    '-i',
    quoteArg(item.absolutePath),
    '-vf',
    quoteArg(`scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${target.fps},setpts=N/(${target.fps}*TB),settb=1/${target.fps}`),
    '-c:v',
    'libx264',
    '-pix_fmt',
    target.pixelFormat,
    '-c:a',
    target.audioCodec,
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
    container: 'mp4',
  };
}

function getNormalizedOutputRoot(): string {
  const configured = process.env['NORMALIZED_MEDIA_PATH'] ?? '/srv/daawah/media/normalized-ar';
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
  const allowed = new Set(['source', 'bumpers']);
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
