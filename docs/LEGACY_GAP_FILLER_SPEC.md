# Legacy Gap Filler Specification

This is the project-local implementation reference for the professional gap
filler behavior requested for Daawah Broadcast Engine. It is derived from the
user-provided legacy specification only; the new engine must not depend on the
legacy runtime, legacy server, or legacy source tree.

## Core Behavior

When a schedule leaves a gap between two playlist items, the engine fills that
gap with short bumper videos using this repeating pattern:

1. Main sting
2. Seasonal sting
3. General bumper
4. General bumper
5. General bumper

The pattern repeats for as long as the gap has time remaining. Empty categories
are skipped without stopping the sequence.

## Default Folders

- Main sting: `/srv/daawah/media/bumpers/logo-sting`
- Seasonal sting: `/srv/daawah/media/bumpers/sting-hag`
- General bumpers: `/srv/daawah/media/bumpers/general`

The folders are configurable through environment variables in the new engine.

## Selection Rules

- Main and seasonal folders use sequential cursor-based selection.
- General bumpers are grouped by first-level subfolder.
- General subfolders are selected round-robin.
- Files inside each folder are selected sequentially by cursor.
- Sorting is deterministic: leading numeric prefix first, then alphabetic name.
- `ORDER BY RANDOM()` is avoided for professional bumpers and remains only as
  the documented legacy emergency/filler fallback.

## Cursor Memory

Cursor state is persisted in SQLite. Cursor keys include:

- `gap:main`
- `gap:seasonal`
- `gap:general-folder-index`
- `gap:general-folder:<folder-key>`

Each cursor stores the last media file id and last played path. If the stored
file disappears, selection restarts from the first ready item and logs a warning.

## Hard Start Trimming

If the final selected bumper is longer than the remaining gap, the playlist item
is shortened to the remaining duration. The new engine must persist trim metadata
and write FFmpeg concat input with `outpoint` and `duration`, so playback ends at
the hard start time of the next scheduled item.

## Fallback

If no professional bumpers are available, the engine falls back to the existing
ready `filler`/`emergency` pool. This fallback is the only place where random
ordering is allowed.
