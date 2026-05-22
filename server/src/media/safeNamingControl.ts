import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import { normalizeArabicForMatch } from './safeNaming';

export const SAFE_NAMING_IMPORT_CONFIRMATION = 'IMPORT SAFE NAMING';

export class SafeNamingControlError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface SafeNamingDisplayRow {
  id: string;
  originalArabicName: string;
  originalPath: string;
  displayName: string;
  normalizedName: string;
  safeSlug: string;
  root: string;
  reviewStatus: 'approved' | 'pending' | 'needs_review' | 'rejected';
  schedulingStatus: 'schedulable' | 'archive_only' | 'bumper' | 'not_ready' | 'unknown';
  archiveStatus: 'protected_archive' | 'scheduling_root' | 'support_asset' | 'unknown';
  collisionGroup: string | null;
  manualSlugOverrideDraft: string | null;
}

export interface SafeNamingImportEntry extends SafeNamingDisplayRow {
  candidateType: string;
  reason: string;
}

export interface SafeNamingImportPreview {
  mode: 'preview';
  entryCount: number;
  entries: SafeNamingImportEntry[];
  needsReview: SafeNamingImportEntry[];
  slugCollisions: Array<{ safeSlug: string; entries: SafeNamingImportEntry[] }>;
  safety: {
    previewOnly: true;
    applyRequiresConfirmation: typeof SAFE_NAMING_IMPORT_CONFIRMATION;
    mediaRenameMoveDelete: false;
    mediaWrites: false;
    originalArabicNamesPreserved: true;
    livePlayoutMutation: false;
  };
}

export interface SafeNamingControlPanel {
  mode: 'control-panel';
  rows: SafeNamingDisplayRow[];
  needsReview: SafeNamingDisplayRow[];
  slugCollisions: Array<{ safeSlug: string; entries: SafeNamingDisplayRow[] }>;
  safety: SafeNamingImportPreview['safety'];
}

interface MediaSafeNameRow {
  id: string;
  path: string;
  filename: string;
  status: string;
  root_key: string | null;
  absolute_path: string | null;
  original_filename: string | null;
  display_title_ar: string | null;
  normalized_title: string | null;
  safe_slug: string | null;
  approved_status: string | null;
  collision_group: string | null;
}

interface SafeNamingCsvRow {
  root: string;
  original_path: string;
  original_name: string;
  normalized_name: string;
  proposed_display_name: string;
  proposed_safe_slug: string;
  candidate_type: string;
  review_status: string;
  reason: string;
  collision_group: string;
  slug_collision: string;
}

const SAFETY: SafeNamingImportPreview['safety'] = {
  previewOnly: true,
  applyRequiresConfirmation: SAFE_NAMING_IMPORT_CONFIRMATION,
  mediaRenameMoveDelete: false,
  mediaWrites: false,
  originalArabicNamesPreserved: true,
  livePlayoutMutation: false,
};

export function getSafeNamingControlPanel(): SafeNamingControlPanel {
  const rows = listSafeNamingRows();
  return {
    mode: 'control-panel',
    rows,
    needsReview: rows.filter(row => row.reviewStatus !== 'approved' || row.collisionGroup !== null),
    slugCollisions: groupSlugCollisions(rows),
    safety: SAFETY,
  };
}

