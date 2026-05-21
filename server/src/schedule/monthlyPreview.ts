import { getDb } from '../db/schema';

export interface MonthlySchedulePreviewResult {
  mode: 'preview';
  scheduleActivated: false;
  playlistMaterialized: false;
  cursorMutation: false;
  cursorRowsBefore: number;
  cursorRowsAfter: number;
  message: string;
}

export function buildMonthlySchedulePreviewStub(): MonthlySchedulePreviewResult {
  const db = getDb();
  const cursorRowsBefore = countCursorRows(db);
  const cursorRowsAfter = countCursorRows(db);

  return {
    mode: 'preview',
    scheduleActivated: false,
    playlistMaterialized: false,
    cursorMutation: false,
    cursorRowsBefore,
    cursorRowsAfter,
    message: '30-day preview is reserved for the post-upload scheduler phase.',
  };
}

function countCursorRows(db: ReturnType<typeof getDb>): number {
  const legacy = (db.prepare('SELECT COUNT(*) as cnt FROM cursors').get() as { cnt: number }).cnt;
  const bumpers = (db.prepare('SELECT COUNT(*) as cnt FROM bumper_cursor_state').get() as { cnt: number }).cnt;
  return legacy + bumpers;
}
