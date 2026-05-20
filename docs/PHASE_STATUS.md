# Phase Status — Production Blockers Round 1

## Professional Gap Filler Engine

**Branch:** `feature/professional-gap-filler-engine`
**Date:** 2026-05-20

Status: implemented for review.

This phase adds a professional gap filler inspired by
`docs/LEGACY_GAP_FILLER_SPEC.md`. It replaces simple random gap filling with a
deterministic `main, seasonal, general, general, general` pattern, persistent
SQLite cursor state, general-bumper folder round-robin, and FFmpeg concat
trimming for hard starts.

Implemented pieces:

- New SQLite migration v3 with `bumper_cursor_state`.
- Safe playlist item metadata columns: `source_role`, `is_trimmed`,
  `trim_out_ms`, and `forced_duration_ms`.
- New `server/src/playlist/gapFiller.ts` professional sequence builder.
- `buildDailyPlaylist` now calls the professional filler first and only uses the
  random emergency/filler fallback when no professional bumpers are available.
- Scanner classifies configured professional bumper paths as `type='filler'`.
- FFmpeg concat generation writes `ffconcat version 1.0`, `outpoint`, and
  `duration` for trimmed items.
- Schedule importer and validator now support direct `media_file_id` items.

Docs:

- `docs/GAP_FILLER_ENGINE.md`
- `docs/LEGACY_GAP_FILLER_SPEC.md`

### PR #2 Review Fixes

**Branch:** `fix/professional-gap-filler-review-fixes`
**Date:** 2026-05-20

Small blockers addressed before merge review:

- Prevented infinite loops when `GAP_PATTERN` contains only roles with no ready
  bumpers while another unused role has media.
- Added `updateCursors=false` dry-run support for future preview callers.
- Documented that `buildDailyPlaylist` is final materialization, so default
  cursor updates happen during build.
- Clarified no-schedule behavior: no scheduled items builds an emergency-first
  loop and does not use the professional 1:1:3 sequence.
- Added `GAP_MIN_FILL_MS` and changed fallback filling so short gaps at or above
  that threshold are trimmed instead of being left empty.
- Added `scripts/test-ffmpeg-trim-concat.sh`.

FFmpeg trim script result:

```text
bash scripts/test-ffmpeg-trim-concat.sh
FFmpeg trim concat OK: 5.200s
```

Verification:

```text
npm test --workspace=server -- --runInBand  # 9 suites, 34 tests passed
npm exec --workspace=server -- tsc --noEmit # passed
npm exec --workspace=web -- tsc --noEmit    # passed
npm run build                               # passed
```

---

## Round A — Auth + Build Stability

**Branch:** `fix/production-blockers-round-1`
**Date:** 2026-05-15

---

### Fixes Applied

#### 1. Auth Routes (`server/src/api/routes/auth.ts`)

**Problem:**
- `/api/auth/me` manually checked `req.user` but it was always `undefined` — `requireAuth` never ran for routes mounted under `/api/auth` (public mount).
- `/api/auth/logout` referenced `req.user` for audit logging, also always undefined.

**Fix:**
- Imported `requireAuth` and `verifyToken` into auth router.
- Applied `requireAuth` middleware directly to the `GET /me` route handler.
- Rewrote `POST /logout` to always clear the cookie, and independently verify the token for audit logging — this way logout works even when `req.user` isn't populated by a middleware.

**Files modified:**
- `server/src/api/routes/auth.ts`

---

#### 2. Web TypeScript Errors (`web/src/pages/`)

**Problem:** 7 TypeScript errors preventing clean `tsc && vite build`:

| File | Error | Fix |
|------|-------|-----|
| `BroadcastControl.tsx:48` | `unknown` not assignable to `ReactNode` | `Boolean(statusData?.['isEmergency'])` |
| `BroadcastControl.tsx:122–127` | `nowData` possibly undefined inside `&&` block | Replaced `Boolean(...)` with explicit `nowData != null && nowData['next'] != null` narrowing |
| `Dashboard.tsx:5` | `Users` imported but never used | Removed from import |
| `Login.tsx:43` | `ringColor` not in CSS Properties | Removed invalid CSS property from inline style |
| `Logs.tsx:95` | `unknown` not assignable to `ReactNode` | `Boolean(entry['detail'])` |
| `Schedule.tsx:25` | `selectedId`/`setSelectedId` unused | Removed dead state declarations |

---

#### 3. Test Infrastructure (`server/`)

**Problem:** `npm test --workspace=server` failed with `Cannot find module jest` — jest not installed.

**Fix:**
- Installed `jest@^29`, `ts-jest@^29`, `@types/jest@^29` into server devDependencies (aligned versions for CommonJS project).
- Added `server/jest.config.js` with ts-jest preset.
- Changed test script from `node --experimental-vm-modules node_modules/.bin/jest` → `jest`.
- Added `server/src/__tests__/auth.test.ts` — 5 unit tests for auth utilities (hash, verify, sign/verify token round-trip).

---

### Test Results

