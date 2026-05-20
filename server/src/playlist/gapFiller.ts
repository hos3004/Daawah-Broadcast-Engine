import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getDb } from '../db/schema';
import { logger } from '../utils/logger';
import type { PlaylistItem } from './builder';

type Db = ReturnType<typeof getDb>;

export type GapPatternRole = 'main' | 'seasonal' | 'general';
export type SourceRole = 'program' | 'main_sting' | 'seasonal_sting' | 'general_bumper' | 'filler' | 'emergency';

interface MediaFile {
  id: string;
  path: string;
  filename: string;
  type: string;
  duration_sec: number | null;
  program_id: string | null;
}

interface CursorState {
  cursor_key: string;
  role: string;
  folder_key: string | null;
  last_media_file_id: string | null;
  last_played_path: string | null;
}

interface GapFillerConfig {
  mainStingPath: string;
  seasonalStingPath: string;
  generalBumpersPath: string;
  pattern: GapPatternRole[];
}

interface GeneralBucket {
  folderKey: string;
  sortKey: string;
  items: MediaFile[];
}

interface ProfessionalCatalog {
  main: MediaFile[];
  seasonal: MediaFile[];
  generalBuckets: GeneralBucket[];
}

interface BuildProfessionalGapFillItemsArgs {
  startMs: number;
  endMs: number;
  db: Db;
  startPosition: number;
}

const DEFAULT_DURATION_MS = 60_000;
const warnedMissingFolders = new Set<string>();
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function loadGapFillerConfig(): GapFillerConfig {
  return {
    mainStingPath: config.gapFiller.mainStingPath,
    seasonalStingPath: config.gapFiller.seasonalStingPath,
    generalBumpersPath: config.gapFiller.generalBumpersPath,
    pattern: buildPatternCycle(config.gapFiller.pattern),
  };
}

export function buildPatternCycle(pattern = 'main,seasonal,general,general,general'): GapPatternRole[] {
  const roles: GapPatternRole[] = [];
  for (const rawRole of pattern.split(',')) {
    const role = rawRole.trim().toLowerCase();
    if (role === 'main' || role === 'seasonal' || role === 'general') {
      roles.push(role);
    } else if (role) {
      logger.warn(`Ignoring unknown gap filler pattern role: ${rawRole}`);
    }
  }
  return roles.length > 0 ? roles : ['main', 'seasonal', 'general', 'general', 'general'];
}

export function fillGapWithProfessionalBumpers(
  startMs: number,
  endMs: number,
  db: Db,
  startPosition: number
): PlaylistItem[] {
  return buildProfessionalGapFillItems({ startMs, endMs, db, startPosition });
}

export function buildProfessionalGapFillItems(args: BuildProfessionalGapFillItemsArgs): PlaylistItem[] {
  const { startMs, endMs, db, startPosition } = args;
  if (endMs <= startMs) return [];

  const gapConfig = loadGapFillerConfig();
  const catalog = loadProfessionalCatalog(db, gapConfig);
  if (!hasAnyProfessionalBumpers(catalog)) {
    return [];
  }

  const items: PlaylistItem[] = [];
  let currentMs = startMs;
  let position = startPosition;
  let patternIndex = 0;
  let skippedSlots = 0;
  const maxItems = Math.max(10, Math.ceil((endMs - startMs) / 1_000));

  while (currentMs < endMs && items.length < maxItems) {
    const role = gapConfig.pattern[patternIndex % gapConfig.pattern.length];
    patternIndex++;
    if (!role) break;

    const selected = selectNextForRole(role, catalog, db);
    if (!selected) {
      skippedSlots++;
      if (skippedSlots >= gapConfig.pattern.length && !hasAnyProfessionalBumpers(catalog)) break;
      continue;
    }

    skippedSlots = 0;
    const originalDurationMs = selected.duration_sec && selected.duration_sec > 0
      ? Math.round(selected.duration_sec * 1000)
      : DEFAULT_DURATION_MS;
    const remainingMs = endMs - currentMs;
    const forcedDurationMs = Math.min(originalDurationMs, remainingMs);
    if (forcedDurationMs <= 0) break;

    const isTrimmed = originalDurationMs > remainingMs;
    const sourceRole = sourceRoleForPatternRole(role);

    items.push({
      id: uuidv4(),
      position: position++,
      start_time_ms: currentMs,
      end_time_ms: currentMs + forcedDurationMs,
      type: 'filler',
      program_id: null,
      media_file_id: selected.id,
      media_path: selected.path,
      title: titleForSourceRole(sourceRole, selected),
      title_ar: null,
      duration_ms: forcedDurationMs,
      show_lower_third: false,
      lower_third_path: null,
      is_emergency: false,
      source_role: sourceRole,
      is_trimmed: isTrimmed,
      trim_out_ms: isTrimmed ? forcedDurationMs : null,
      forced_duration_ms: isTrimmed ? forcedDurationMs : null,
    });

    currentMs += forcedDurationMs;
  }

  if (items.length >= maxItems && currentMs < endMs) {
    logger.warn(`Professional gap filler reached safety limit after ${items.length} item(s)`);
  }

  return items;
}

