import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import { getDb } from '../db/schema';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ensureDir } from '../utils/fileUtils';
import { fillGapWithProfessionalBumpers, type SourceRole } from './gapFiller';

export interface PlaylistItem {
  id: string;
  position: number;
  start_time_ms: number;
  end_time_ms: number;
  type: string;
  program_id: string | null;
  media_file_id: string;
  media_path: string;
  title: string;
  title_ar: string | null;
  duration_ms: number;
  show_lower_third: boolean;
  lower_third_path: string | null;
  is_emergency: boolean;
  source_role: SourceRole;
  is_trimmed: boolean;
  trim_out_ms: number | null;
  forced_duration_ms: number | null;
}

export interface DailyPlaylist {
  date: string;
  built_at: string;
  items: PlaylistItem[];
  current?: PlaylistItem;
  next?: PlaylistItem;
  lookahead: PlaylistItem[];
}

interface ScheduleItem {
  id: string;
  date: string;
  start_time: string;
  type: string;
  program_id: string | null;
  episode_id: string | null;
  media_file_id: string | null;
  title: string;
  expected_duration: number | null;
  duration_policy: string;
}

interface MediaFile {
  id: string;
  path: string;
  type: string;
  duration_sec: number | null;
  program_id: string | null;
}

export async function buildDailyPlaylist(date: string): Promise<DailyPlaylist> {
  const db = getDb();
  const dateObj = dayjs(date);
  if (!dateObj.isValid()) throw new Error(`Invalid date: ${date}`);

  logger.info(`Building playlist for ${date}`);

  const activeSchedule = db.prepare(`
    SELECT id FROM schedules WHERE status='published' ORDER BY published_at DESC LIMIT 1
  `).get() as { id: string } | undefined;

  const items: PlaylistItem[] = [];
  let position = 0;

  if (activeSchedule) {
    const scheduleItems = db.prepare(`
      SELECT * FROM schedule_items WHERE schedule_id=? AND date=? ORDER BY start_time, sort_order
    `).all(activeSchedule.id, date) as ScheduleItem[];

    for (const si of scheduleItems) {
      const mediaFile = resolveMediaFile(si, db);
      if (!mediaFile) {
        logger.warn(`No media file for schedule item "${si.title}" on ${date} — using emergency`);
        const emergency = getEmergencyFile(db);
        if (emergency) {
          items.push(makeItem(position++, si, emergency, true, date));
        }
        continue;
      }
      items.push(makeItem(position++, si, mediaFile, false, date));
    }
  }

  // Fill any gaps with professional bumpers, falling back to emergency/filler.
  items.push(...fillGaps(items, date, db, position));

  // Sort final list by start_time_ms
  items.sort((a, b) => a.start_time_ms - b.start_time_ms);
  items.forEach((item, idx) => { item.position = idx; });

  // Persist
  const playlistId = uuidv4();
  const persist = db.transaction(() => {
    db.prepare('DELETE FROM daily_playlists WHERE date=?').run(date);
    db.prepare(`
      INSERT INTO daily_playlists (id, date, status, schedule_id, built_at)
      VALUES (?, ?, 'ready', ?, datetime('now'))
    `).run(playlistId, date, activeSchedule?.id ?? null);

    const stmt = db.prepare(`
      INSERT INTO playlist_items
        (id, playlist_id, position, start_time_ms, end_time_ms, type, program_id,
         media_file_id, title, title_ar, duration_ms, show_lower_third, lower_third_path,
         is_emergency, source_role, is_trimmed, trim_out_ms, forced_duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const item of items) {
      stmt.run(
        item.id, playlistId, item.position, item.start_time_ms, item.end_time_ms,
        item.type, item.program_id, item.media_file_id, item.title, item.title_ar,
        item.duration_ms, item.show_lower_third ? 1 : 0, item.lower_third_path,
        item.is_emergency ? 1 : 0, item.source_role, item.is_trimmed ? 1 : 0,
        item.trim_out_ms, item.forced_duration_ms
      );
    }
  });

  persist();

  // Write JSON file
  const playlist: DailyPlaylist = {
    date,
    built_at: new Date().toISOString(),
    items,
    lookahead: items.slice(0, config.playlist.lookahead),
  };

  ensureDir(config.paths.playlists);
  const filePath = path.join(config.paths.playlists, `${date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(playlist, null, 2), 'utf-8');

  logger.info(`Playlist for ${date} built with ${items.length} items → ${filePath}`);
  return playlist;
}

function resolveMediaFile(si: ScheduleItem, db: ReturnType<typeof getDb>): MediaFile | null {
  if (si.media_file_id) {
    return db.prepare('SELECT * FROM media_files WHERE id=? AND status=?')
      .get(si.media_file_id, 'ready') as MediaFile | null;
  }
  if (si.episode_id) {
    const ep = db.prepare('SELECT media_file_id FROM episodes WHERE id=?').get(si.episode_id) as { media_file_id: string | null } | null;
    if (ep?.media_file_id) {
      return db.prepare('SELECT * FROM media_files WHERE id=? AND status=?')
        .get(ep.media_file_id, 'ready') as MediaFile | null;
    }
  }
  if (si.program_id) {
    return db.prepare('SELECT * FROM media_files WHERE program_id=? AND status=? ORDER BY filename LIMIT 1')
      .get(si.program_id, 'ready') as MediaFile | null;
  }
  return null;
}

function getEmergencyFile(db: ReturnType<typeof getDb>): MediaFile | null {
  return db.prepare('SELECT * FROM media_files WHERE type=? AND status=? ORDER BY RANDOM() LIMIT 1')
    .get('emergency', 'ready') as MediaFile | null;
}

function makeItem(
  position: number,
  si: ScheduleItem,
  media: MediaFile,
  isEmergency: boolean,
  date: string
): PlaylistItem {
  const [h, m] = si.start_time.split(':').map(Number);
  const dayStart = dayjs(date).startOf('day').valueOf();
  const startMs = dayStart + (h ?? 0) * 3600000 + (m ?? 0) * 60000;
  const durationMs = media.duration_sec ? Math.round(media.duration_sec * 1000) : (si.expected_duration ? si.expected_duration * 1000 : 0);

  return {
    id: uuidv4(),
    position,
    start_time_ms: startMs,
    end_time_ms: startMs + durationMs,
    type: si.type,
    program_id: si.program_id,
    media_file_id: media.id,
    media_path: media.path,
    title: si.title,
    title_ar: si.title,
    duration_ms: durationMs,
    show_lower_third: si.type === 'program',
    lower_third_path: null,
    is_emergency: isEmergency,
    source_role: sourceRoleForScheduleItem(si, isEmergency),
    is_trimmed: false,
    trim_out_ms: null,
    forced_duration_ms: null,
  };
}

function sourceRoleForScheduleItem(si: ScheduleItem, isEmergency: boolean): SourceRole {
  if (isEmergency) return 'emergency';
  if (si.type === 'program') return 'program';
  return 'filler';
}

function fillGaps(
  items: PlaylistItem[],
  date: string,
  db: ReturnType<typeof getDb>,
  startPosition: number
): PlaylistItem[] {
  if (items.length === 0) {
    return buildEmergencyLoop(date, db, startPosition);
  }

  const fillers: PlaylistItem[] = [];
  let pos = startPosition;

  // Check gap at start of day
  const dayStart = dayjs(date).startOf('day').valueOf();
  const firstStart = items[0]?.start_time_ms ?? dayStart;
  if (firstStart - dayStart >= config.gapFiller.minFillMs) {
    const gap = fillRange(dayStart, firstStart, date, db, pos);
    fillers.push(...gap);
    pos += fillers.length;
  }

  // Check mid-day gaps
  for (let i = 0; i < items.length - 1; i++) {
    const gapStart = items[i]!.end_time_ms;
    const gapEnd = items[i + 1]!.start_time_ms;
    if (gapEnd - gapStart >= config.gapFiller.minFillMs) {
      const gap = fillRange(gapStart, gapEnd, date, db, pos);
      fillers.push(...gap);
      pos += gap.length;
    }
  }

  // Check gap at end of day
  const lastEnd = items[items.length - 1]?.end_time_ms ?? dayStart;
  const dayEnd = dayjs(date).endOf('day').valueOf();
  if (dayEnd - lastEnd >= config.gapFiller.minFillMs) {
    const gap = fillRange(lastEnd, dayEnd, date, db, pos);
    fillers.push(...gap);
  }

  return fillers;
}

function fillRange(
  startMs: number,
  endMs: number,
  date: string,
  db: ReturnType<typeof getDb>,
  startPos: number
): PlaylistItem[] {
  const professionalItems = fillGapWithProfessionalBumpers(startMs, endMs, db, startPos);
  if (professionalItems.length > 0) return professionalItems;

  logger.warn(`Professional gap filler found no ready bumpers for ${date}; using fallback filler/emergency pool`);
  return fillRangeFallbackRandomEmergency(startMs, endMs, db, startPos);
}

function fillRangeFallbackRandomEmergency(
  startMs: number,
  endMs: number,
  db: ReturnType<typeof getDb>,
  startPos: number
): PlaylistItem[] {
  const fillers = db.prepare(`
    SELECT * FROM media_files WHERE type IN (?, ?) AND status=? ORDER BY RANDOM()
  `).all('filler', 'emergency', 'ready') as MediaFile[];

  return fillRangeFromFiles(startMs, endMs, fillers, startPos);
}

function fillRangeEmergencyFallback(
  startMs: number,
  endMs: number,
  db: ReturnType<typeof getDb>,
  startPos: number
): PlaylistItem[] {
  const emergency = db.prepare(`
    SELECT * FROM media_files WHERE type=? AND status=? ORDER BY RANDOM()
  `).all('emergency', 'ready') as MediaFile[];

  if (emergency.length > 0) {
    return fillRangeFromFiles(startMs, endMs, emergency, startPos);
  }

  logger.warn('No emergency media available for no-schedule loop; using fallback filler/emergency pool');
  return fillRangeFallbackRandomEmergency(startMs, endMs, db, startPos);
}

function fillRangeFromFiles(
  startMs: number,
  endMs: number,
  fillers: MediaFile[],
  startPos: number
): PlaylistItem[] {
  const items: PlaylistItem[] = [];
  let current = startMs;
  let pos = startPos;

  if (fillers.length === 0) return items;

  let idx = 0;
  const maxItems = Math.max(1, Math.ceil((endMs - startMs) / Math.max(config.gapFiller.minFillMs, 1)));
  while (current < endMs && idx < maxItems) {
    const filler = fillers[idx % fillers.length]!;
    const durMs = filler.duration_sec ? Math.round(filler.duration_sec * 1000) : 60000;
    const itemEnd = Math.min(current + durMs, endMs);

    items.push({
      id: uuidv4(),
      position: pos++,
      start_time_ms: current,
      end_time_ms: itemEnd,
      type: 'filler',
      program_id: null,
      media_file_id: filler.id,
      media_path: filler.path,
      title: 'Filler',
      title_ar: null,
      duration_ms: itemEnd - current,
      show_lower_third: false,
      lower_third_path: null,
      is_emergency: filler.type === 'emergency',
      source_role: filler.type === 'emergency' ? 'emergency' : 'filler',
      is_trimmed: durMs > endMs - current,
      trim_out_ms: durMs > endMs - current ? itemEnd - current : null,
      forced_duration_ms: durMs > endMs - current ? itemEnd - current : null,
    });

    current = itemEnd;
    idx++;
  }

  if (idx >= maxItems && current < endMs) {
    logger.warn(`Fallback gap filler reached safety limit after ${idx} item(s)`);
  }

  return items;
}

function buildEmergencyLoop(
  date: string,
  db: ReturnType<typeof getDb>,
  startPos: number
): PlaylistItem[] {
  logger.warn(`No scheduled items for ${date} — building emergency loop`);
  const dayStart = dayjs(date).startOf('day').valueOf();
  const dayEnd = dayjs(date).endOf('day').valueOf();
  return fillRangeEmergencyFallback(dayStart, dayEnd, db, startPos);
}

export function getPlaylistForDate(date: string): DailyPlaylist | null {
  const filePath = path.join(config.paths.playlists, `${date}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DailyPlaylist;
  } catch {
    return null;
  }
}

export function getCurrentAndNext(date: string): { current: PlaylistItem | null; next: PlaylistItem | null; lookahead: PlaylistItem[] } {
  const playlist = getPlaylistForDate(date);
  if (!playlist) return { current: null, next: null, lookahead: [] };

  const now = Date.now();
  let current: PlaylistItem | null = null;
  let next: PlaylistItem | null = null;

  for (let i = 0; i < playlist.items.length; i++) {
    const item = playlist.items[i]!;
    if (item.start_time_ms <= now && item.end_time_ms > now) {
      current = item;
      next = playlist.items[i + 1] ?? null;
      break;
    }
    if (item.start_time_ms > now && !next) {
      next = item;
    }
  }

  const lookahead = playlist.items
    .filter(i => i.start_time_ms > now)
    .slice(0, config.playlist.lookahead);

  return { current, next, lookahead };
}
