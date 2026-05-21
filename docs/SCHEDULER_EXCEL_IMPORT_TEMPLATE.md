# Scheduler Excel Import Template

Use this template for preview validation only. Import preview must not activate a schedule, update cursors, materialize playlists, or run FFmpeg.

Do not put absolute paths in Excel. Use:

- `folder_root`: one of `original-ar`, `source`, `bumpers`, `emergency`
- `folder_hint`: a root-relative hint such as `Tafseer/Season 01`

Examples that are rejected:

- `C:\Media\Tafseer`
- `/srv/daawah/media/original-ar/Tafseer`
- `../outside-root`

## Sheet: Settings

| column | example | notes |
| --- | --- | --- |
| `timezone` | `Europe/Istanbul` | one timezone source of truth |
| `schedule_start_date` | `2026-06-01` | `YYYY-MM-DD` |
| `schedule_end_date` | `2026-06-30` | `YYYY-MM-DD` |
| `default_duration_policy` | `fit` | future policy |
| `default_repeat_policy` | `same_day_same_episode` | supported value below |
| `default_gap_policy` | `professional_gap_filler` | future policy |

## Sheet: Programs

| column | example |
| --- | --- |
| `program_key` | `tafseer-evening` |
| `program_name` | `برنامج التفسير` |
| `folder_hint` | `Tafseer/Season 01` |
| `folder_root` | `original-ar` |
| `play_mode` | `sequential` |
| `slot_mode` | `fit` |
| `file_count` |  |
| `repeat_policy` | `same_day_same_episode` |
| `enabled` | `true` |
| `notes` | `review after final media scan` |

## Sheet: Slots

| column | example |
| --- | --- |
| `program_key` | `tafseer-evening` |
| `days` | `sat;sun;mon;tue;wed;thu;fri` |
| `start_time` | `20:00` |
| `end_time` | `21:00` |
| `duration_minutes` |  |
| `effective_from` | `2026-06-01` |
| `effective_to` | `2026-06-30` |
| `priority` | `10` |
| `notes` | `preview only` |

## Optional Future Sheet: Overrides

| column | example |
| --- | --- |
| `date` | `2026-06-10` |
| `start_time` | `20:00` |
| `action` | `replace` |
| `program_key` | `special-lecture` |
| `title` | `محاضرة خاصة` |
| `duration_minutes` | `60` |
| `notes` | `future override` |

## Supported Values

`play_mode`:

- `sequential`
- `shuffle`
- `newest`
- `round_robin`

`slot_mode`:

- `fit`
- `playlist`
- `file_count`

`repeat_policy`:

- `same_day_same_episode`
- `advance_each_airing`

`folder_root`:

- `original-ar`
- `source`
- `bumpers`
- `emergency`

## Common Validation Errors

| code | Arabic-friendly meaning |
| --- | --- |
| `MISSING_PROGRAM_KEY` | مفتاح البرنامج مطلوب |
| `DUPLICATE_PROGRAM_KEY` | مفتاح البرنامج مكرر |
| `MISSING_PROGRAM_NAME` | اسم البرنامج مطلوب |
| `MISSING_FOLDER_HINT` | مسار المجلد النسبي مطلوب |
| `ABSOLUTE_PATH_REJECTED` | لا تستخدم مسار كامل من Excel |
| `UNSUPPORTED_PLAY_MODE` | طريقة التشغيل غير مدعومة |
| `UNSUPPORTED_SLOT_MODE` | نوع الفترة غير مدعوم |
| `MISSING_FILE_COUNT` | عدد الملفات مطلوب عند اختيار `file_count` |
| `INVALID_REPEAT_POLICY` | سياسة التكرار غير صحيحة |
| `INVALID_ENABLED_VALUE` | قيمة التفعيل يجب أن تكون واضحة مثل `true` أو `false` |
| `PROGRAM_KEY_NOT_FOUND` | الفترة تشير إلى برنامج غير موجود في Sheet Programs |
| `INVALID_DAYS` | أيام العرض غير صحيحة |
| `INVALID_START_TIME` | وقت البداية يجب أن يكون `HH:MM` |
| `INVALID_END_TIME` | وقت النهاية يجب أن يكون `HH:MM` |
| `MISSING_DURATION` | المدة مطلوبة إذا لم يوجد وقت نهاية |
| `OVERLAPPING_SLOTS` | يوجد تداخل بين فترتين في نفس اليوم |
| `GAP_DETECTED` | يوجد فراغ بين فترتين، وهذا تحذير وليس خطأ قاتل |
| `CROSSING_MIDNIGHT` | الفترة تعبر منتصف الليل وتحتاج مراجعة واضحة |

## Arabic-Friendly Examples

Programs:

```csv
program_key,program_name,folder_hint,folder_root,play_mode,slot_mode,file_count,repeat_policy,enabled,notes
tafseer-evening,برنامج التفسير,Tafseer/Season 01,original-ar,sequential,fit,,same_day_same_episode,true,حلقة واحدة داخل الفترة
daily-reminder,خاطرة اليوم,Reminders/Daily,original-ar,shuffle,playlist,,advance_each_airing,true,قائمة قصيرة داخل الفترة
two-lectures,محاضرتان,Special/Two Lectures,original-ar,sequential,file_count,2,same_day_same_episode,true,تشغيل ملفين فقط
```

Slots:

```csv
program_key,days,start_time,end_time,duration_minutes,effective_from,effective_to,priority,notes
tafseer-evening,السبت;الأحد;الاثنين,20:00,21:00,,2026-06-01,2026-06-30,10,موعد رئيسي
daily-reminder,fri,09:00,,30,2026-06-01,2026-06-30,20,مدة بدون end_time
two-lectures,wed,23:30,00:30,,2026-06-01,2026-06-30,30,يعبر منتصف الليل
```

## Common Mistakes

- Using an absolute path instead of `folder_root` plus `folder_hint`.
- Writing `play_mode=random`; use `shuffle` if random-like behavior is intended.
- Writing `slot_mode=file-count`; use `file_count`.
- Leaving `file_count` empty when `slot_mode=file_count`.
- Writing day names with unsupported spelling.
- Providing `start_time` without either `end_time` or `duration_minutes`.
- Reusing the same `program_key` for more than one row.

## Example Rows

Programs:

```csv
program_key,program_name,folder_hint,folder_root,play_mode,slot_mode,file_count,repeat_policy,enabled,notes
tafseer-evening,برنامج التفسير,Tafseer/Season 01,original-ar,sequential,fit,,same_day_same_episode,true,preview only
short-reminders,خواطر قصيرة,Reminders,original-ar,shuffle,playlist,,advance_each_airing,true,short files
two-files,ملفان,Special/Two Files,original-ar,sequential,file_count,2,same_day_same_episode,true,file count slot
```

Slots:

```csv
program_key,days,start_time,end_time,duration_minutes,effective_from,effective_to,priority,notes
tafseer-evening,sat;sun;mon;thu,20:00,21:00,,2026-06-01,2026-06-30,10,main slot
short-reminders,fri,09:00,,30,2026-06-01,2026-06-30,20,duration-based slot
two-files,wed,23:30,00:30,,2026-06-01,2026-06-30,30,crosses midnight
```
