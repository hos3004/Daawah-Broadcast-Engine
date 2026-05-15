# Daawah Broadcast Engine — Architecture

## Overview

Daawah Broadcast Engine is a cloud-native, 24/7 TV broadcast automation system designed to run entirely on a Linux VPS without OBS or a local machine. It ingests a media library, reads a 3-month schedule, generates pre-rendered overlays, and produces a continuous HLS/RTMP stream via FFmpeg.

---

## High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLOUD VPS                                     │
│                                                                      │
│  ┌─────────────────┐     ┌──────────────────┐    ┌────────────────┐ │
│  │  Admin Dashboard │────▶│   Backend API    │────▶│   SQLite DB    │ │
│  │  (React/Vite)   │◀────│  (Node/Express)  │    │               │ │
│  └─────────────────┘     └────────┬─────────┘    └────────────────┘ │
│                                   │                                  │
│                         ┌─────────▼──────────┐                      │
│                         │   Worker Processes  │                      │
│                         │  - Media Scanner   │                      │
│                         │  - Playlist Builder│                      │
│                         │  - Overlay Gen     │                      │
│                         └─────────┬──────────┘                      │
│                                   │                                  │
│                         ┌─────────▼──────────┐                      │
│                         │  FFmpeg Broadcast   │                      │
│                         │     Runner         │                      │
│                         │  [Base Video]      │                      │
│                         │  + [Logo WebM]     │                      │
│                         │  + [Ticker WebM]   │                      │
│                         │  + [NowPlaying PNG]│                      │
│                         └─────────┬──────────┘                      │
│                                   │                                  │
│                    ┌──────────────┴────────────┐                    │
│                    │                           │                    │
│              ┌─────▼──────┐           ┌────────▼──────┐            │
│              │  HLS Output │           │  RTMP Output  │            │
│              │ /var/www/   │           │  (optional)   │            │
│              │ html/hls/  │           └───────────────┘            │
│              └─────┬──────┘                                         │
│                    │                                                 │
│              ┌─────▼──────┐                                         │
│              │    Nginx   │                                         │
│              │  (public)  │                                         │
│              └────────────┘                                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Architecture

### 1. Media Library (`/media/library`)

Directory layout on VPS:
```
/media/library/
  programs/
    show-name/
      episode-001.mp4
      episode-002.mp4
  fillers/
  emergency/
  promos/
  quran/
```

### 2. Media Scanner

- Runs on demand (API trigger or startup)
- Uses `ffprobe` to extract: `duration`, `codec`, `resolution`, `fps`, `audio_codec`, `bitrate`, `pixel_format`
- Assigns file status:
  - `ready` — meets broadcast profile (H.264, AAC, yuv420p, correct fps)
  - `needs_transcode` — valid file but not broadcast-ready
  - `missing` — was in DB but file no longer exists
  - `invalid` — ffprobe failed
  - `duplicate` — same content hash already in library
  - `unsupported` — codec not supported

### 3. Broadcast-Ready Pipeline

Required profile:
```
video_codec:    libx264
audio_codec:    aac
pixel_format:   yuv420p
resolution:     1280x720 (configurable)
fps:            25 (configurable, fixed)
audio_rate:     48000 Hz
audio_channels: 2
```

Files not meeting profile are flagged `needs_transcode`. Transcode jobs are created manually from the dashboard — never automatic.

### 4. Schedule Manager

Imports 3-month schedule as JSON/CSV/XLSX. Each item:
```json
{
  "date": "2025-01-01",
  "start_time": "06:00",
  "type": "program",
  "program_id": "program-uuid",
  "episode_id": "episode-uuid",
  "title": "برنامج كذا",
  "expected_duration": 1800,
  "duration_policy": "exact"
}
```

Validation before publishing:
- Missing files
- Time conflicts
- Gaps
- Episodes not ready
- Unknown durations
- Unintended repeats

### 5. Daily Playlist Builder

- Runs at 23:00 to build next day's playlist
- Output: `data/playlists/YYYY-MM-DD.json`
- Pre-materialized — not calculated during broadcast
- Contains: full timeline with `current`, `next`, `lookahead[3+]`
- Emergency items fill any remaining gaps

### 6. Overlay Asset System

All overlays are **pre-rendered files** — no live overlay rendering during broadcast.

#### 6.1 Logo (`assets/overlays/logo/logo-loop.webm`)
- Source: PNG sequence in `assets/logo-source/`
- Converted to VP9 WebM with alpha (`yuva420p`)
- Loopable
- Conversion triggered manually from dashboard

