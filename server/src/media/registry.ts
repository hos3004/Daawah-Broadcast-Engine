import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import type { FolderMatchCandidate } from '../schedule/excelPreview';
import { isVideoFile } from '../utils/fileUtils';
import { buildSafeNameMappings, generateSafeSlug, normalizeArabicForMatch } from './safeNaming';
import {
  findMediaRootByKey,
  listMediaRoots,
  type MediaRootDefinition,
  resolveRootRelativePath,
} from './safeRoots';

export interface RegistryScanOptions {
  rootKey?: string;
  dryRun?: boolean;
  provisional?: boolean;
  maxDepth?: number;
  skipRecentlyModifiedMinutes?: number;
}

export interface RegistryScanResult {
  dryRun: boolean;
  provisional: boolean;
  maxDepth: number;
  skipRecentlyModifiedMinutes: number;
  roots: Array<{
    root_key: string;
    absolute_path: string;
    exists: boolean;
    readonly: boolean;
    foldersSeen: number;
    filesSeen: number;
    skippedRecentlyModified: number;
    warnings: string[];
  }>;
  totals: {
    foldersSeen: number;
    filesSeen: number;
    skippedRecentlyModified: number;
    foldersUpserted: number;
    filesUpserted: number;
  };
}

export interface MediaRegistryStatus {
  roots: Array<MediaRootDefinition & { exists: boolean; folderCount: number; fileCount: number }>;
  totals: {
    roots: number;
    folders: number;
    files: number;
    provisionalFiles: number;
    candidates: number;
  };
  uploadSafeMode: boolean;
  finalScanRequired: boolean;
}

interface FolderCandidate {
  id: string;
  rootId: string;
  relativePath: string;
  displayName: string;
  normalizedName: string;
  safeSlug: string;
  parentRelativePath: string | null;
  fileCount: number;
  totalDurationMs: number | null;
  longestFileDurationMs: number | null;
}

interface FileCandidate {
  id: string;
  rootId: string;
  folderRelativePath: string | null;
  relativePath: string;
  absolutePath: string;
  originalFilename: string;
  displayTitle: string;
  normalizedTitle: string;
  safeSlug: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  mediaType: 'program' | 'filler' | 'emergency' | 'other';
}

interface FolderRow {
  id: string;
  display_name_ar: string;
  safe_slug: string;
  file_count: number;
  total_duration_ms: number | null;
  longest_file_duration_ms: number | null;
}

interface CandidateFileRow {
  original_filename: string | null;
  filename: string;
  duration_ms: number | null;
  duration_sec: number | null;
}

const DEFAULT_SKIP_RECENT_MINUTES = 30;

export function getMediaRegistryStatus(): MediaRegistryStatus {
  const db = getDb();
  const roots = listMediaRoots().map(root => {
    const folderCount = (db.prepare('SELECT COUNT(*) as cnt FROM media_folders WHERE root_id=?')
      .get(root.id) as { cnt: number }).cnt;
    const fileCount = (db.prepare('SELECT COUNT(*) as cnt FROM media_files WHERE root_id=?')
      .get(root.id) as { cnt: number }).cnt;
    return {
      ...root,
      exists: fs.existsSync(root.absolute_path),
      folderCount,
      fileCount,
    };
  });

  const totals = {
    roots: roots.length,
    folders: (db.prepare('SELECT COUNT(*) as cnt FROM media_folders').get() as { cnt: number }).cnt,
    files: (db.prepare('SELECT COUNT(*) as cnt FROM media_files WHERE root_id IS NOT NULL').get() as { cnt: number }).cnt,
    provisionalFiles: (db.prepare(`
      SELECT COUNT(*) as cnt FROM media_files
      WHERE root_id IS NOT NULL AND COALESCE(qc_status, 'provisional') = 'provisional'
    `).get() as { cnt: number }).cnt,
    candidates: (db.prepare('SELECT COUNT(*) as cnt FROM program_candidates').get() as { cnt: number }).cnt,
  };

  return {
    roots,
    totals,
    uploadSafeMode: true,
    finalScanRequired: true,
  };
}

export function previewSafeNaming(names: string[]) {
  return buildSafeNameMappings(names.map(originalName => ({ originalName })));
}

