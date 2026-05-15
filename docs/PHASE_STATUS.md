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

### Remaining Issues

None in this round. Next rounds:
- Round B: Emergency media scanning + scanner multi-path
- Round C: FFmpeg runner minimum live fixes (-re, HLS cleanup, preflight, day rollover)