#### 6.2 Daily Ticker (`assets/overlays/tickers/YYYY-MM-DD.webm`)
- Content: "تشاهدون اليوم: برنامج كذا 06:00 | ..."
- Generated from daily playlist
- **Arabic text rendered using node-canvas** (not FFmpeg drawtext)
- Scrolling animation created with FFmpeg scroll filter on pre-rendered PNG
- WebM with alpha channel, loopable

#### 6.3 Now Playing Lower Third (`assets/overlays/now-playing/{event_id}.png`)
- One PNG per schedule item
- Arabic text rendered with node-canvas
- Transparent background
- Shown for first 10 seconds of program via FFmpeg overlay with fade

### 7. FFmpeg Broadcast Runner

Process management:
- Managed as child process with health monitoring
- Reads `data/playlists/YYYY-MM-DD.json`
- Builds `concat` input list dynamically
- Overlays: logo + ticker + now-playing (per event)
- On crash: auto-restart with safe delay
- On missing file: switches to emergency item
- Logs written to `/var/log/daawah-broadcast/ffmpeg.log`

HLS output:
```
/var/www/html/hls/
  stream.m3u8
  segN.ts
```

### 8. Emergency Fallback

- `/media/emergency/` — always populated with Quran/fillers
- Emergency playlist loops indefinitely when triggered
- Triggered by:
  - FFmpeg crash (after N retries)
  - Missing required file
  - Invalid daily playlist
  - Manual trigger from dashboard
- System never shows black screen

### 9. Admin Dashboard

React SPA served via Nginx at `/admin`.
Protected by:
- Login (email + password, bcrypt)
- HTTP-only JWT cookies
- CSRF token on state-changing requests
- Rate limiting on login

Roles: `admin`, `editor`, `operator`, `viewer`

### 10. API Layer

Express REST API listening on `127.0.0.1:3000` (never publicly exposed).
Nginx proxies `/api/` and `/admin/` from external port 443/80.

Public endpoints only:
- `GET /health`
- HLS stream via `/hls/` (direct Nginx serve)

### 11. Database

SQLite (WAL mode) for MVP. Schema structured for PostgreSQL migration.
ORM: raw SQL with typed queries via `better-sqlite3`.

Key tables: `users`, `programs`, `episodes`, `media_files`, `schedules`, `schedule_items`, `daily_playlists`, `playlist_items`, `overlay_assets`, `broadcast_runs`, `broadcast_events`, `transcode_jobs`, `audit_logs`, `settings`

### 12. Realtime Updates

WebSocket server on same port as API.
Events:
- `now_playing` — current item changed
- `broadcast_status` — FFmpeg state change
- `scan_progress` — media scan progress
- `overlay_progress` — overlay generation progress
- `validation_result` — schedule validation complete
- `alert` — system alert (disk, stream stale, etc.)

---

## Security Model

| Layer | Mechanism |
|---|---|
| API binding | 127.0.0.1 only |
| TLS termination | Nginx + Let's Encrypt |
| Admin access | Cloudflare Access or Nginx basic auth + JWT |
| Auth | bcrypt passwords, HTTP-only JWT cookies |
| CSRF | Double-submit cookie or token header |
| Upload safety | Extension + MIME validation, path traversal prevention |
| Rate limiting | express-rate-limit on auth endpoints |
| Secrets | `.env` file, never in repo |

---

## Data Flow

```
Schedule Import → Validate → Publish
                                │
                        Daily Playlist Builder (23:00 cron)
                                │
                         YYYY-MM-DD.json
                                │
                    Overlay Generator
                    (ticker + now-playing per event)
                                │
                        FFmpeg Runner reads playlist
                        + overlays per event
                                │
                         HLS segments → Nginx → CDN/Viewers
```

---

## Broadcast Profile

| Parameter | Value |
|---|---|
| Video codec | H.264 (libx264) |
| Audio codec | AAC |
| Pixel format | yuv420p |
| Resolution | 1280×720 (720p) |
| Frame rate | 25 fps (fixed) |
| Audio sample rate | 48000 Hz |
| Audio channels | 2 (stereo) |
| HLS segment duration | 4 seconds |
| HLS list size | 10 segments |

---

## Directory Layout on VPS

```
/opt/daawah-broadcast/          ← application
/media/library/                 ← source media
/media/emergency/               ← emergency content
/var/www/html/hls/              ← HLS output (Nginx)
/var/log/daawah-broadcast/      ← logs
/etc/daawah-broadcast/          ← config
```
