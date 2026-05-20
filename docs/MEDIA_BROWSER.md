# Read-Only Media Browser

The Media Browser is a read-only admin page for inspecting the media tree on the
new Daawah server. It is intended for safe operations before real-library tests:
view folders, inspect size/file counts, copy full paths, and scan a selected
folder into the media database.

## Scope

Implemented:

- Allowed roots only under `MEDIA_BROWSER_BASE_PATH`.
- Root selection by opaque `rootId`; the API never trusts a raw absolute path
  from the browser.
- Path traversal protection for `../`, absolute paths, null bytes, and symlink
  escapes outside the selected root.
- Directory and file metadata: full path, size, file count, MP4 count, modified
  time.
- MP4-only filtering.
- Arabic filename search with Unicode normalization and basic Arabic letter
  folding.
- Copy full path button.
- Scan selected folder button using the existing scanner pipeline.

Not implemented by design:

- Delete.
- Rename.
- Move.

Those actions conflict with the read-only requirement and should only be added
later behind a separate write-mode design with confirmations, RBAC, audit logs,
and backup/recovery rules.

## Environment

```env
MEDIA_BROWSER_BASE_PATH=/srv/daawah/media
MEDIA_BROWSER_ALLOWED_ROOTS=original-ar,source,bumpers,emergency
MEDIA_BROWSER_STATS_FILE_LIMIT=10000
```

`MEDIA_BROWSER_ALLOWED_ROOTS` accepts comma-separated relative paths under
`MEDIA_BROWSER_BASE_PATH`. Absolute paths are accepted only if their resolved
real path remains inside `MEDIA_BROWSER_BASE_PATH`.

Configured media paths such as `MEDIA_LIBRARY_PATH`, `MEDIA_EMERGENCY_PATH`, and
professional bumper paths are also considered, but any path outside the browser
base is ignored.

## API

```text
GET  /api/media/browser/roots
GET  /api/media/browser/list?rootId=<id>&path=<relative>&search=<q>&mp4Only=true
POST /api/media/browser/scan
```

The scan body is:

```json
{
  "rootId": "original-ar",
  "path": "program-a"
}
```

The selected scan mutates only the media database state. It does not delete,
rename, move, or upload files.

## Security Notes

The browser follows the OWASP path traversal guidance: user-controlled path
input is normalized, resolved, and checked against a strict allowlist. Node's
`path.resolve()` is used as a canonicalization step, then the resolved real path
must still be inside the selected root. Symlink escapes are rejected.

Clipboard copy uses the browser Clipboard API when available and falls back to a
local text selection copy for older contexts.

## Validation

Run:

```bash
npm test --workspace=server -- --runInBand
npm exec --workspace=server -- tsc --noEmit
npm exec --workspace=web -- tsc --noEmit
npm run build
```

Coverage added in `server/src/__tests__/mediaBrowser.test.ts`:

- Roots outside the media base are ignored.
- `../../` traversal is rejected.
- Directory stats include file count, MP4 count, and size.
- MP4 filter keeps directories navigable and hides non-MP4 files.
- Arabic filename search handles normalized `ة`/`ه`.
