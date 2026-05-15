import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.mxf', '.webm', '.ts']);
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ALLOWED_UPLOAD_MIMES = new Set([
  'video/mp4', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo',
  'video/webm', 'video/mp2t',
  'image/png', 'image/jpeg', 'image/webp',
  'application/json', 'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export function isVideoFile(filePath: string): boolean {
  return ALLOWED_VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
}

export function isImageFile(filePath: string): boolean {
  return ALLOWED_IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

export function isSafeUploadMime(mime: string): boolean {
  return ALLOWED_UPLOAD_MIMES.has(mime.toLowerCase().split(';')[0] ?? '');
}

export function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^\w\s.\-]/g, '_');
}

export function preventPathTraversal(baseDir: string, userPath: string): string {
  const resolved = path.resolve(baseDir, userPath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  return resolved;
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function fileHash(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex').slice(0, 16);
}

export function walkDir(dir: string, filter?: (f: string) => boolean): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, filter));
    } else if (!filter || filter(full)) {
      results.push(full);
    }
  }
  return results;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function diskUsage(dirPath: string): { used: number; total: number; percent: number } {
  try {
    const stat = fs.statfsSync(dirPath);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    const used = total - free;
    return { used, total, percent: Math.round((used / total) * 100) };
  } catch {
    return { used: 0, total: 0, percent: 0 };
  }
}
