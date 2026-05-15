# Implementation Plan — Daawah Broadcast Engine

## Phases

---

### Phase 1 — Foundation ✅ (current)

**Goal:** Working project skeleton with DB, config, and basic HTTP server.

Tasks:
- [x] Create monorepo structure
- [x] Root `package.json` with workspaces
- [x] Server: TypeScript strict, Express, better-sqlite3
- [x] DB schema with all tables
- [x] Config loader (`.env` → typed config)
- [x] Basic health endpoint

Acceptance:
- `npm install` succeeds
- `npm run dev` starts server on port 3000
- `GET /health` returns `{ ok: true }`

---

### Phase 2 — Media Scanner

**Goal:** Scan a media folder, extract metadata, store in DB, assign statuses.

Tasks:
- [ ] `ffprobe` wrapper (TypeScript, Windows + Linux)
- [ ] `MediaScanner` class: walk dirs, probe files, upsert DB
- [ ] Status assignment logic (ready/needs_transcode/missing/invalid)
- [ ] Transcode job creator (manual trigger only)
- [ ] `POST /api/media/scan` endpoint
- [ ] WebSocket progress events

Acceptance:
- Scan sample media folder
- Status correctly assigned
- Broadcast-ready files identified

---

### Phase 3 — Schedule Manager

**Goal:** Import, validate, and publish a 3-month schedule.

Tasks:
- [ ] JSON schedule importer
- [ ] CSV schedule importer
- [ ] Schedule validator (conflicts, gaps, missing files, unknown durations)
- [ ] Publish flow (mark schedule as active)
- [ ] `POST /api/schedules/import`
- [ ] `POST /api/schedules/validate`
- [ ] `POST /api/schedules/publish`
- [ ] Sample schedule files (JSON + CSV)

Acceptance:
- Import 7-day sample schedule
- Validator reports conflicts correctly
- Publish marks schedule active

---

### Phase 4 — Daily Playlist Builder

**Goal:** Build pre-materialized daily playlist from schedule.

Tasks:
- [ ] `PlaylistBuilder` class
- [ ] Gap filler logic (emergency/filler items)
- [ ] Build for specific date
- [ ] Lookahead (3+ items)
- [ ] `data/playlists/YYYY-MM-DD.json` output
- [ ] Cron: build next-day playlist at 23:00
- [ ] `POST /api/playlists/build/:date`
- [ ] `GET /api/playlists/:date`
- [ ] `GET /api/now` + `GET /api/next`

Acceptance:
- Build 7-day sample playlist
- `GET /api/now` returns current item
- Gap filled with emergency items

---

### Phase 5 — Overlay Generator

**Goal:** Pre-render all overlay assets for a day.

Tasks:
- [ ] PNG sequence → WebM alpha logo converter (FFmpeg)
- [ ] Ticker generator: node-canvas Arabic text → PNG → scrolling WebM
- [ ] Now-playing lower third: node-canvas → PNG per event
- [ ] Config-driven templates (font, colors, sizes)
- [ ] `POST /api/overlays/logo/convert`
- [ ] `POST /api/overlays/ticker/generate/:date`
- [ ] `POST /api/overlays/now-playing/generate/:playlistItemId`
- [ ] Preview endpoints

Acceptance:
- Generate ticker WebM with Arabic RTL text
- Generate now-playing PNG for a show
- Convert logo PNG sequence to WebM alpha

---

### Phase 6 — FFmpeg Broadcast Runner

**Goal:** 24/7 FFmpeg process producing HLS output.

Tasks:
- [ ] `BroadcastRunner` process manager
- [ ] Playlist-to-FFmpeg concat command builder
- [ ] Overlay compositor (logo + ticker + now-playing)
- [ ] HLS output (`/var/www/html/hls/`)
- [ ] RTMP output (optional, config-driven)
- [ ] Auto-restart on crash (with backoff)
- [ ] Emergency fallback on file missing
- [ ] FFmpeg log capture + rotation
- [ ] HLS stale detection
- [ ] `POST /api/broadcast/start|stop|restart|emergency`
- [ ] `GET /api/broadcast/status`

Acceptance:
- Start broadcast produces HLS segments
- Kill FFmpeg → auto-restarts within 5 seconds
- Remove test file → emergency playlist activated

