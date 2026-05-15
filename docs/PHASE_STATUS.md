# Phase Status — Production Blockers Round 1

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
