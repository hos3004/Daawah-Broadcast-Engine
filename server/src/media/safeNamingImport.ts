import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { parse } from 'csv-parse/sync';
import { getDb } from '../db/schema';
import { logger } from '../utils/logger';

export const APPLY_CONFIRMATION_TEXT = 'IMPORT SAFE NAMING';

const ALLOWED_CSV_DIRS: string[] = [
  '/opt/daawah-broadcast-test/reports',
];

export class SafeNamingImportError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'SafeNamingImportError';
  }
}

export interface SafeNamingCsvEntry {
  root: string;
  originalPath: string;
  originalName: string;
  normalizedName: string;
  proposedDisplayName: string;
  proposedSafeSlug: string;
  candidateType: string;
  confidence: string;
  reviewStatus: string;
  reason: string;
  collisionGroup: string;
  slugCollision: string;
}

export interface SafeNamingImportPreview {
  mode: 'preview';
  csvPath?: string;
  entryCount: number;
  readyCount: number;
  needsReviewCount: number;
  byRoot: Array<{ root: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  candidateTypes: Array<{ type: string; count: number }>;
  collisionGroups: Array<{ group: string; entries: number }>;
  slugCollisions: Array<{ slug: string; entries: number }>;
  programCandidateCount: number;
  sampleNeedsReview: Array<{ originalName: string; reason: string; collisionGroup: string }>;
}

export interface SafeNamingImportApplyResult {
  mode: 'dry_run' | 'applied';
  safeNameMappingsWritten: number;
  programCandidatesWritten: number;
  skippedNeedsReview: number;
  errors: string[];
  timestamp: string;
}

interface ProcessedMapping {
  id: string;
  entityType: string;
  entityId: string;
  originalName: string;
  normalizedName: string;
  safeSlug: string;
  collisionGroup: string | null;
  collisionIndex: number;
  approvedStatus: string;
}

interface ProcessedCandidate {
  id: string;
  folderId: string | null;
  originalPath: string;
  suggestedProgramKey: string;
  displayNameAr: string;
  safeSlug: string;
  episodeCount: number;
  playModeSuggestion: string;
  slotModeSuggestion: string;
  confidenceScore: number;
  needsReview: boolean;
  root: string;
}

const RAW_SLUG_COLLISIONS = new Map<string, number>();

function resetSlugCollisionTracker(): void {
  RAW_SLUG_COLLISIONS.clear();
}

function resolveSlug(baseSlug: string, collisionTag: string): string {
  if (!collisionTag) return baseSlug;
  const current = RAW_SLUG_COLLISIONS.get(collisionTag) ?? 0;
  RAW_SLUG_COLLISIONS.set(collisionTag, current + 1);
  return current === 0 ? baseSlug : `${baseSlug}-${current + 1}`;
}

export function parseSafeNamingCsv(csvContent: string): SafeNamingCsvEntry[] {
  const raw = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  return raw.map(row => ({
    root: (row['root'] ?? '').trim(),
    originalPath: (row['original_path'] ?? '').trim(),
    originalName: (row['original_name'] ?? '').trim(),
    normalizedName: (row['normalized_name'] ?? '').trim(),
    proposedDisplayName: (row['proposed_display_name'] ?? '').trim(),
    proposedSafeSlug: (row['proposed_safe_slug'] ?? '').trim(),
    candidateType: (row['candidate_type'] ?? '').trim(),
    confidence: (row['confidence'] ?? '').trim(),
    reviewStatus: (row['review_status'] ?? '').trim(),
    reason: (row['reason'] ?? '').trim(),
    collisionGroup: (row['collision_group'] ?? '').trim(),
    slugCollision: (row['slug_collision'] ?? '').trim(),
  }));
}

export function analyzeImportPlan(entries: SafeNamingCsvEntry[]): SafeNamingImportPreview {
  const ready = entries.filter(e => e.reviewStatus === 'ready');
  const needsReview = entries.filter(e => e.reviewStatus === 'needs_review');

  const byRootMap = new Map<string, number>();
  for (const e of entries) {
    byRootMap.set(e.root, (byRootMap.get(e.root) ?? 0) + 1);
  }

  const byTypeMap = new Map<string, number>();
  for (const e of entries) {
    byTypeMap.set(e.candidateType, (byTypeMap.get(e.candidateType) ?? 0) + 1);
  }

  const collisionGroups = new Map<string, number>();
  const slugCollisions = new Map<string, number>();
  for (const e of entries) {
    if (e.collisionGroup) {
      collisionGroups.set(e.collisionGroup, (collisionGroups.get(e.collisionGroup) ?? 0) + 1);
    }
    if (e.slugCollision) {
      slugCollisions.set(e.slugCollision, (slugCollisions.get(e.slugCollision) ?? 0) + 1);
    }
  }

  const programCandidates = deduplicateProgramCandidates(entries);

  return {
    mode: 'preview',
    entryCount: entries.length,
    readyCount: ready.length,
    needsReviewCount: needsReview.length,
    byRoot: Array.from(byRootMap.entries()).map(([root, count]) => ({ root, count })),
    byType: Array.from(byTypeMap.entries()).map(([type, count]) => ({ type, count })),
    candidateTypes: Array.from(byTypeMap.entries()).map(([type, count]) => ({ type, count })),
    collisionGroups: Array.from(collisionGroups.entries()).map(([group, entries]) => ({ group, entries })),
    slugCollisions: Array.from(slugCollisions.entries()).map(([slug, entries]) => ({ slug, entries })),
    programCandidateCount: programCandidates.length,
    sampleNeedsReview: needsReview.slice(0, 10).map(e => ({
      originalName: e.originalName,
      reason: e.reason,
      collisionGroup: e.collisionGroup,
    })),
  };
}

function confidenceToScore(confidence: string): number {
  switch (confidence) {
    case 'high': return 0.95;
    case 'medium': return 0.65;
    case 'low': return 0.35;
    default: return 0.5;
  }
}

function deduplicateProgramCandidates(entries: SafeNamingCsvEntry[]): ProcessedCandidate[] {
  const seenBySafeSlug = new Map<string, ProcessedCandidate>();

  for (const entry of entries) {
    if (entry.candidateType === 'bumper') continue;

    const slug = resolveSlug(entry.proposedSafeSlug, entry.slugCollision);
    const existing = seenBySafeSlug.get(slug);

    if (existing) {
      if (existing.root === 'original-ar' && entry.root !== 'original-ar') {
        seenBySafeSlug.set(slug, makeCandidate(entry, slug));
      }
    } else {
      seenBySafeSlug.set(slug, makeCandidate(entry, slug));
    }
  }

  return Array.from(seenBySafeSlug.values());
}

function makeCandidate(entry: SafeNamingCsvEntry, resolvedSlug: string): ProcessedCandidate {
  return {
    id: uuidv4(),
    folderId: null,
    originalPath: entry.originalPath,
    suggestedProgramKey: resolvedSlug,
    displayNameAr: entry.proposedDisplayName || entry.originalName,
    safeSlug: resolvedSlug,
    episodeCount: 0,
    playModeSuggestion: 'sequential',
    slotModeSuggestion: 'fit',
    confidenceScore: confidenceToScore(entry.confidence),
    needsReview: entry.reviewStatus === 'needs_review',
    root: entry.root,
  };
}

function mapEntityType(candidateType: string): string {
  switch (candidateType) {
    case 'program': return 'program';
    case 'bumper': return 'bumper';
    case 'original-library': return 'library';
    case 'needs_review': return 'unknown';
    default: return 'unknown';
  }
}

function assignCollisionIndices(entries: SafeNamingCsvEntry[]): Map<string, number>[] {
  const groups = new Map<string, SafeNamingCsvEntry[]>();
  for (const e of entries) {
    if (!e.collisionGroup) continue;
    const list = groups.get(e.collisionGroup) ?? [];
    list.push(e);
    groups.set(e.collisionGroup, list);
  }

  const indices = new Map<string, number>();
  for (const [, groupEntries] of groups) {
    groupEntries.forEach((e, i) => {
      indices.set(e.originalPath, i);
    });
  }
  return [indices];
}

function buildMappings(entries: SafeNamingCsvEntry[]): ProcessedMapping[] {
  resetSlugCollisionTracker();
  const collisionIndexMap = assignCollisionIndices(entries)[0] ?? new Map<string, number>();

  return entries.map(entry => {
    const slug = resolveSlug(entry.proposedSafeSlug, entry.slugCollision);
    const collisionIndex = collisionIndexMap.get(entry.originalPath) ?? 0;
    return {
      id: uuidv4(),
      entityType: mapEntityType(entry.candidateType),
      entityId: entry.originalPath,
      originalName: entry.originalName,
      normalizedName: entry.normalizedName,
      safeSlug: slug,
      collisionGroup: entry.collisionGroup || null,
      collisionIndex,
      approvedStatus: entry.reviewStatus === 'ready' ? 'approved' : 'pending',
    };
  });
}

function lookupFolderId(rootKey: string, originalPath: string): string | null {
  const db = getDb();
  try {
    const root = db.prepare('SELECT id, absolute_path FROM media_roots WHERE root_key=?')
      .get(rootKey) as { id: string; absolute_path: string } | undefined;
    if (!root) return null;

    const relativePath = path
      .relative(root.absolute_path, originalPath)
      .replace(/\\/g, '/');

    // Try exact match first
    let folder = db.prepare(
      'SELECT id FROM media_folders WHERE root_id=? AND original_relative_path=?'
    ).get(root.id, relativePath) as { id: string } | undefined;

    // Fallback: match by TRIM to handle trailing/leading whitespace differences
    if (!folder) {
      folder = db.prepare(
        'SELECT id FROM media_folders WHERE root_id=? AND TRIM(original_relative_path)=TRIM(?)'
      ).get(root.id, relativePath) as { id: string } | undefined;
    }

    return folder?.id ?? null;
  } catch {
    return null;
  }
}

function validateCsvPath(csvPath: string): void {
  if (!csvPath.endsWith('.csv')) {
    throw new SafeNamingImportError(
      `Not a CSV file: ${csvPath}`,
      'INVALID_CSV_EXTENSION'
    );
  }

  if (!fs.existsSync(csvPath)) {
    throw new SafeNamingImportError(
      `CSV file not found: ${csvPath}`,
      'CSV_FILE_NOT_FOUND'
    );
  }

  const resolved = path.resolve(csvPath);
  const envDir = process.env['SAFE_NAMING_IMPORT_DIR'];
  const allAllowed = [...ALLOWED_CSV_DIRS];
  if (envDir) allAllowed.push(envDir);

  const withinAllowed = allAllowed.some(dir => {
    const allowedPath = path.resolve(dir);
    return resolved.startsWith(allowedPath + path.sep) || resolved === allowedPath;
  });

  if (!withinAllowed) {
    throw new SafeNamingImportError(
      `CSV path "${csvPath}" is not within an approved reports directory. ` +
      `Allowed: ${allAllowed.join(', ')}`,
      'CSV_PATH_NOT_ALLOWED'
    );
  }
}

function validateOriginalPaths(entries: SafeNamingCsvEntry[]): void {
  const db = getDb();
  const roots = db.prepare('SELECT absolute_path FROM media_roots').all() as { absolute_path: string }[];
  const allowedRoots = roots.map(r => path.resolve(r.absolute_path));

  if (allowedRoots.length === 0) {
    throw new SafeNamingImportError(
      'No media roots configured in database. Cannot validate original paths.',
      'NO_MEDIA_ROOTS'
    );
  }

  for (const entry of entries) {
    const resolved = path.resolve(entry.originalPath);
    const withinRoot = allowedRoots.some(
      root => resolved.startsWith(root + path.sep) || resolved === root
    );
    if (!withinRoot) {
      throw new SafeNamingImportError(
        `Original path "${entry.originalPath}" is outside all configured media roots. ` +
        `Allowed roots: ${allowedRoots.join(', ')}`,
        'ORIGINAL_PATH_OUTSIDE_ROOT'
      );
    }
  }
}

function validateApplyPreconditions(
  entries: SafeNamingCsvEntry[],
  options: {
    csvPath?: string;
    confirmationText?: string;
    importReadyOnly: boolean;
  }
): void {
  if (options.confirmationText !== APPLY_CONFIRMATION_TEXT) {
    throw new SafeNamingImportError(
      `Confirmation text mismatch. Expected: "${APPLY_CONFIRMATION_TEXT}"`,
      'CONFIRMATION_TEXT_MISMATCH'
    );
  }

  if (options.csvPath) {
    validateCsvPath(options.csvPath);
  }

  validateOriginalPaths(entries);

  const unresolvedSlugCollisions = entries.filter(e => e.slugCollision);
  if (unresolvedSlugCollisions.length > 0) {
    throw new SafeNamingImportError(
      `${unresolvedSlugCollisions.length} entries have unresolved slug collisions (${unresolvedSlugCollisions[0]?.slugCollision ?? 'unknown'}, ...). ` +
      `Edit the CSV to assign unique proposed_safe_slug values before applying.`,
      'UNRESOLVED_SLUG_COLLISIONS'
    );
  }

  if (options.importReadyOnly) {
    const needsReview = entries.filter(e => e.reviewStatus === 'needs_review');
    if (needsReview.length > 0) {
      throw new SafeNamingImportError(
        `${needsReview.length} entries have review_status=needs_review. ` +
        `Set importReadyOnly=false to include them, or resolve them first.`,
        'NEEDS_REVIEW_EXISTS'
      );
    }
  }
}

export function previewImportPlan(options: {
  csvPath?: string;
  csvContent?: string;
}): SafeNamingImportPreview {
  const content = resolveCsvContent(options.csvPath, options.csvContent);
  const entries = parseSafeNamingCsv(content);
  return analyzeImportPlan(entries);
}

export function applyImportPlan(options: {
  csvPath?: string;
  csvContent?: string;
  importReadyOnly?: boolean;
  dryRun?: boolean;
  confirmationText?: string;
}): SafeNamingImportApplyResult {
  const dryRun = options.dryRun ?? true;
  const importReadyOnly = options.importReadyOnly ?? true;

  const content = resolveCsvContent(options.csvPath, options.csvContent);
  const entries = parseSafeNamingCsv(content);
  const readyEntries = entries.filter(e => e.reviewStatus === 'ready');
  const targetEntries = importReadyOnly ? readyEntries : entries;
  const skippedNeedsReview = entries.filter(e => e.reviewStatus === 'needs_review').length;

  if (!dryRun) {
    validateApplyPreconditions(entries, {
      csvPath: options.csvPath,
      confirmationText: options.confirmationText,
      importReadyOnly,
    });
  }

  const mappings = buildMappings(targetEntries);
  const candidates = deduplicateProgramCandidates(targetEntries)
    .filter(c => c.root !== 'original-ar');

  const errors: string[] = [];

  if (dryRun) {
    return {
      mode: 'dry_run',
      safeNameMappingsWritten: mappings.length,
      programCandidatesWritten: candidates.length,
      skippedNeedsReview,
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  const db = getDb();
  const insertMapping = db.prepare(`
    INSERT INTO safe_name_mappings
      (id, entity_type, entity_id, original_name, normalized_name, safe_slug,
       collision_group, collision_index, approved_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      original_name=excluded.original_name,
      normalized_name=excluded.normalized_name,
      safe_slug=excluded.safe_slug,
      collision_group=excluded.collision_group,
      collision_index=excluded.collision_index,
      approved_status=excluded.approved_status,
      updated_at=datetime('now')
  `);

  const insertCandidate = db.prepare(`
    INSERT INTO program_candidates
      (id, folder_id, suggested_program_key, display_name_ar, safe_slug,
       episode_count, play_mode_suggestion, slot_mode_suggestion,
       confidence_score, needs_review, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(folder_id) DO UPDATE SET
      suggested_program_key=excluded.suggested_program_key,
      display_name_ar=excluded.display_name_ar,
      safe_slug=excluded.safe_slug,
      episode_count=excluded.episode_count,
      play_mode_suggestion=excluded.play_mode_suggestion,
      slot_mode_suggestion=excluded.slot_mode_suggestion,
      confidence_score=excluded.confidence_score,
      needs_review=excluded.needs_review,
      updated_at=datetime('now')
  `);

  // Clean up stale mappings whose canonical path changed between CSV runs
  // (e.g. source/shawwal/... → original-ar/...)
  const cleanupStale = db.prepare(
    `DELETE FROM safe_name_mappings
     WHERE entity_type = ? AND safe_slug = ? AND entity_id != ?`
  );
  const seenSlugEntity = new Map<string, string>();
  for (const m of mappings) {
    seenSlugEntity.set(`${m.entityType}::${m.safeSlug}`, m.entityId);
  }

  const insertTransaction = db.transaction(() => {
    for (const [key, entityId] of seenSlugEntity) {
      const sep = key.indexOf('::');
      const entityType = key.substring(0, sep);
      const safeSlug = key.substring(sep + 2);
      cleanupStale.run(entityType, safeSlug, entityId);
    }

    for (const mapping of mappings) {
      insertMapping.run(
        mapping.id,
        mapping.entityType,
        mapping.entityId,
        mapping.originalName,
        mapping.normalizedName,
        mapping.safeSlug,
        mapping.collisionGroup,
        mapping.collisionIndex,
        mapping.approvedStatus,
      );
    }

    for (const candidate of candidates) {
      const folderId = candidate.folderId ?? lookupFolderId(candidate.root, candidate.originalPath);
      if (!folderId) {
        errors.push(`Could not find folder for candidate: ${candidate.displayNameAr} (root: ${candidate.root})`);
        continue;
      }
      insertCandidate.run(
        candidate.id,
        folderId,
        candidate.suggestedProgramKey,
        candidate.displayNameAr,
        candidate.safeSlug,
        candidate.episodeCount,
        candidate.playModeSuggestion,
        candidate.slotModeSuggestion,
        candidate.confidenceScore,
        candidate.needsReview ? 1 : 0,
      );
    }
  });

  insertTransaction();

  logger.info(`Safe naming import applied: ${mappings.length} mappings, ${candidates.length} candidates`);

  return {
    mode: 'applied',
    safeNameMappingsWritten: mappings.length,
    programCandidatesWritten: candidates.length,
    skippedNeedsReview,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export function readCsvFromFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new SafeNamingImportError(`CSV file not found: ${filePath}`, 'CSV_FILE_NOT_FOUND');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function resolveCsvContent(csvPath?: string, csvContent?: string): string {
  if (csvContent) return csvContent;
  if (csvPath) return readCsvFromFile(csvPath);
  throw new SafeNamingImportError(
    'Either csvPath or csvContent must be provided',
    'CSV_INPUT_REQUIRED'
  );
}

export function findLatestImportCsv(searchDir?: string): string | null {
  const dir = searchDir ?? process.env['SAFE_NAMING_IMPORT_DIR'] ?? '';
  if (!dir || !fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('safe-name-db-import-plan-') && f.endsWith('.csv'))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(dir, files[0]!) : null;
}
