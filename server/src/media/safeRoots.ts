import fs from 'fs';
import path from 'path';
import { getDb } from '../db/schema';

export interface MediaRootDefinition {
  id: string;
  root_key: string;
  absolute_path: string;
  is_readonly: boolean;
  is_original_library: boolean;
}

interface MediaRootRow {
  id: string;
  root_key: string;
  absolute_path: string;
  is_readonly: number;
  is_original_library: number;
}

export const DEFAULT_MEDIA_ROOTS: MediaRootDefinition[] = [
  {
    id: 'root-original-ar',
    root_key: 'original-ar',
    absolute_path: '/srv/daawah/media/original-ar',
    is_readonly: true,
    is_original_library: true,
  },
  {
    id: 'root-source',
    root_key: 'source',
    absolute_path: '/srv/daawah/media/source',
    is_readonly: false,
    is_original_library: false,
  },
  {
    id: 'root-normalized-ar',
    root_key: 'normalized-ar',
    absolute_path: '/srv/daawah/media/normalized-ar',
    is_readonly: false,
    is_original_library: false,
  },
  {
    id: 'root-bumpers',
    root_key: 'bumpers',
    absolute_path: '/srv/daawah/media/bumpers',
    is_readonly: false,
    is_original_library: false,
  },
  {
    id: 'root-emergency',
    root_key: 'emergency',
    absolute_path: '/srv/daawah/media/emergency',
    is_readonly: false,
    is_original_library: false,
  },
];

export class SafeRootError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
  }
}

export function listMediaRoots(): MediaRootDefinition[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, root_key, absolute_path, is_readonly, is_original_library
    FROM media_roots
    ORDER BY root_key
  `).all() as MediaRootRow[];

  return rows.map(row => ({
    id: row.id,
    root_key: row.root_key,
    absolute_path: row.absolute_path,
    is_readonly: row.is_readonly === 1,
    is_original_library: row.is_original_library === 1,
  }));
}

export function findMediaRootByKey(rootKey: string): MediaRootDefinition {
  const root = listMediaRoots().find(item => item.root_key === rootKey);
  if (!root) {
    throw new SafeRootError(`Unknown media root: ${rootKey}`, 'UNKNOWN_ROOT');
  }
  return root;
}

export function upsertMediaRoot(root: MediaRootDefinition): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO media_roots
      (id, root_key, absolute_path, is_readonly, is_original_library)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(root_key) DO UPDATE SET
      absolute_path=excluded.absolute_path,
      is_readonly=excluded.is_readonly,
      is_original_library=excluded.is_original_library,
      updated_at=datetime('now')
  `).run(
    root.id,
    root.root_key,
    root.absolute_path,
    root.is_readonly ? 1 : 0,
    root.is_original_library ? 1 : 0
  );
}

export function normalizeRootRelativePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.includes('\0')) {
    throw new SafeRootError('Path contains a null byte', 'INVALID_PATH');
  }
  if (isAnyAbsolutePath(trimmed)) {
    throw new SafeRootError('Absolute paths are not allowed in imports', 'ABSOLUTE_PATH_REJECTED');
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const segments = normalized
    .split('/')
    .filter(segment => segment !== '' && segment !== '.');

  if (segments.some(segment => segment === '..')) {
    throw new SafeRootError('Path traversal is not allowed', 'PATH_TRAVERSAL_REJECTED');
  }
  if (segments.some(segment => /[<>:"|?*\u0000-\u001F]/.test(segment))) {
    throw new SafeRootError('Path contains unsupported characters', 'INVALID_PATH');
  }

  return segments.join('/');
}

export function resolveRootRelativePath(root: MediaRootDefinition, folderHint: string): {
  root: MediaRootDefinition;
  relativePath: string;
  absolutePath: string;
} {
  const relativePath = normalizeRootRelativePath(folderHint);
  const absolutePath = joinRootPath(root.absolute_path, relativePath);

  validatePathInsideRoot(root.absolute_path, absolutePath);

  return { root, relativePath, absolutePath };
}

export function isAnyAbsolutePath(input: string): boolean {
  return (
    path.isAbsolute(input) ||
    path.posix.isAbsolute(input.replace(/\\/g, '/')) ||
    /^[a-zA-Z]:[\\/]/.test(input)
  );
}

function joinRootPath(rootPath: string, relativePath: string): string {
  if (isPosixRoot(rootPath)) {
    return path.posix.normalize(path.posix.join(rootPath, relativePath.replace(/\\/g, '/')));
  }
  return path.resolve(rootPath, relativePath);
}

function validatePathInsideRoot(rootPath: string, targetPath: string): void {
  if (fs.existsSync(rootPath) && fs.existsSync(targetPath)) {
    const rootReal = fs.realpathSync(rootPath);
    const targetReal = fs.realpathSync(targetPath);
    if (!isPathInside(targetReal, rootReal)) {
      throw new SafeRootError('Resolved path escapes the configured root', 'PATH_ESCAPE_REJECTED');
    }
    return;
  }

  if (!isPathInside(targetPath, rootPath)) {
    throw new SafeRootError('Resolved path escapes the configured root', 'PATH_ESCAPE_REJECTED');
  }
}

function isPathInside(childPath: string, parentPath: string): boolean {
  if (isPosixRoot(parentPath)) {
    const relative = path.posix.relative(
      path.posix.normalize(parentPath),
      path.posix.normalize(childPath)
    );
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.posix.isAbsolute(relative));
  }

  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPosixRoot(value: string): boolean {
  return value.startsWith('/') && !/^[a-zA-Z]:/.test(value);
}
