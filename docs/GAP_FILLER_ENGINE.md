# Professional Gap Filler Engine

The professional gap filler replaces simple random filler selection with a
deterministic broadcast-safe bumper sequence inspired by
`docs/LEGACY_GAP_FILLER_SPEC.md`.

## Idea

Whenever `buildDailyPlaylist` finds time between scheduled items, it asks the
professional gap filler to build playlist items for that exact range. The engine
uses a repeating pattern:

```text
main, seasonal, general, general, general
```

This means:

- 1 main sting
- 1 seasonal sting
- 3 general bumpers

The pattern repeats until the gap is filled. If a category has no ready media,
the category is skipped and the rest of the pattern continues.

## Environment Variables

```text
GAP_MAIN_STING_PATH=/srv/daawah/media/bumpers/logo-sting
GAP_SEASONAL_STING_PATH=/srv/daawah/media/bumpers/sting-hag
GAP_GENERAL_BUMPERS_PATH=/srv/daawah/media/bumpers/general
GAP_PATTERN=main,seasonal,general,general,general
GAP_MIN_FILL_MS=1000
```

Missing folders do not crash the playlist build. The engine logs a warning,
skips the missing category, and uses fallback media only if all professional
categories are empty.

## Media Scanning

The scanner tags files under the configured professional bumper paths as
`media_files.type='filler'`. The real bumper role is stored per playlist item in
`playlist_items.source_role`:

- `main_sting`
- `seasonal_sting`
- `general_bumper`
- `filler`
- `emergency`
- `program`

## Selection And Cursor

Professional selection is deterministic:

- Main uses cursor key `gap:main`.
- Seasonal uses cursor key `gap:seasonal`.
- General folders use `gap:general-folder-index` for round-robin folder choice.
- Each general folder uses `gap:general-folder:<folder-key>` for file choice.

Files are sorted by leading numeric prefix when present, otherwise by stable
alphabetic ordering. The cursor prevents replaying the same file before the
other ready files in that role or folder have been traversed.

Cursor state is stored in SQLite table `bumper_cursor_state`.

Cursor updates happen during `buildDailyPlaylist`, because that build is treated
as final playlist materialization rather than a preview. Future preview flows
should call `fillGapWithProfessionalBumpers(..., { updateCursors: false })`.
That dry-run mode still plans sequence order in memory for the current gap but
does not write cursor rows.

## General Bumpers

Files directly inside the general folder are grouped into `_root`. Files inside
first-level subfolders are grouped by that subfolder. The folder groups are
visited round-robin, and files inside each folder are selected sequentially.

## Hard Start Trimming

If the remaining gap is shorter than the next bumper, the playlist item is
trimmed:

```text
is_trimmed=1
duration_ms=<remaining gap>
trim_out_ms=<remaining gap>
forced_duration_ms=<remaining gap>
```

`ffmpegRunner` writes trimmed items to `current-concat.txt` using ffconcat
syntax with `outpoint` and `duration`, so FFmpeg playback honors the hard start
instead of playing the full source file.

## Fallback

If no professional bumpers are available, `builder.ts` falls back to the legacy
ready `filler`/`emergency` pool. The fallback path is intentionally named
`fillRangeFallbackRandomEmergency` and is the only gap filler path that uses
`ORDER BY RANDOM()`.

Gaps shorter than 30 seconds are still filled when they are at least
`GAP_MIN_FILL_MS`. The fallback item is trimmed with the same playlist trim
metadata so short gaps do not create avoidable black time.

When there are no scheduled items for a day, the playlist builder does not use
the professional 1:1:3 bumper sequence. It builds an emergency-only loop first;
if there is no ready emergency media, it falls back to the existing
filler/emergency pool.

## FFmpeg Trim Check

The optional script `scripts/test-ffmpeg-trim-concat.sh` creates a 20 second MP4,
writes an ffconcat file with `outpoint 5.000` and `duration 5.000`, renders the
concat output through FFmpeg, and verifies the output duration with FFprobe.

## How To Check

Run:

```bash
npm test --workspace=server -- --runInBand
npm exec --workspace=server -- tsc --noEmit
npm exec --workspace=web -- tsc --noEmit
npm run build
```

Key tests:

- `server/src/__tests__/gapFiller.test.ts`
- `server/src/__tests__/playlistBuilderGapFiller.test.ts`
- `server/src/__tests__/ffmpegTrimConcat.test.ts`
- `server/src/__tests__/scheduleImporterMediaFileId.test.ts`
