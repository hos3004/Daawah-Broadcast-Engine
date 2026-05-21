# Scheduler Dashboard Excel Wizard

## Purpose

This phase adds an operator-facing Broadcast Scheduling Dashboard for monthly Excel schedule preparation while media upload is still in progress.

The dashboard lets Hossam:

- download the official Excel template
- upload a filled `.xlsx` schedule
- preview Settings, Programs, and Slots
- see validation errors and warnings
- review folder matching against provisional registry data
- view a light slot-only schedule preview with gap rows

Everything remains preview/draft only.

## Why This Is Safe During Upload

The wizard does not run final indexing, full `ffprobe`, media QC, playlist materialization, FFmpeg, or playout. It reads only the uploaded Excel file and existing DB registry rows.

Folder matching uses the current provisional `media_folders` and `program_candidates` if they already exist. A missing folder is reported as a warning or review item, not as a reason to run a final media scan.

## What The Wizard Does

1. Accepts `.xlsx` uploads through `/api/scheduler-foundation/excel-import/preview`.
2. Parses these sheets:
   - `Settings`
   - `Programs`
   - `Slots`
   - `Overrides` as a future placeholder
3. Validates supported values and required fields.
4. Rejects absolute paths in Excel folder hints.
5. Treats `folder_hint` as a hint under an allowed `folder_root`.
6. Returns normalized rows, row statuses, validation issues, folder matching status, and summary counts.
7. Builds a light schedule preview from slot definitions only.
8. Marks gaps as `Professional Gap Preview` with the informational pattern:
   `main, seasonal, general, general, general`

## What It Does Not Do

The wizard does not:

- activate or publish schedules
- update cursor state
- materialize playlists
- select real media files for playout
- select real bumper files for gaps
- run FFmpeg or ffprobe
- scan the entire media library
- create symlinks or hardlinks
- modify original media files
- serve arbitrary file paths

## Supported Sheets

### Settings

Expected fields:

- `timezone`
- `schedule_start_date`
- `schedule_end_date`
- `default_duration_policy`
- `default_repeat_policy`
- `default_gap_policy`

Validation:

- timezone defaults to `Europe/Istanbul` if omitted
- dates must be `YYYY-MM-DD`
- end date must be after start date
- ranges longer than 31 days produce a warning

### Programs

Required and supported fields:

- `program_key`
- `program_name`
- `folder_hint`
- `folder_root`
- `play_mode`
- `slot_mode`
- `file_count`
- `repeat_policy`
- `enabled`
- `notes`

Supported `play_mode`:

- `sequential`
- `shuffle`
- `newest`
- `round_robin`

Supported `slot_mode`:

- `fit`
- `playlist`
- `file_count`

Supported `repeat_policy`:

- `same_day_same_episode`
- `advance_each_airing`

### Slots

Supported fields:

- `program_key`
- `days`
- `start_time`
- `end_time`
- `duration_minutes`
- `effective_from`
- `effective_to`
- `priority`
- `notes`

Supported days:

- `sat`, `sun`, `mon`, `tue`, `wed`, `thu`, `fri`
- `السبت`, `الأحد`, `الاثنين`, `الثلاثاء`, `الأربعاء`, `الخميس`, `الجمعة`

## Folder Matching Behavior

Folder matching is preview-only:

- `folder_root` must be one of the configured safe roots.
- `folder_hint` must be root-relative.
- absolute Windows or Linux paths are rejected.
- exact matches show `مطابق` with `100%`.
- fuzzy or multiple matches show `يحتاج مراجعة`.
- no match shows `غير موجود`.
- rejected path input shows `مرفوض`.

Confidence guide:

- `100%`: exact
- `80-99%`: likely suggestion
- `50-79%`: needs review
- `0%`: missing or rejected

Missing folders do not fail the entire import. They are expected while upload and final indexing are not complete.

## Draft-Only Behavior

The UI currently shows:

`حفظ المسودة - قريبًا`

It is disabled because there is not yet a dedicated draft persistence endpoint for normalized preview rows. The needed backend endpoint should save:

- uploaded file metadata
- parsed settings
- normalized program rows
- normalized slot rows
- validation report
- folder match preview

It must not publish, activate, materialize playlists, or update cursors.

## API Endpoints

Added/used endpoints:

- `GET /api/scheduler-foundation/excel-template`
- `POST /api/scheduler-foundation/excel-import/preview`
- `GET /api/scheduler-foundation/program-candidates`
- `GET /api/scheduler-foundation/media-registry/status`
- `GET /api/scheduler-foundation/monthly-schedule-preview`

The template endpoint serves one fixed file:

`docs/templates/scheduler_excel_import_template.xlsx`

It does not accept a user-provided path.

## Node Runtime Note

Server tests that touch SQLite should run under Node 20 for this repo. The local system Node 24 can fail against the installed `better-sqlite3` native ABI. Use a Node 20 runtime for test verification until dependencies are upgraded intentionally.

## Manual Frontend Verification

There is no dedicated frontend test harness in this repo yet. After starting the app in a safe local environment, verify:

1. The dashboard title shows `لوحة تجهيز وجدولة البث`.
2. The preview badge shows `معاينة فقط - لم يتم تفعيل الجدول`.
3. The `تحميل نموذج Excel` button downloads the fixed template file.
4. Uploading an `.xlsx` file shows summary cards, imported programs, imported slots, folder matching, issues, and preliminary preview tabs.
5. Validation errors use Arabic-friendly messages.
6. There is no production start, publish, playout, FFmpeg, or activation button.
7. `حفظ المسودة - قريبًا` remains disabled until a safe draft endpoint is added.

## Post-Upload Next Steps

After media upload completes:

1. Confirm no upload process is still writing files.
2. Run the final controlled media registry scan.
3. Run the final ffprobe/QC pass.
4. Generate real `program_candidates`.
5. Review and approve safe name mappings.
6. Re-upload or re-preview the monthly Excel schedule.
7. Add safe draft persistence.
8. Add final schedule activation in a separate approved phase.