export function listSafeNamingRows(limit = 500): SafeNamingDisplayRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      mf.id,
      mf.path,
      mf.filename,
      mf.status,
      mr.root_key,
      mr.absolute_path,
      mf.original_filename,
      mf.display_title_ar,
      mf.normalized_title,
      mf.safe_slug,
      snm.approved_status,
      snm.collision_group
    FROM media_files mf
    LEFT JOIN media_roots mr ON mr.id = mf.root_id
    LEFT JOIN safe_name_mappings snm
      ON snm.entity_type='media_file' AND snm.entity_id=mf.id
    WHERE mf.root_id IS NOT NULL
    ORDER BY mr.root_key, mf.original_relative_path, mf.filename
    LIMIT ?
  `).all(clampLimit(limit)) as MediaSafeNameRow[];

  const displayRows = rows.map(row => rowToDisplay(row));
  return withComputedCollisions(displayRows);
}

export function previewSafeNamingImport(input: {
  csvContent?: string;
  csvPath?: string;
  manualSlugOverrides?: Record<string, string>;
}): SafeNamingImportPreview {
  const entries = parseSafeNamingCsv(resolveCsvContent(input.csvContent, input.csvPath))
    .map(row => csvRowToImportEntry(row, input.manualSlugOverrides ?? {}));
  const withCollisions = withComputedCollisions(entries) as SafeNamingImportEntry[];

  return {
    mode: 'preview',
    entryCount: withCollisions.length,
    entries: withCollisions,
    needsReview: withCollisions.filter(row => row.reviewStatus !== 'approved' || row.collisionGroup !== null),
    slugCollisions: groupSlugCollisions(withCollisions) as Array<{ safeSlug: string; entries: SafeNamingImportEntry[] }>,
    safety: SAFETY,
  };
}

export function applySafeNamingImport(input: {
  csvContent?: string;
  csvPath?: string;
  manualSlugOverrides?: Record<string, string>;
  confirmationText?: string;
  dryRun?: boolean;
}): {
  mode: 'dry_run' | 'applied';
  confirmationRequired: typeof SAFE_NAMING_IMPORT_CONFIRMATION;
  entriesConsidered: number;
  safeNameMappingsWritten: number;
  safety: SafeNamingImportPreview['safety'];
} {
  const dryRun = input.dryRun !== false;
  if (!dryRun && input.confirmationText !== SAFE_NAMING_IMPORT_CONFIRMATION) {
    throw new SafeNamingControlError(
      `Safe naming import requires confirmationText="${SAFE_NAMING_IMPORT_CONFIRMATION}"`,
      'SAFE_NAMING_CONFIRMATION_REQUIRED'
    );
  }

  const preview = previewSafeNamingImport(input);
  if (preview.slugCollisions.length > 0) {
    throw new SafeNamingControlError('Resolve slug collisions before applying safe naming import', 'SAFE_NAMING_SLUG_COLLISIONS');
  }

  if (dryRun) {
    return {
      mode: 'dry_run',
      confirmationRequired: SAFE_NAMING_IMPORT_CONFIRMATION,
      entriesConsidered: preview.entryCount,
      safeNameMappingsWritten: preview.entries.length,
      safety: SAFETY,
    };
  }

  const db = getDb();
  const insert = db.prepare(`
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

  const write = db.transaction(() => {
    for (const entry of preview.entries) {
      insert.run(
        uuidv4(),
        entry.candidateType || 'media_file',
        entry.originalPath,
        entry.originalArabicName,
        entry.normalizedName,
        entry.safeSlug,
        entry.collisionGroup,
        0,
        entry.reviewStatus === 'approved' ? 'approved' : 'pending'
      );
    }
  });
  write();

  return {
    mode: 'applied',
    confirmationRequired: SAFE_NAMING_IMPORT_CONFIRMATION,
    entriesConsidered: preview.entryCount,
    safeNameMappingsWritten: preview.entries.length,
    safety: SAFETY,
  };
}

