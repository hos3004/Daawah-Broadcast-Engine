import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

export type MediaBrowserEntryType = 'directory' | 'file';

export interface MediaBrowserStats {
  fileCount: number;
  mp4Count: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface MediaBrowserRoot extends MediaBrowserStats {
  id: string;
  label: string;
  path: string;
  relativePath: string;
  exists: boolean;
}

export interface MediaBrowserEntry extends MediaBrowserStats {
  name: string;
  type: MediaBrowserEntryType;
  fullPath: string;
  relativePath: string;
  extension: string | null;
  modifiedAt: string | null;
}

export interface MediaBrowserBreadcrumb {
  label: string;
  relativePath: string;
}

export interface MediaBrowserListResult {
  root: MediaBrowserRoot;
  current: {
    rootId: string;
    fullPath: string;
    relativePath: string;
    breadcrumbs: MediaBrowserBreadcrumb[];
  };
  entries: MediaBrowserEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface MediaBrowserOptions {
  basePath?: string;
  allowedRoots?: string[];
  statsFileLimit?: number;
  includeConfiguredRoots?: boolean;
}

export class MediaBrowserError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
  }
}

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const MP4_EXT = '.mp4';

const collator = new Intl.Collator('ar', {
  numeric: true,
  sensitivity: 'base',
});

function normalizeForSearch(value: string): string {
  return value
    .normalize('NFKC')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLocaleLowerCase('ar');
}

function isMp4(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === MP4_EXT;
}

function toDisplayRelative(basePath: string, targetPath: string): string {
  const rel = path.relative(basePath, targetPath);
  return rel === '' ? '' : rel.split(path.sep).join('/');
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function realpathIfExists(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return path.resolve(targetPath);
  return fs.realpathSync(targetPath);
}

function sanitizeRelativePath(input: string | undefined): string {
  if (!input) return '';
  if (input.includes('\0')) {
    throw new MediaBrowserError('Invalid path', 400);
  }

  const normalized = input.replace(/\\/g, '/');
  if (path.isAbsolute(input) || path.posix.isAbsolute(normalized)) {
    throw new MediaBrowserError('Absolute paths are not allowed', 400);
  }

  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.some(segment => segment === '..')) {
    throw new MediaBrowserError('Path traversal is not allowed', 400);
  }

  return path.join(...segments);
}

function collectRootSpecs(options?: MediaBrowserOptions): string[] {
  const specs = [...(options?.allowedRoots ?? config.mediaBrowser.allowedRoots)];
  const includeConfiguredRoots = options?.includeConfiguredRoots ?? true;

  if (includeConfiguredRoots) {
    specs.push(
      config.paths.mediaLibrary,
      config.paths.mediaEmergency,
      config.gapFiller.mainStingPath,
      config.gapFiller.seasonalStingPath,
      config.gapFiller.generalBumpersPath
    );
  }

  return specs;
}

function makeRootId(relativePath: string, usedIds: Set<string>): string {
  const base = (relativePath || 'media')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\/+/g, ':')
    .replace(/^:+|:+$/g, '') || 'media';

  let id = base;
  let index = 2;
  while (usedIds.has(id)) {
    id = `${base}-${index}`;
    index++;
  }
  usedIds.add(id);
  return id;
}

function collectDirectoryStats(dirPath: string, rootPath: string, fileLimit: number): MediaBrowserStats {
  const stats: MediaBrowserStats = { fileCount: 0, mp4Count: 0, sizeBytes: 0, truncated: false };
  const stack = [dirPath];
  const visitedDirs = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (visitedDirs.has(current)) continue;
    visitedDirs.add(current);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      logger.warn(`Media browser could not read ${current}: ${String(err)}`);
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      let realPath: string;
      let stat: fs.Stats;
      try {
        realPath = fs.realpathSync(entryPath);
        if (!isPathInside(realPath, rootPath)) continue;
        stat = fs.statSync(realPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!visitedDirs.has(realPath)) stack.push(realPath);
        continue;
      }

      if (!stat.isFile()) continue;

      stats.fileCount++;
      if (isMp4(realPath)) stats.mp4Count++;
      stats.sizeBytes += stat.size;

      if (stats.fileCount >= fileLimit) {
        stats.truncated = true;
        return stats;
      }
    }
  }

  return stats;
}

export function getMediaBrowserRoots(options?: MediaBrowserOptions & { includeStats?: boolean }): MediaBrowserRoot[] {
  const basePath = path.resolve(options?.basePath ?? config.mediaBrowser.basePath);
  const baseRealPath = realpathIfExists(basePath);
  const fileLimit = options?.statsFileLimit ?? config.mediaBrowser.statsFileLimit;
  const includeStats = options?.includeStats ?? true;
  const usedIds = new Set<string>();
  const usedPaths = new Set<string>();
  const roots: MediaBrowserRoot[] = [];

  for (const spec of collectRootSpecs(options)) {
    const rootPath = path.resolve(path.isAbsolute(spec) ? spec : path.join(basePath, spec));
    const rootRealPath = realpathIfExists(rootPath);

    if (!isPathInside(rootRealPath, baseRealPath)) {
      logger.warn(`Media browser root ignored because it is outside ${baseRealPath}: ${rootPath}`);
      continue;
    }

    if (usedPaths.has(rootRealPath)) continue;
    usedPaths.add(rootRealPath);

    const relativePath = toDisplayRelative(baseRealPath, rootRealPath);
    const label = relativePath || path.basename(baseRealPath) || baseRealPath;
    const exists = fs.existsSync(rootRealPath);
    const dirStats = exists && includeStats
      ? collectDirectoryStats(rootRealPath, rootRealPath, fileLimit)
      : { fileCount: 0, mp4Count: 0, sizeBytes: 0, truncated: false };

    roots.push({
      id: makeRootId(relativePath, usedIds),
      label,
      path: rootRealPath,
      relativePath,
      exists,
      ...dirStats,
    });
  }

  return roots.sort((a, b) => collator.compare(a.label, b.label));
}