export function getFolderMatchCandidates(): FolderMatchCandidate[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      mf.id as folder_id,
      mr.root_key as root_key,
      mf.original_relative_path as original_relative_path,
      mf.display_name_ar as display_name_ar,
      mf.normalized_name as normalized_name,
      mf.safe_slug as safe_slug,
      mf.file_count as file_count,
      COALESCE(pc.episode_count, mf.file_count, 0) as episode_count
    FROM media_folders mf
    JOIN media_roots mr ON mr.id = mf.root_id
    LEFT JOIN program_candidates pc ON pc.folder_id = mf.id
    ORDER BY mr.root_key, mf.original_relative_path
  `).all() as FolderMatchCandidate[];
}

export function scanMediaRegistry(options: RegistryScanOptions = {}): RegistryScanResult {
  const dryRun = options.dryRun ?? true;
  const provisional = options.provisional ?? true;
  const maxDepth = clampInt(options.maxDepth ?? 2, 0, 8);
  const skipRecentlyModifiedMinutes = Math.max(
    0,
    options.skipRecentlyModifiedMinutes ?? DEFAULT_SKIP_RECENT_MINUTES
  );
  const roots = options.rootKey ? [findMediaRootByKey(options.rootKey)] : listMediaRoots();

  const result: RegistryScanResult = {
    dryRun,
    provisional,
    maxDepth,
    skipRecentlyModifiedMinutes,
    roots: [],
    totals: {
      foldersSeen: 0,
      filesSeen: 0,
      skippedRecentlyModified: 0,
      foldersUpserted: 0,
      filesUpserted: 0,
    },
  };

  for (const root of roots) {
    const rootResult = scanRootLight(root, maxDepth, skipRecentlyModifiedMinutes);
    if (!dryRun) {
      const upserted = persistProvisionalScan(root, rootResult.folders, rootResult.files, provisional);
      result.totals.foldersUpserted += upserted.foldersUpserted;
      result.totals.filesUpserted += upserted.filesUpserted;
    }

    result.roots.push({
      root_key: root.root_key,
      absolute_path: root.absolute_path,
      exists: rootResult.exists,
      readonly: root.is_readonly,
      foldersSeen: rootResult.folders.length,
      filesSeen: rootResult.files.length,
      skippedRecentlyModified: rootResult.skippedRecentlyModified,
      warnings: rootResult.warnings,
    });
    result.totals.foldersSeen += rootResult.folders.length;
    result.totals.filesSeen += rootResult.files.length;
    result.totals.skippedRecentlyModified += rootResult.skippedRecentlyModified;
  }

  return result;
}

export function generateProgramCandidatesFromIndexedFolders(options: { persist?: boolean } = {}) {
  const db = getDb();
  const folders = db.prepare(`
    SELECT id, display_name_ar, safe_slug, file_count, total_duration_ms, longest_file_duration_ms
    FROM media_folders
    ORDER BY display_name_ar
  `).all() as FolderRow[];

  const candidates = folders.map(folder => {
    const files = db.prepare(`
      SELECT original_filename, filename, duration_ms, duration_sec
      FROM media_files
      WHERE folder_id=?
      ORDER BY COALESCE(original_filename, filename)
    `).all(folder.id) as CandidateFileRow[];
    const childCount = (db.prepare('SELECT COUNT(*) as cnt FROM media_folders WHERE parent_folder_id=?')
      .get(folder.id) as { cnt: number }).cnt;
    return buildCandidate(folder, files, childCount);
  }).filter(candidate => candidate.episode_count > 0 || candidate.child_folder_count > 0);

  if (options.persist) {
    const stmt = db.prepare(`
      INSERT INTO program_candidates
        (id, folder_id, suggested_program_key, display_name_ar, safe_slug, episode_count,
         play_mode_suggestion, slot_mode_suggestion, confidence_score, needs_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const persist = db.transaction(() => {
      for (const candidate of candidates) {
        stmt.run(
          uuidv4(),
          candidate.folder_id,
          candidate.suggested_program_key,
          candidate.display_name_ar,
          candidate.safe_slug,
          candidate.episode_count,
          candidate.play_mode_suggestion,
          candidate.slot_mode_suggestion,
          candidate.confidence_score,
          candidate.needs_review ? 1 : 0
        );
      }
    });
    persist();
  }

  return {
    provisional: true,
    candidates: candidates.map(({ child_folder_count, ...candidate }) => candidate),
  };
}