function loadProfessionalCatalog(db: Db, gapConfig: GapFillerConfig): ProfessionalCatalog {
  return {
    main: getReadyBumpersForRole('main', db, gapConfig),
    seasonal: getReadyBumpersForRole('seasonal', db, gapConfig),
    generalBuckets: getGeneralBumpersGroupedByFolder(db, gapConfig),
  };
}

export function getReadyBumpersForRole(
  role: 'main' | 'seasonal',
  db: Db,
  gapConfig = loadGapFillerConfig()
): MediaFile[] {
  const folder = role === 'main' ? gapConfig.mainStingPath : gapConfig.seasonalStingPath;
  if (!folderExists(folder, role)) return [];

  return queryReadyFillerFiles(db)
    .filter(file => isPathInside(file.path, folder))
    .sort(compareMediaFiles);
}

export function getGeneralBumpersGroupedByFolder(
  db: Db,
  gapConfig = loadGapFillerConfig()
): GeneralBucket[] {
  const root = gapConfig.generalBumpersPath;
  if (!folderExists(root, 'general')) return [];

  const grouped = new Map<string, { sortKey: string; items: MediaFile[] }>();
  for (const file of queryReadyFillerFiles(db).filter(row => isPathInside(row.path, root))) {
    const relativePath = path.relative(path.resolve(root), path.resolve(file.path));
    const firstSegment = relativePath.split(/[\\/]/).filter(Boolean)[0];
    const isRootFile = !firstSegment || firstSegment === path.basename(file.path);
    const folderKey = isRootFile ? '_root' : path.resolve(root, firstSegment);
    const sortKey = isRootFile ? '_root' : firstSegment.toLowerCase();

    if (!grouped.has(folderKey)) {
      grouped.set(folderKey, { sortKey, items: [] });
    }
    grouped.get(folderKey)!.items.push(file);
  }

  return [...grouped.entries()]
    .map(([folderKey, bucket]) => ({
      folderKey,
      sortKey: bucket.sortKey,
      items: bucket.items.sort(compareMediaFiles),
    }))
    .sort((a, b) => collator.compare(a.sortKey, b.sortKey));
}

export function getNextByCursor(
  cursorKey: string,
  candidates: MediaFile[],
  db: Db,
  role: SourceRole,
  folderKey: string | null = null
): MediaFile | null {
  if (candidates.length === 0) return null;

  const state = getCursor(cursorKey, db);
  let selectedIndex = 0;

  if (state) {
    const lastIndex = candidates.findIndex(candidate =>
      (state.last_media_file_id !== null && candidate.id === state.last_media_file_id) ||
      (state.last_played_path !== null && candidate.path === state.last_played_path)
    );

    if (lastIndex >= 0) {
      selectedIndex = (lastIndex + 1) % candidates.length;
    } else {
      logger.warn(`Gap filler cursor ${cursorKey} points to a missing file; restarting at first ready item`);
    }
  }

  const selected = candidates[selectedIndex];
  if (!selected) return null;

  updateCursor(cursorKey, selected, db, role, folderKey);
  return selected;
}

export function updateCursor(
  cursorKey: string,
  selectedItem: MediaFile,
  db: Db,
  role: SourceRole,
  folderKey: string | null = null
): void {
  db.prepare(`
    INSERT INTO bumper_cursor_state
      (id, cursor_key, role, folder_key, last_media_file_id, last_played_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cursor_key) DO UPDATE SET
      role=excluded.role,
      folder_key=excluded.folder_key,
      last_media_file_id=excluded.last_media_file_id,
      last_played_path=excluded.last_played_path,
      updated_at=datetime('now')
  `).run(uuidv4(), cursorKey, role, folderKey, selectedItem.id, selectedItem.path);
}

