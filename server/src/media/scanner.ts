import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import { probeFile } from './ffprobe';
import { config } from '../config';
import { logger } from '../utils/logger';
import { walkDir, isVideoFile } from '../utils/fileUtils';
import { broadcastWs } from '../ws';

export type MediaType = 'program' | 'filler' | 'emergency' | 'promo' | 'quran' | 'logo' | 'other';
export type MediaStatus = 'ready' | 'needs_transcode' | 'missing' | 'invalid' | 'duplicate' | 'unsupported' | 'pending';

export interface ScanProgress {
  total: number;
  scanned: number;
  errors: number;
  currentFile: string;
  phase: 'scanning' | 'marking_missing' | 'done';
}

export interface ScanResult {
  scanned: number;
  updated: number;
  errors: number;
  deleted: number;
  duration_ms: number;
}

const BROADCAST_PROFILE = {
  video_codec: 'h264',
  pixel_format: 'yuv420p',
  audio_codec: 'aac',
  fps: config.broadcast.fps,
  audio_rate: config.broadcast.audioRate,
};

function getMediaTypeFromPath(filePath: string, baseDir: string): MediaType {
  const rel = path.relative(baseDir, filePath).toLowerCase();
  if (rel.startsWith('programs') || rel.startsWith('program')) return 'program';
  if (rel.startsWith('filler') || rel.startsWith('fillers')) return 'filler';
  if (rel.startsWith('emergency')) return 'emergency';
  if (rel.startsWith('promo') || rel.startsWith('promos')) return 'promo';
  if (rel.startsWith('quran')) return 'quran';
  if (rel.startsWith('logo')) return 'logo';
  return 'other';
}

function assignStatus(probe: Awaited<ReturnType<typeof probeFile>>): MediaStatus {
  if (!probe.video_codec || !probe.audio_codec) return 'unsupported';

  const videoOk = probe.video_codec.toLowerCase().includes('h264');
  const audioOk = probe.audio_codec.toLowerCase().includes('aac');
  const pixOk = probe.pixel_format === BROADCAST_PROFILE.pixel_format;
  const fpsOk = probe.fps !== null && Math.abs(probe.fps - BROADCAST_PROFILE.fps) < 1;
  const audioRateOk = probe.audio_rate === BROADCAST_PROFILE.audio_rate;

  if (videoOk && audioOk && pixOk && fpsOk && audioRateOk) return 'ready';
  return 'needs_transcode';
}

