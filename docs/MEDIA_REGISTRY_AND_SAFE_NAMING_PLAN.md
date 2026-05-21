# Media Registry and Safe Naming Plan

## Why the Registry Comes Before Scheduling

The scheduler dashboard needs stable database identities before it can safely build drafts, previews, or future playlists. Arabic folder names and filenames can remain exactly as they are on disk, while the application links schedules to `media_roots`, `media_folders`, `media_files`, and later `programs` by IDs.

This avoids using absolute paths or Arabic display names as permanent identities.

## Arabic Names Are Preserved

- `display_name_ar`, `display_title_ar`, `original_relative_path`, and `original_filename` preserve the original Arabic text.
- Normalized names are used only for matching, search, duplicate detection, and slug generation.
- The original library remains the source of truth for visible names.

## Safe Slug Generation

Safe slugs are generated from a matching-normalized copy of the name:

- remove tashkeel and tatweel
- normalize `أ / إ / آ / ٱ` to `ا`
- normalize whitespace
- normalize punctuation, hyphen, and underscore differences
- treat `ة / ه` as equivalent for matching only
- strip dangerous path characters such as `/`, `\`, `:`, `*`, `?`, `<`, `>`, and control characters
- resolve collisions deterministically with suffixes such as `-2`, `-3`

`safe_slug` is not identity. Real identity remains `media_file_id`, `folder_id`, and later `program_id`.

## Protected Media Roots

Configured roots:

| root_key | path | mode |
| --- | --- | --- |
| `original-ar` | `/srv/daawah/media/original-ar` | read-only original library |
| `source` | `/srv/daawah/media/source` | managed source area |
| `bumpers` | `/srv/daawah/media/bumpers` | managed bumper area |
| `emergency` | `/srv/daawah/media/emergency` | managed emergency area |

Rules:

- `original-ar` is read-only and protected.
- Excel import data must never provide arbitrary absolute paths.
- Excel folder values are root-relative hints only.
- Filesystem access must validate resolved paths with `realpath` when the path exists.
- No direct streaming or file serving should be added from arbitrary uploaded paths.

## What Can Be Done During Upload

Safe during the current media upload window:

- create DB tables and schema extensions
- implement Arabic normalization and safe naming utilities
- implement root-relative path validation
- build preview-only APIs
- parse and validate Excel templates
- add dashboard skeleton pages
- run unit tests and TypeScript builds
- optionally run light, dry-run folder previews that skip recently modified files

## What Must Wait Until Upload Completes

Do not do these during upload:

- final full media scan
- full `ffprobe` scan
- final media QC report
- symlink or hardlink creation
- approving safe name mappings
- publishing schedules
- materializing production playlists
- running broadcast/playout

## Post-Upload Final Scan Checklist

After Hossam confirms upload completion:

1. Verify upload has stopped and no files were modified in the last 15-30 minutes.
2. Run a provisional registry scan with `skipRecentlyModifiedMinutes` enabled.
3. Review root counts for `original-ar`, `source`, `bumpers`, and `emergency`.
4. Run the final media scan and controlled `ffprobe` pass.
5. Generate real `program_candidates` from indexed folders.
6. Review safe slug collisions and approve mappings.
7. Import the Excel schedule in preview mode.
8. Fix validation errors and review warnings.
9. Only after approval, create a draft schedule version.
10. Validate, preview, and activate in a later controlled phase.

## Current Foundation Scope

This phase is preparation only. It does not update cursor state, start playout, run FFmpeg, materialize playlists, change DNS, or deploy production changes.