function scanRootLight(
  root: MediaRootDefinition,
  maxDepth: number,
  skipRecentlyModifiedMinutes: number
): {
  exists: boolean;
  folders: FolderCandidate[];
  files: FileCandidate[];
  skippedRecentlyModified: number;
  warnings: string[];
} {
  const folders = new Map<string, FolderCandidate>();
  const files: FileCandidate[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(root.absolute_path)) {
    warnings.push('Root path does not exist in this environment');
    return { exists: false, folders: [], files: [], skippedRecentlyModified: 0, warnings };
  }

  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(root.absolute_path);
  } catch (err) {
    warnings.push(`Could not resolve root path: ${String(err)}`);
    return { exists: false, folders: [], files: [], skippedRecentlyModified: 0, warnings };
  }

  let skippedRecentlyModified = 0;
  const cutoffMs = Date.now() - skipRecentlyModifiedMinutes * 60_000;

  const visit = (currentPath: string, relativePath: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Could not read ${relativePath || '.'}: ${String(err)}`);
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symlink: ${path.posix.join(relativePath, entry.name)}`);
        continue;
      }

      const entryPath = path.join(currentPath, entry.name);
      const entryRelativePath = toPosixPath(path.relative(rootRealPath, entryPath));

      if (entry.isDirectory()) {
        const folder = ensureFolderCandidate(folders, root, entryRelativePath);
        if (depth < maxDepth) {
          visit(entryPath, folder.relativePath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile() || !isVideoFile(entry.name)) continue;

      const stat = fs.statSync(entryPath);
      if (skipRecentlyModifiedMinutes > 0 && stat.mtimeMs > cutoffMs) {
        skippedRecentlyModified++;
        continue;
      }

      const folderRelativePath = toPosixPath(path.posix.dirname(entryRelativePath));
      const normalizedFolderRelativePath = folderRelativePath === '.' ? null : folderRelativePath;
      if (normalizedFolderRelativePath) {
        const folder = ensureFolderCandidate(folders, root, normalizedFolderRelativePath);
        folder.fileCount++;
      }

      files.push({
        id: uuidv4(),
        rootId: root.id,
        folderRelativePath: normalizedFolderRelativePath,
        relativePath: entryRelativePath,
        absolutePath: entryPath,
        originalFilename: entry.name,
        displayTitle: path.basename(entry.name, path.extname(entry.name)),
        normalizedTitle: normalizeArabicForMatch(path.basename(entry.name, path.extname(entry.name))),
        safeSlug: generateSafeSlug(path.basename(entry.name, path.extname(entry.name))),
        extension: path.extname(entry.name).toLowerCase(),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mediaType: mediaTypeForRoot(root.root_key),
      });
    }
  };

  visit(rootRealPath, '', 0);

  return {
    exists: true,
    folders: Array.from(folders.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    files,
    skippedRecentlyModified,
    warnings,
  };
}

function persistProvisionalScan(
  root: MediaRootDefinition,
  folders: FolderCandidate[],
  files: FileCandidate[],
  provisional: boolean
): { foldersUpserted: number; filesUpserted: number } {
  const db = getDb();
  const folderIdByRelativePath = new Map<string, string>();

  const persist = db.transaction(() => {
    for (const folder of folders) {
      const existing = db.prepare(`
        SELECT id FROM media_folders WHERE root_id=? AND original_relative_path=?
      `).get(root.id, folder.relativePath) as { id: string } | undefined;
      const folderId = existing?.id ?? folder.id;
      folderIdByRelativePath.set(folder.relativePath, folderId);
      const parentId = folder.parentRelativePath ? folderIdByRelativePath.get(folder.parentRelativePath) ?? null : null;

      db.prepare(`
        INSERT INTO media_folders
          (id, root_id, original_relative_path, display_name_ar, normalized_name, safe_slug,
           parent_folder_id, file_count, total_duration_ms, longest_file_duration_ms, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(root_id, original_relative_path) DO UPDATE SET
          display_name_ar=excluded.display_name_ar,
          normalized_name=excluded.normalized_name,
          safe_slug=excluded.safe_slug,
          parent_folder_id=excluded.parent_folder_id,
          file_count=excluded.file_count,
          total_duration_ms=excluded.total_duration_ms,
          longest_file_duration_ms=excluded.longest_file_duration_ms,
          status=excluded.status,
          updated_at=datetime('now')
      `).run(
        folderId,
        root.id,
        folder.relativePath,
        folder.displayName,
        folder.normalizedName,
        folder.safeSlug,
        parentId,
        folder.fileCount,
        folder.totalDurationMs,
        folder.longestFileDurationMs,
        provisional ? 'provisional' : 'indexed'
      );
    }

    for (const file of files) {
      const folderId = file.folderRelativePath ? folderIdByRelativePath.get(file.folderRelativePath) ?? null : null;
      db.prepare(`
        INSERT INTO media_files
          (id, path, relative_path, filename, type, status, file_size, modified_at,
           root_id, folder_id, original_relative_path, original_filename, display_title_ar,
           normalized_title, safe_slug, extension, size_bytes, qc_status, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(path) DO UPDATE SET
          relative_path=excluded.relative_path,
          filename=excluded.filename,
          type=excluded.type,
          file_size=excluded.file_size,
          modified_at=excluded.modified_at,
          root_id=excluded.root_id,
          folder_id=excluded.folder_id,
          original_relative_path=excluded.original_relative_path,
          original_filename=excluded.original_filename,
          display_title_ar=excluded.display_title_ar,
          normalized_title=excluded.normalized_title,
          safe_slug=excluded.safe_slug,
          extension=excluded.extension,
          size_bytes=excluded.size_bytes,
          qc_status=excluded.qc_status,
          updated_at=datetime('now')
      `).run(
        file.id,
        file.absolutePath,
        file.relativePath,
        file.originalFilename,
        file.mediaType,
        file.sizeBytes,
        file.modifiedAt,
        root.id,
        folderId,
        file.relativePath,
        file.originalFilename,
        file.displayTitle,
        file.normalizedTitle,
        file.safeSlug,
        file.extension,
        file.sizeBytes,
        provisional ? 'provisional' : 'indexed'
      );
    }
  });

  persist();
  return { foldersUpserted: folders.length, filesUpserted: files.length };
}