export function parseSafeNamingCsv(content: string): SafeNamingCsvRow[] {
  const parsed = parse(content, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Array<Record<string, string | undefined>>;

  return parsed.map(row => ({
    root: clean(row['root']),
    original_path: clean(row['original_path']),
    original_name: clean(row['original_name']),
    normalized_name: clean(row['normalized_name']),
    proposed_display_name: clean(row['proposed_display_name']),
    proposed_safe_slug: clean(row['proposed_safe_slug']),
    candidate_type: clean(row['candidate_type']),
    review_status: clean(row['review_status']),
    reason: clean(row['reason']),
    collision_group: clean(row['collision_group']),
    slug_collision: clean(row['slug_collision']),
  }));
}

function rowToDisplay(row: MediaSafeNameRow): SafeNamingDisplayRow {
  const root = row.root_key ?? rootFromPath(row.path);
  const originalName = row.original_filename ?? row.filename;
  const displayName = row.display_title_ar ?? stripExtension(originalName);
  const normalizedName = row.normalized_title ?? normalizeArabicForMatch(displayName);
  const safeSlug = row.safe_slug ?? slugFallback(displayName);
  return {
    id: row.id,
    originalArabicName: originalName,
    originalPath: row.path,
    displayName,
    normalizedName,
    safeSlug,
    root,
    reviewStatus: normalizeReviewStatus(row.approved_status, row.status),
    schedulingStatus: schedulingStatus(root, row.status),
    archiveStatus: archiveStatus(root),
    collisionGroup: row.collision_group ?? null,
    manualSlugOverrideDraft: null,
  };
}

function csvRowToImportEntry(row: SafeNamingCsvRow, overrides: Record<string, string>): SafeNamingImportEntry {
  const override = clean(overrides[row.original_path]);
  const displayName = row.proposed_display_name || row.original_name;
  const safeSlug = override || row.proposed_safe_slug || slugFallback(displayName);
  const collisionGroup = row.collision_group || row.slug_collision || null;
  return {
    id: row.original_path || `${row.root}:${row.original_name}`,
    originalArabicName: row.original_name,
    originalPath: row.original_path,
    displayName,
    normalizedName: row.normalized_name || normalizeArabicForMatch(displayName),
    safeSlug,
    root: row.root,
    reviewStatus: normalizeReviewStatus(row.review_status, 'pending'),
    schedulingStatus: schedulingStatus(row.root, 'ready'),
    archiveStatus: archiveStatus(row.root),
    collisionGroup,
    manualSlugOverrideDraft: override || null,
    candidateType: row.candidate_type,
    reason: row.reason,
  };
}

function withComputedCollisions<T extends SafeNamingDisplayRow>(rows: T[]): T[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.safeSlug, (counts.get(row.safeSlug) ?? 0) + 1);
  }
  return rows.map(row => {
    if (row.collisionGroup || (counts.get(row.safeSlug) ?? 0) <= 1) return row;
    return {
      ...row,
      reviewStatus: row.reviewStatus === 'approved' ? 'needs_review' : row.reviewStatus,
      collisionGroup: `slug:${row.safeSlug}`,
    };
  });
}

function groupSlugCollisions<T extends SafeNamingDisplayRow>(rows: T[]): Array<{ safeSlug: string; entries: T[] }> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.safeSlug) ?? [];
    list.push(row);
    groups.set(row.safeSlug, list);
  }
  return Array.from(groups.entries())
    .filter(([, entries]) => entries.length > 1)
    .map(([safeSlug, entries]) => ({ safeSlug, entries }));
}

function normalizeReviewStatus(value: string | null, fallbackStatus: string): SafeNamingDisplayRow['reviewStatus'] {
  if (value === 'approved' || value === 'rejected') return value;
  if (value === 'ready') return 'approved';
  if (value === 'needs_review') return 'needs_review';
  if (fallbackStatus === 'needs_review' || fallbackStatus === 'invalid') return 'needs_review';
  return 'pending';
}

function schedulingStatus(root: string, status: string): SafeNamingDisplayRow['schedulingStatus'] {
  if (root === 'original-ar') return 'archive_only';
  if (root === 'bumpers') return 'bumper';
  if (root === 'source') return status === 'ready' || status === 'pending' ? 'schedulable' : 'not_ready';
  return 'unknown';
}

function archiveStatus(root: string): SafeNamingDisplayRow['archiveStatus'] {
  if (root === 'original-ar') return 'protected_archive';
  if (root === 'source') return 'scheduling_root';
  if (root === 'bumpers') return 'support_asset';
  return 'unknown';
}

function resolveCsvContent(csvContent?: string, csvPath?: string): string {
  if (csvContent) return csvContent;
  if (!csvPath) {
    throw new SafeNamingControlError('csvContent or csvPath is required', 'SAFE_NAMING_CSV_REQUIRED');
  }
  const resolved = path.resolve(csvPath);
  if (!resolved.endsWith('.csv')) {
    throw new SafeNamingControlError('Safe naming import path must be a CSV file', 'SAFE_NAMING_CSV_EXTENSION');
  }
  if (!fs.existsSync(resolved)) {
    throw new SafeNamingControlError('Safe naming import CSV was not found', 'SAFE_NAMING_CSV_NOT_FOUND', 404);
  }
  return fs.readFileSync(resolved, 'utf8');
}

function rootFromPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('/srv/daawah/media/original-ar/')) return 'original-ar';
  if (normalized.includes('/srv/daawah/media/source/')) return 'source';
  if (normalized.includes('/srv/daawah/media/bumpers/')) return 'bumpers';
  return 'unknown';
}

function stripExtension(value: string): string {
  return value.replace(/\.[^.]+$/, '');
}

function slugFallback(value: string): string {
  return normalizeArabicForMatch(value)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'unnamed';
}

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit)) return 500;
  return Math.min(Math.max(limit, 1), 2000);
}