---

### Phase 7 — Auth & Security

**Goal:** Secure all admin endpoints.

Tasks:
- [ ] Users table with bcrypt passwords
- [ ] POST /api/auth/login (rate-limited)
- [ ] POST /api/auth/logout
- [ ] GET /api/auth/me
- [ ] JWT in HTTP-only cookie
- [ ] Auth middleware for all `/api/*` routes
- [ ] RBAC: admin/editor/operator/viewer
- [ ] Audit log on all state-changing actions
- [ ] Upload validation (extension + MIME + path traversal)
- [ ] Rate limiting

Acceptance:
- Unauthenticated request returns 401
- Login with wrong password returns 401
- Upload `../../etc/passwd` is rejected

---

### Phase 8 — Admin Dashboard

**Goal:** React frontend for all operations.

Pages:
- [ ] Login
- [ ] Dashboard (now playing, stream status, disk/CPU)
- [ ] Media Library (files, status, scan button)
- [ ] Schedule (import, validate, publish, 3-month view)
- [ ] Overlays (generate ticker, now-playing, logo)
- [ ] Broadcast Control (start/stop/restart/emergency)
- [ ] Logs (ffmpeg, system, audit)

Acceptance:
- All pages load
- Dashboard shows live now-playing via WebSocket
- Can trigger scan and see progress
- Can import + validate + publish schedule

---

### Phase 9 — Monitoring & Alerts

**Goal:** Health checks and optional Telegram alerts.

Tasks:
- [ ] `GET /health` — full health object
- [ ] HLS stale detector
- [ ] Disk usage monitor
- [ ] Telegram alert integration (optional, config-driven)
- [ ] Alert types: FFmpeg stopped, missing file, disk >85%, HLS stale

Acceptance:
- `/health` returns proper status
- Telegram alert sent when FFmpeg stops (if configured)

---

### Phase 10 — Deployment & Docs

**Goal:** Production-ready deployment artifacts.

Tasks:
- [ ] `systemd` service files
- [ ] Nginx config (HLS public + admin protected)
- [ ] `docker-compose.yml` (optional)
- [ ] `README.md` with VPS setup guide (Ubuntu 22.04/24.04)
- [ ] `docs/DEPLOYMENT.md`
- [ ] `docs/SECURITY.md`
- [ ] `docs/SCHEDULE_FORMAT.md`
- [ ] `docs/OVERLAYS.md`
- [ ] `.env.example`
- [ ] Test scripts for all acceptance criteria

---

## Current Status

| Phase | Status | Notes |
|---|---|---|
| 1 — Foundation | 🔄 In Progress | Setting up now |
| 2 — Media Scanner | ⏳ Pending | |
| 3 — Schedule Manager | ⏳ Pending | |
| 4 — Playlist Builder | ⏳ Pending | |
| 5 — Overlay Generator | ⏳ Pending | |
| 6 — FFmpeg Runner | ⏳ Pending | |
| 7 — Auth & Security | ⏳ Pending | |
| 8 — Admin Dashboard | ⏳ Pending | |
| 9 — Monitoring | ⏳ Pending | |
| 10 — Deployment | ⏳ Pending | |

---

## Technology Stack

| Concern | Choice | Reason |
|---|---|---|
| Server runtime | Node.js 20 LTS | Wide VPS support, async I/O |
| Language | TypeScript strict | Type safety across entire codebase |
| HTTP framework | Express 4 | Mature, large ecosystem |
| Database | SQLite (better-sqlite3) | Zero-setup MVP, WAL mode |
| Auth | bcryptjs + jsonwebtoken | Industry standard |
| Frontend | React 18 + Vite + TailwindCSS | Fast DX, small bundles |
| Arabic text render | node-canvas + Arabic font | Correct Arabic shaping without FFmpeg |
| Overlay encoding | FFmpeg | Pre-render pipeline |
| Broadcast | FFmpeg | Industry standard |
| HLS delivery | Nginx | Efficient static file serving |
| WebSocket | ws | Lightweight |
| Schedule import | csv-parse + xlsx | CSV + XLSX support |
| Process management | Node child_process | Direct control |