function ensureFolderCandidate(
  folders: Map<string, FolderCandidate>,
  root: MediaRootDefinition,
  relativePath: string
): FolderCandidate {
  const normalizedRelativePath = toPosixPath(relativePath);
  const existing = folders.get(normalizedRelativePath);
  if (existing) return existing;

  const parentRelativePath = parentPathFor(normalizedRelativePath);
  if (parentRelativePath) {
    ensureFolderCandidate(folders, root, parentRelativePath);
  }

  const displayName = path.posix.basename(normalizedRelativePath);
  const folder: FolderCandidate = {
    id: uuidv4(),
    rootId: root.id,
    relativePath: normalizedRelativePath,
    displayName,
    normalizedName: normalizeArabicForMatch(displayName),
    safeSlug: generateSafeSlug(displayName),
    parentRelativePath,
    fileCount: 0,
    totalDurationMs: null,
    longestFileDurationMs: null,
  };
  folders.set(normalizedRelativePath, folder);
  return folder;
}

function parentPathFor(relativePath: string): string | null {
  const parent = path.posix.dirname(relativePath);
  return parent === '.' || parent === relativePath ? null : parent;
}

function buildCandidate(folder: FolderRow, files: CandidateFileRow[], childFolderCount: number) {
  const episodeCount = files.length;
  const numberedCount = files.filter(file => hasEpisodeNumber(file.original_filename ?? file.filename)).length;
  const durations = files
    .map(file => file.duration_ms ?? (file.duration_sec ? Math.round(file.duration_sec * 1000) : null))
    .filter((duration): duration is number => typeof duration === 'number' && duration > 0);
  const averageDurationMs = durations.length > 0
    ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
    : null;

  const playMode =
    childFolderCount > 1 ? 'round_robin' :
    numberedCount >= Math.max(2, Math.ceil(episodeCount * 0.6)) ? 'sequential' :
    'newest';

  const slotMode =
    averageDurationMs !== null && averageDurationMs < 10 * 60_000 && episodeCount >= 3
      ? 'playlist'
      : 'fit';

  const needsReview = episodeCount <= 2 || (numberedCount === 0 && childFolderCount === 0);
  const confidence = Math.min(0.95, Math.max(0.2,
    0.35 +
    (numberedCount > 0 ? 0.25 : 0) +
    (episodeCount >= 5 ? 0.2 : 0) +
    (childFolderCount > 1 ? 0.15 : 0) -
    (needsReview ? 0.2 : 0)
  ));

  return {
    folder_id: folder.id,
    suggested_program_key: folder.safe_slug,
    display_name_ar: folder.display_name_ar,
    safe_slug: folder.safe_slug,
    episode_count: episodeCount,
    child_folder_count: childFolderCount,
    play_mode_suggestion: playMode,
    slot_mode_suggestion: slotMode,
    confidence_score: Number(confidence.toFixed(2)),
    needs_review: needsReview,
  };
}

function hasEpisodeNumber(filename: string): boolean {
  return (
    /^\s*\d{1,4}([\s._-]|$)/.test(filename) ||
    /(?:episode|ep|الحلقة|حلقة)\s*\d{1,4}/i.test(filename) ||
    /(?:^|[\s._-])\d{1,4}(?:[\s._-]|$)/.test(filename)
  );
}

function mediaTypeForRoot(rootKey: string): FileCandidate['mediaType'] {
  if (rootKey === 'bumpers') return 'filler';
  if (rootKey === 'emergency') return 'emergency';
  if (rootKey === 'original-ar' || rootKey === 'source') return 'program';
  return 'other';
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function resolveFolderHint(rootKey: string, folderHint: string) {
  return resolveRootRelativePath(findMediaRootByKey(rootKey), folderHint);
}
