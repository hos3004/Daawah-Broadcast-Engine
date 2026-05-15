import { parse as csvParse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/schema';
import { logger } from '../utils/logger';

const ItemSchema = z.object({
  date:              z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  start_time:        z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'start_time must be HH:MM or HH:MM:SS'),
  type:              z.enum(['program', 'filler', 'quran', 'promo', 'emergency']),
  program_id:        z.string().optional().nullable(),
  episode_id:        z.string().optional().nullable(),
  title:             z.string().min(1),
  expected_duration: z.number().positive().optional().nullable(),
  duration_policy:   z.enum(['exact', 'fit', 'allow_overrun', 'fill_gap']).default('exact'),
});

export type ScheduleItemInput = z.infer<typeof ItemSchema>;

export interface ImportResult {
  scheduleId: string;
  itemCount: number;
  errors: string[];
}

export function importScheduleFromJson(
  raw: unknown,
  name: string,
  importedBy: string
): ImportResult {
  const errors: string[] = [];

  if (!Array.isArray(raw)) throw new Error('JSON schedule must be an array of items');

  const items: ScheduleItemInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = ItemSchema.safeParse(raw[i]);
    if (!result.success) {
      errors.push(`Row ${i + 1}: ${result.error.issues.map(e => e.message).join(', ')}`);
    } else {
      items.push(result.data);
    }
  }

  return persistSchedule(name, items, importedBy, errors);
}

export function importScheduleFromCsv(
  csvContent: string,
  name: string,
  importedBy: string
): ImportResult {
  const errors: string[] = [];

  let rows: Record<string, string>[];
  try {
    rows = csvParse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new Error(`CSV parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const items: ScheduleItemInput[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const raw = {
      ...row,
      expected_duration: row['expected_duration'] ? Number(row['expected_duration']) : undefined,
    };
    const result = ItemSchema.safeParse(raw);
    if (!result.success) {
      errors.push(`Row ${i + 2}: ${result.error.issues.map(e => e.message).join(', ')}`);
    } else {
      items.push(result.data);
    }
  }

  return persistSchedule(name, items, importedBy, errors);
}

export function importScheduleFromXlsx(
  buffer: Buffer,
  name: string,
  importedBy: string
): ImportResult {
  const errors: string[] = [];

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('XLSX file has no sheets');

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('Could not read sheet');

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: false });

  const items: ScheduleItemInput[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const raw = {
      ...row,
      expected_duration: row['expected_duration'] ? Number(row['expected_duration']) : undefined,
    };
    const result = ItemSchema.safeParse(raw);
    if (!result.success) {
      errors.push(`Row ${i + 2}: ${result.error.issues.map(e => e.message).join(', ')}`);
    } else {
      items.push(result.data);
    }
  }

  return persistSchedule(name, items, importedBy, errors);
}

function persistSchedule(
  name: string,
  items: ScheduleItemInput[],
  importedBy: string,
  parseErrors: string[]
): ImportResult {
  if (items.length === 0) {
    throw new Error(`No valid items to import. Errors: ${parseErrors.slice(0, 5).join('; ')}`);
  }

  const db = getDb();
  const scheduleId = uuidv4();

  const dates = items.map(i => i.date).sort();
  const startDate = dates[0]!;
  const endDate = dates[dates.length - 1]!;

  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO schedules (id, name, start_date, end_date, status, imported_by)
      VALUES (?, ?, ?, ?, 'draft', ?)
    `).run(scheduleId, name, startDate, endDate, importedBy);

    const stmt = db.prepare(`
      INSERT INTO schedule_items
        (id, schedule_id, date, start_time, type, program_id, episode_id, title, expected_duration, duration_policy, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);

    items.forEach((item, idx) => {
      stmt.run(
        uuidv4(), scheduleId, item.date, item.start_time, item.type,
        item.program_id ?? null, item.episode_id ?? null,
        item.title, item.expected_duration ?? null,
        item.duration_policy, idx
      );
    });
  });

  insert();
  logger.info(`Imported schedule "${name}" with ${items.length} items (id=${scheduleId})`);

  return { scheduleId, itemCount: items.length, errors: parseErrors };
}