function selectNextForRole(role: GapPatternRole, catalog: ProfessionalCatalog, db: Db): MediaFile | null {
  if (role === 'main') {
    return getNextByCursor('gap:main', catalog.main, db, 'main_sting');
  }

  if (role === 'seasonal') {
    return getNextByCursor('gap:seasonal', catalog.seasonal, db, 'seasonal_sting');
  }

  return getNextGeneralBumper(catalog.generalBuckets, db);
}

function getNextGeneralBumper(buckets: GeneralBucket[], db: Db): MediaFile | null {
  if (buckets.length === 0) return null;

  const bucket = getNextGeneralBucket(buckets, db);
  if (!bucket) return null;

  const selected = getNextByCursor(
    `gap:general-folder:${bucket.folderKey}`,
    bucket.items,
    db,
    'general_bumper',
    bucket.folderKey
  );

  if (selected) {
    updateGeneralFolderCursor(bucket, db);
  }

  return selected;
}

function getNextGeneralBucket(buckets: GeneralBucket[], db: Db): GeneralBucket | null {
  const state = getCursor('gap:general-folder-index', db);
  let selectedIndex = 0;

  if (state?.last_played_path) {
    const lastIndex = buckets.findIndex(bucket => bucket.folderKey === state.last_played_path);
    selectedIndex = lastIndex >= 0 ? (lastIndex + 1) % buckets.length : 0;
  }

  return buckets[selectedIndex] ?? null;
}

function updateGeneralFolderCursor(bucket: GeneralBucket, db: Db): void {
  const cursorItem: MediaFile = {
    id: bucket.folderKey,
    path: bucket.folderKey,
    filename: bucket.folderKey,
    type: 'filler',
    duration_sec: null,
    program_id: null,
  };
  updateCursor('gap:general-folder-index', cursorItem, db, 'general_bumper', bucket.folderKey);
}

function getCursor(cursorKey: string, db: Db): CursorState | null {
  return db.prepare('SELECT * FROM bumper_cursor_state WHERE cursor_key=?')
    .get(cursorKey) as CursorState | null;
}

function queryReadyFillerFiles(db: Db): MediaFile[] {
  return db.prepare(`
    SELECT id, path, filename, type, duration_sec, program_id
    FROM media_files
    WHERE type=? AND status=?
  `).all('filler', 'ready') as MediaFile[];
}

function hasAnyProfessionalBumpers(catalog: ProfessionalCatalog): boolean {
  return catalog.main.length > 0 ||
    catalog.seasonal.length > 0 ||
    catalog.generalBuckets.some(bucket => bucket.items.length > 0);
}

function folderExists(folderPath: string, role: string): boolean {
  if (fs.existsSync(folderPath)) return true;

  const warningKey = `${role}:${folderPath}`;
  if (!warnedMissingFolders.has(warningKey)) {
    warnedMissingFolders.add(warningKey);
    logger.warn(`Gap filler ${role} folder does not exist: ${folderPath}`);
  }

  return false;
}

function sourceRoleForPatternRole(role: GapPatternRole): SourceRole {
  if (role === 'main') return 'main_sting';
  if (role === 'seasonal') return 'seasonal_sting';
  return 'general_bumper';
}

function titleForSourceRole(sourceRole: SourceRole, media: MediaFile): string {
  if (sourceRole === 'main_sting') return `Main Sting - ${media.filename}`;
  if (sourceRole === 'seasonal_sting') return `Seasonal Sting - ${media.filename}`;
  if (sourceRole === 'general_bumper') return `General Bumper - ${media.filename}`;
  return media.filename;
}

function compareMediaFiles(a: MediaFile, b: MediaFile): number {
  const aNumber = leadingNumber(a.filename);
  const bNumber = leadingNumber(b.filename);

  if (aNumber !== null && bNumber !== null && aNumber !== bNumber) {
    return aNumber - bNumber;
  }
  if (aNumber !== null && bNumber === null) return -1;
  if (aNumber === null && bNumber !== null) return 1;

  return collator.compare(a.filename, b.filename);
}

function leadingNumber(filename: string): number | null {
  const match = /^(\d+)/.exec(filename.trim());
  return match?.[1] ? Number(match[1]) : null;
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