```
npm test --workspace=server
PASS src/__tests__/auth.test.ts
  auth utilities
    ✓ hashPassword produces a bcrypt hash
    ✓ verifyPassword returns true for correct password
    ✓ verifyPassword returns false for wrong password
    ✓ signToken + verifyToken round-trip
    ✓ verifyToken returns null for invalid token
Tests: 5 passed, 5 total
```

### Build Results

```
npm run build --workspace=server  → tsc — 0 errors
npm run build --workspace=web     → tsc && vite build — ✓ built in 2.64s
web tsc --noEmit                  → 0 errors
```

---

## Round B — Emergency Scanner + FFmpeg Minimum Fixes

Completed in `fix/production-blockers-round-1`. See commit `675273b`.

Fixes: scanner multi-path (emergency dir), preflight check, -re flag, HLS cleanup, day rollover, HLS stale reaction, now-playing overlay.

---

## Round C — Pre-Smoke Critical Blockers

**Branch:** `fix/pre-smoke-critical-blockers`
**Date:** 2026-05-15

---

### Fix 1 — `broadcast_runs.status` constraint violation

**Problem:** `handleFfmpegExit(0)` wrote `status='complete'` to `broadcast_runs`, but the DB CHECK constraint only allows `idle|starting|running|stopping|error|emergency`. This would throw a SQLite constraint error on first natural playlist completion.

**Fix:** Changed to `status='idle'` with `stop_reason='playlist_complete'`. The `stop_reason` column carries the semantic distinction — no schema migration needed.

**File:** `server/src/broadcast/ffmpegRunner.ts`

---

### Fix 2 — systemd service path

**Problem:** `WorkingDirectory=/opt/daawah-broadcast` + `ExecStart=node dist/index.js` points to non-existent `/opt/daawah-broadcast/dist/index.js`. The actual build output (npm workspaces) is at `/opt/daawah-broadcast/server/dist/index.js`.

**Fix:** Changed `WorkingDirectory` to `/opt/daawah-broadcast/server`. `ExecStart=node dist/index.js` is now correct.

**Note:** `systemd-analyze verify` is unavailable on Windows (development machine). Verify on VPS with:
```bash
systemd-analyze verify /etc/systemd/system/daawah-api.service
```

**File:** `deploy/systemd/daawah-api.service`

---

### Fix 3 — Emergency readiness disk check

**Problem:** `checkEmergencyReadiness()` counted DB rows with `status='ready'` but never verified the files exist on disk. A file could be deleted after scanning and the preflight would still pass.

**Fix:** Function now calls `fs.existsSync()` for each DB-ready path. Returns `{ ok, dbCount, diskCount, missingPaths }`.

Preflight error messages now distinguish:
- No DB entries → "run a media scan first"
- DB entries but files missing → "N file(s) missing from disk — rescan needed"

**File:** `server/src/media/scanner.ts`, `server/src/broadcast/ffmpegRunner.ts`

---

### Fix 4 — HLS stale reaction cooldown + try/catch

**Problem:** `checkHlsStatus` called `reactToHlsStale()` every 30 seconds if HLS was stale — could trigger restart loop. No try/catch around the call.

**Fix:**
- Added `HLS_STALE_REACTION_COOLDOWN_MS = 120_000` (2 min) in `ffmpegRunner.ts`
- `reactToHlsStale()` returns early if a reaction is active within cooldown window
- Monitoring's `checkHlsStatus` wraps both Telegram alert and `reactToHlsStale()` in separate try/catch blocks
- Added inner try/catch inside `reactToHlsStale()` for the emergency switch fallback

**File:** `server/src/broadcast/ffmpegRunner.ts`, `server/src/monitoring/index.ts`

---

### Fix 5 — HLS cleanup path safety

**Problem:** `cleanHlsOutput()` could theoretically operate on a very short or root path if `HLS_OUTPUT_PATH` was misconfigured.

**Fix:** Added `isHlsDirSafe()` guard that refuses to clean if:
- Path is empty or whitespace
- Resolved path is `/` or root separator
- Resolved length < 10 chars
- Path matches a hardcoded list of dangerous directories (`/etc`, `/usr`, `/bin`, etc.)

**File:** `server/src/broadcast/ffmpegRunner.ts`

---

### Test Results

```
npm test --workspace=server -- --runInBand

PASS src/__tests__/hlsStale.test.ts     (3 tests)
PASS src/__tests__/auth.test.ts         (5 tests)
PASS src/__tests__/scanner.test.ts      (6 tests)
PASS src/__tests__/ffmpegRunner.test.ts (4 tests)

Test Suites: 4 passed, 4 total
Tests:       18 passed, 18 total
```

### Build Results

```
tsc --noEmit (server)  → 0 errors
tsc --noEmit (web)     → 0 errors
npm run build (server) → tsc — 0 errors
npm run build (web)    → vite build ✓
```

---

### VPS Smoke Test Readiness

**Is the branch ready for a limited VPS smoke test? YES — with the following checklist:**

