import { getDb } from '../db/schema';
import { logger } from '../utils/logger';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  date?: string;
  itemId?: string;
}

export interface ValidationReport {
  scheduleId: string;
  isValid: boolean;
  issues: ValidationIssue[];
  testedItems: number;
  errors: number;
  warnings: number;
}

interface RawItem {
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
  sort_order: number;
}

export function validateSchedule(scheduleId: string): ValidationReport {
  const db = getDb();
  const issues: ValidationIssue[] = [];

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as
    { id: string; status: string } | undefined;
  if (!schedule) throw new Error(`Schedule ${scheduleId} not found`);

  const items = db.prepare(`
    SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY date, start_time, sort_order
  `).all(scheduleId) as RawItem[];

  // Group by date
  const byDate = new Map<string, RawItem[]>();
  for (const item of items) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    byDate.get(item.date)!.push(item);
  }

  for (const [date, dayItems] of byDate) {
    checkTimeConflicts(date, dayItems, issues);
    checkGaps(date, dayItems, issues);
    checkMissingFiles(date, dayItems, issues, db);
    checkUnknownDurations(date, dayItems, issues);
    checkDuplicates(date, dayItems, issues);
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const isValid = errors === 0;

  const report: ValidationReport = {
    scheduleId,
    isValid,
    issues,
    testedItems: items.length,
    errors,
    warnings,
  };

  db.prepare('UPDATE schedules SET validation_report=? WHERE id=?')
    .run(JSON.stringify(report), scheduleId);

  logger.info(`Validated schedule ${scheduleId}: ${errors} errors, ${warnings} warnings`);
  return report;
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function checkTimeConflicts(date: string, items: RawItem[], issues: ValidationIssue[]): void {
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i]!;
    const b = items[i + 1]!;
    const aStart = toMinutes(a.start_time);
    const bStart = toMinutes(b.start_time);
    const aDuration = a.expected_duration ? a.expected_duration / 60 : 0;
    const aEnd = aStart + aDuration;

    if (aDuration > 0 && aEnd > bStart) {
      issues.push({
        severity: 'error',
        code: 'TIME_CONFLICT',
        message: `"${a.title}" (${a.start_time}) overlaps with "${b.title}" (${b.start_time}) on ${date}`,
        date,
        itemId: a.id,
      });
    }
  }
}

function checkGaps(date: string, items: RawItem[], issues: ValidationIssue[]): void {
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i]!;
    const b = items[i + 1]!;
    const aStart = toMinutes(a.start_time);
    const aDuration = a.expected_duration ? a.expected_duration / 60 : 0;
    const aEnd = aStart + aDuration;
    const bStart = toMinutes(b.start_time);
    const gap = bStart - aEnd;

    if (aDuration > 0 && gap > 1) {
      issues.push({
        severity: 'warning',
        code: 'GAP_DETECTED',
        message: `${Math.round(gap)} minute gap between "${a.title}" and "${b.title}" on ${date}`,
        date,
        itemId: a.id,
      });
    }
  }
}

function checkMissingFiles(
  date: string,
  items: RawItem[],
  issues: ValidationIssue[],
  db: ReturnType<typeof getDb>
): void {
  for (const item of items) {
    if (item.type !== 'program') continue;

    if (!item.program_id && !item.episode_id && !item.media_file_id) {
      issues.push({
        severity: 'error',
        code: 'NO_MEDIA_ASSIGNED',
        message: `"${item.title}" on ${date} ${item.start_time} has no media file or program assigned`,
        date,
        itemId: item.id,
      });
      continue;
    }

    if (item.episode_id) {
      const ep = db.prepare(`
        SELECT e.id, mf.status FROM episodes e
        LEFT JOIN media_files mf ON e.media_file_id = mf.id
        WHERE e.id = ?
      `).get(item.episode_id) as { id: string; status: string | null } | undefined;

      if (!ep) {
        issues.push({
          severity: 'error',
          code: 'EPISODE_NOT_FOUND',
          message: `Episode "${item.episode_id}" for "${item.title}" on ${date} not found in library`,
          date,
          itemId: item.id,
        });
      } else if (ep.status && ep.status !== 'ready') {
        issues.push({
          severity: 'warning',
          code: 'EPISODE_NOT_READY',
          message: `Episode for "${item.title}" on ${date} status is "${ep.status}"`,
          date,
          itemId: item.id,
        });
      }
    }

    if (item.program_id && !item.episode_id) {
      const readyCount = (db.prepare(`
        SELECT COUNT(*) as cnt FROM media_files WHERE program_id=? AND status='ready'
      `).get(item.program_id) as { cnt: number }).cnt;

      if (readyCount === 0) {
        issues.push({
          severity: 'error',
          code: 'NO_READY_EPISODES',
          message: `Program "${item.title}" on ${date} has no ready episodes`,
          date,
          itemId: item.id,
        });
      }
    }
  }
}

function checkUnknownDurations(date: string, items: RawItem[], issues: ValidationIssue[]): void {
  for (const item of items) {
    if (item.type === 'program' && !item.expected_duration) {
      issues.push({
        severity: 'warning',
        code: 'UNKNOWN_DURATION',
        message: `"${item.title}" on ${date} ${item.start_time} has no expected_duration`,
        date,
        itemId: item.id,
      });
    }
  }
}

function checkDuplicates(date: string, items: RawItem[], issues: ValidationIssue[]): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!item.episode_id) continue;
    if (seen.has(item.episode_id)) {
      issues.push({
        severity: 'warning',
        code: 'DUPLICATE_EPISODE',
        message: `Episode "${item.episode_id}" appears twice on ${date}: "${seen.get(item.episode_id)}" and "${item.title}"`,
        date,
        itemId: item.id,
      });
    }
    seen.set(item.episode_id, item.title);
  }
}

export function publishSchedule(scheduleId: string, publishedBy: string): void {
  const db = getDb();
  const report = db.prepare('SELECT validation_report, status FROM schedules WHERE id=?').get(scheduleId) as
    { validation_report: string | null; status: string } | undefined;

  if (!report) throw new Error(`Schedule ${scheduleId} not found`);

  if (report.status === 'published') throw new Error('Schedule is already published');

  if (report.validation_report) {
    const parsed = JSON.parse(report.validation_report) as ValidationReport;
    if (!parsed.isValid) {
      throw new Error(`Cannot publish schedule with ${parsed.errors} validation errors. Run validation first.`);
    }
  }

  db.prepare(`
    UPDATE schedules SET status='published', published_by=?, published_at=datetime('now') WHERE id=?
  `).run(publishedBy, scheduleId);

  logger.info(`Schedule ${scheduleId} published by ${publishedBy}`);
}