export function resolveMediaBrowserPath(
  rootId: string,
  relativePath?: string,
  options?: MediaBrowserOptions
): { root: MediaBrowserRoot; fullPath: string; relativePath: string } {
  const roots = getMediaBrowserRoots({ ...options, includeStats: false });
  const root = roots.find(item => item.id === rootId);
  if (!root) {
    throw new MediaBrowserError('Unknown media browser root', 404);
  }
  if (!root.exists) {
    throw new MediaBrowserError('Media browser root does not exist', 404);
  }

  const safeRelativePath = sanitizeRelativePath(relativePath);
  const requestedPath = path.resolve(root.path, safeRelativePath);
  if (!fs.existsSync(requestedPath)) {
    throw new MediaBrowserError('Path not found', 404);
  }

  const realPath = fs.realpathSync(requestedPath);
  if (!isPathInside(realPath, root.path)) {
    throw new MediaBrowserError('Path escapes the allowed root', 403);
  }

  return {
    root,
    fullPath: realPath,
    relativePath: toDisplayRelative(root.path, realPath),
  };
}

export function listMediaBrowserDirectory(args: {
  rootId: string;
  relativePath?: string;
  search?: string;
  mp4Only?: boolean;
  page?: number;
  limit?: number;
  options?: MediaBrowserOptions;
}): MediaBrowserListResult {
  const resolved = resolveMediaBrowserPath(args.rootId, args.relativePath, args.options);
  const stat = fs.statSync(resolved.fullPath);
  if (!stat.isDirectory()) {
    throw new MediaBrowserError('Path is not a directory', 400);
  }

  const page = toPositiveInt(args.page, 1, 1000000);
  const limit = toPositiveInt(args.limit, 100, 500);
  const searchTerm = normalizeForSearch(args.search ?? '');
  const fileLimit = args.options?.statsFileLimit ?? config.mediaBrowser.statsFileLimit;

  const entries = fs.readdirSync(resolved.fullPath, { withFileTypes: true })
    .flatMap<MediaBrowserEntry>((entry) => {
      const requestedEntryPath = path.join(resolved.fullPath, entry.name);
      let realPath: string;
      let entryStat: fs.Stats;

      try {
        realPath = fs.realpathSync(requestedEntryPath);
        if (!isPathInside(realPath, resolved.root.path)) return [];
        entryStat = fs.statSync(realPath);
      } catch {
        return [];
      }

      const isDirectory = entryStat.isDirectory();
      const isFile = entryStat.isFile();
      if (!isDirectory && !isFile) return [];
      if (searchTerm && !normalizeForSearch(entry.name).includes(searchTerm)) return [];
      if (args.mp4Only && isFile && !isMp4(realPath)) return [];

      const dirStats = isDirectory
        ? collectDirectoryStats(realPath, resolved.root.path, fileLimit)
        : {
            fileCount: 1,
            mp4Count: isMp4(realPath) ? 1 : 0,
            sizeBytes: entryStat.size,
            truncated: false,
          };

      return [{
        name: entry.name,
        type: isDirectory ? 'directory' : 'file',
        fullPath: realPath,
        relativePath: toDisplayRelative(resolved.root.path, realPath),
        extension: isFile ? path.extname(entry.name).toLowerCase() : null,
        modifiedAt: entryStat.mtime.toISOString(),
        ...dirStats,
      }];
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return collator.compare(a.name, b.name);
    });

  const start = (page - 1) * limit;
  const breadcrumbs = buildBreadcrumbs(resolved.relativePath);

  return {
    root: resolved.root,
    current: {
      rootId: resolved.root.id,
      fullPath: resolved.fullPath,
      relativePath: resolved.relativePath,
      breadcrumbs,
    },
    entries: entries.slice(start, start + limit),
    total: entries.length,
    page,
    limit,
  };
}

function buildBreadcrumbs(relativePath: string): MediaBrowserBreadcrumb[] {
  if (!relativePath) return [];
  const parts = relativePath.split('/').filter(Boolean);
  const breadcrumbs: MediaBrowserBreadcrumb[] = [];

  for (let index = 0; index < parts.length; index++) {
    const label = parts[index];
    if (!label) continue;
    breadcrumbs.push({
      label,
      relativePath: parts.slice(0, index + 1).join('/'),
    });
  }

  return breadcrumbs;
}

function toPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}