- [x] `npm run build` succeeds on both workspaces
- [x] 18 unit tests pass
- [x] Auth: /me and /logout work correctly
- [x] Scanner indexes `/media/library` AND `/media/emergency` separately
- [x] startBroadcast() refuses to run without emergency media on disk
- [x] systemd service points to correct compiled path
- [x] FFmpeg uses -re (real-time pacing), no append_list, cleans HLS before start
- [x] HLS stale reaction has 2-min cooldown; monitoring has try/catch
- [x] broadcast_runs.status constraint will not be violated

**Pre-smoke checklist on VPS:**
1. Place at least one video file in `/media/emergency/`
2. Run media scan: `POST /api/media/scan`
3. Confirm at least one `type=emergency, status=ready` row: `sqlite3 /opt/daawah-broadcast/data/daawah.db "SELECT count(*) FROM media_files WHERE type='emergency' AND status='ready'"`
4. Import and publish a schedule
5. Build today's playlist: `POST /api/broadcast/build-playlist`
6. Start broadcast: `POST /api/broadcast/start`
7. Check HLS: `curl -I https://stream.YOUR-DOMAIN/hls/stream.m3u8`

---

### Still Deferred After Smoke Test

| Item | Reason deferred |
|------|----------------|
| Per-item now-playing update | Needs item-by-item controller — Phase 3 work |
| Seamless day rollover (no gap) | Requires make-before-break concat switching |
| CSRF protection | Not blocking for internal admin use |
| WebSocket auth hardening | Not blocking for smoke test |
| RTMP output testing | Secondary output — HLS is primary |
| Transcode worker VPS test | Depends on having non-ready media files |

---

## Round D - Playlist Builder SQL Literal Fix

**Branch:** `fix/pre-smoke-critical-blockers`
**Date:** 2026-05-15

### Problem

Local smoke testing found that after schedule import/validate/publish, building today's playlist failed with:

```text
SqliteError: no such column: emergency
```

Root cause: `server/src/playlist/builder.ts` used double-quoted SQL literals such as `type="emergency"` and `status="ready"`. In this SQLite/runtime combination, those were interpreted as identifiers, not string values.

### Fix

- Converted playlist media resolution queries to parameterized SQL.
- Covered direct media lookup, episode media lookup, program media lookup, emergency fallback lookup, and gap filler lookup.

**File modified:**
- `server/src/playlist/builder.ts`

### Test Added

Added `server/src/__tests__/playlistBuilder.test.ts`.

The test creates a temporary SQLite DB, imports a schedule, validates it, publishes it, and builds the daily playlist. It verifies:

- no `SqliteError` occurs
- a scheduled program resolves to a real ready program media file
- a filler slot with no direct media uses emergency fallback
- the daily playlist JSON file is written

### Verification Results

```text
npm test --workspace=server -- --runInBand
Test Suites: 5 passed, 5 total
Tests: 19 passed, 19 total

npm exec --workspace=server -- tsc --noEmit
0 errors

npm exec --workspace=web -- tsc --noEmit
0 errors

npm run build
server tsc: ok
web tsc && vite build: ok on local Node v24.13.0
```

Note: the same full build under the local portable Node v20.11.1 fails in the web Vite/PostCSS step because `web/postcss.config.js` uses ESM syntax without `"type": "module"` in `web/package.json`. That is outside this one-blocker playlist fix and was not changed here.

### Short Smoke Result

Ran a local API smoke on port 3001 with a fresh test DB:

1. `POST /api/media/scan`
2. `POST /api/media/programs`
3. Linked `program-1.mp4` test media to the created program in the smoke DB
4. `POST /api/schedules/import`
5. `POST /api/schedules/validate/:id`
6. `POST /api/schedules/publish/:id`
7. `POST /api/schedules/playlist/build/2026-05-15`
8. `GET /api/schedules/playlist/2026-05-15`

Result:

```text
IMPORT itemCount=2
VALIDATE isValid=true errors=0 warnings=0
PUBLISH ok=true
BUILD ok=true itemCount=51
ASSERT_REAL_PROGRAM_COUNT=1
ASSERT_EMERGENCY_BACKFILL_COUNT=1
```

Conclusion: playlist build now succeeds from the published schedule and includes a real scheduled program item, not emergency-only output.

---

## Round E - Node 20 Web Build Compatibility

**Branch:** `fix/pre-smoke-critical-blockers`
**Date:** 2026-05-15

### Problem

`npm run build` passed on the local Node v24 runtime, but failed on Node v20.11.1 during the web build because `web/postcss.config.js` used ESM syntax without `"type": "module"` in `web/package.json`.

### Fix

Converted `web/postcss.config.js` to CommonJS `module.exports`, keeping the existing Tailwind/PostCSS behavior unchanged.

**File modified:**
- `web/postcss.config.js`

### Verification Results on Node v20.11.1

```text
npm test --workspace=server -- --runInBand
npm exec --workspace=server -- tsc --noEmit
npm exec --workspace=web -- tsc --noEmit
npm run build
```

Result: all commands pass on Node v20.11.1.