async function scanDirectory(
  baseDir: string,
  forceType: MediaType | null,
  scannedPaths: Set<string>,
  onProgress?: (p: ScanProgress) => void
): Promise<{ scanned: number; updated: number; errors: number }> {
  const db = getDb();
  const allFiles = walkDir(baseDir, isVideoFile);
  const total = allFiles.length;
  let scanned = 0;
  let updated = 0;
  let errors = 0;

  for (const filePath of allFiles) {
    scanned++;
    onProgress?.({ total, scanned, errors, currentFile: path.basename(filePath), phase: 'scanning' });
    broadcastWs({ type: 'scan_progress', data: { total, scanned, errors, currentFile: path.basename(filePath) } });

    try {
      const stat = fs.statSync(filePath);
      const existing = db.prepare('SELECT id, modified_at, file_size FROM media_files WHERE path = ?').get(filePath) as
        { id: string; modified_at: string; file_size: number } | undefined;

      const modifiedAt = stat.mtime.toISOString();
      const fileSize = stat.size;

      if (existing && existing.modified_at === modifiedAt && existing.file_size === fileSize) {
        scannedPaths.add(filePath);
        continue;
      }

      const probe = await probeFile(filePath);
      const status = assignStatus(probe);
      const mediaType = forceType ?? getMediaTypeFromPath(filePath, baseDir);
      const filename = path.basename(filePath);
      const relPath = path.relative(baseDir, filePath);

      if (existing) {
        db.prepare(`
          UPDATE media_files SET
            relative_path=?, filename=?, type=?, status=?,
            duration_sec=?, file_size=?, modified_at=?, width=?, height=?,
            fps=?, video_codec=?, audio_codec=?, pixel_format=?, bitrate=?,
            audio_rate=?, scanned_at=?, probe_error=NULL
          WHERE path=?
        `).run(
          relPath, filename, mediaType, status,
          probe.duration_sec, fileSize, modifiedAt, probe.width, probe.height,
          probe.fps, probe.video_codec, probe.audio_codec, probe.pixel_format, probe.bitrate,
          probe.audio_rate, new Date().toISOString(),
          filePath
        );
      } else {
        db.prepare(`
          INSERT INTO media_files
            (id, path, relative_path, filename, type, status, duration_sec, file_size, modified_at,
             width, height, fps, video_codec, audio_codec, pixel_format, bitrate, audio_rate, scanned_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          uuidv4(), filePath, relPath, filename, mediaType, status,
          probe.duration_sec, fileSize, modifiedAt, probe.width, probe.height,
          probe.fps, probe.video_codec, probe.audio_codec, probe.pixel_format, probe.bitrate,
          probe.audio_rate, new Date().toISOString()
        );
      }

      updated++;
      scannedPaths.add(filePath);
    } catch (err) {
      errors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Scan error for ${filePath}: ${errMsg}`);
      db.prepare(`UPDATE media_files SET status='invalid', probe_error=?, scanned_at=? WHERE path=?`)
        .run(errMsg, new Date().toISOString(), filePath);
      db.prepare(`INSERT INTO scan_errors (id, file_path, error_msg) VALUES (?,?,?)`)
        .run(uuidv4(), filePath, errMsg);
    }
  }

  return { scanned, updated, errors };
}

export async function scanMediaLibrary(
  onProgress?: (p: ScanProgress) => void
): Promise<ScanResult> {
  const db = getDb();
  const startTime = Date.now();
  const scannedPaths = new Set<string>();
  let totalScanned = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  // Scan main media library
  const mainDir = config.paths.mediaLibrary;
  if (fs.existsSync(mainDir)) {
    logger.info(`Scanning media library: ${mainDir}`);
    const r = await scanDirectory(mainDir, null, scannedPaths, onProgress);
    totalScanned += r.scanned;
    totalUpdated += r.updated;
    totalErrors += r.errors;
  } else {
    logger.warn(`Media library path does not exist: ${mainDir}`);
  }

  // Scan emergency media directory — always tagged as type='emergency'
  const emergencyDir = config.paths.mediaEmergency;
  if (fs.existsSync(emergencyDir)) {
    logger.info(`Scanning emergency media: ${emergencyDir}`);
    const r = await scanDirectory(emergencyDir, 'emergency', scannedPaths, onProgress);
    totalScanned += r.scanned;
    totalUpdated += r.updated;
    totalErrors += r.errors;
  } else {
    logger.warn(`Emergency media path does not exist: ${emergencyDir}`);
  }

  // Mark files not seen in this scan as missing (only for known root paths)
  onProgress?.({ total: totalScanned, scanned: totalScanned, errors: totalErrors, currentFile: '', phase: 'marking_missing' });
  const knownRoots = [mainDir, emergencyDir];
  const allDbPaths = (db.prepare('SELECT path FROM media_files WHERE status != ?').all('missing') as { path: string }[]).map(r => r.path);
  let deleted = 0;
  for (const dbPath of allDbPaths) {
    const underKnownRoot = knownRoots.some(root => dbPath.startsWith(root));
    if (underKnownRoot && !scannedPaths.has(dbPath)) {
      db.prepare('UPDATE media_files SET status=? WHERE path=?').run('missing', dbPath);
      deleted++;
    }
  }

  const duration_ms = Date.now() - startTime;
  onProgress?.({ total: totalScanned, scanned: totalScanned, errors: totalErrors, currentFile: '', phase: 'done' });
  broadcastWs({ type: 'scan_progress', data: { total: totalScanned, scanned: totalScanned, errors: totalErrors, currentFile: '', phase: 'done' } });

  logger.info(`Scan complete: ${totalScanned} scanned, ${totalUpdated} updated, ${totalErrors} errors, ${deleted} missing. ${duration_ms}ms`);
  return { scanned: totalScanned, updated: totalUpdated, errors: totalErrors, deleted, duration_ms };
}

/** Returns true if at least one emergency media file is ready for broadcast. */
export function checkEmergencyReadiness(): { ok: boolean; count: number } {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM media_files WHERE type='emergency' AND status='ready'`).get() as { cnt: number };
  return { ok: row.cnt > 0, count: row.cnt };
}

export function getMediaStats() {
  const db = getDb();
  return db.prepare(`
    SELECT status, COUNT(*) as count, SUM(duration_sec) as total_duration, SUM(file_size) as total_size
    FROM media_files GROUP BY status
  `).all() as Array<{ status: string; count: number; total_duration: number; total_size: number }>;
}
