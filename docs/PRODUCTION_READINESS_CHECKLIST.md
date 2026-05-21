# Production Readiness Checklist

This checklist is the hard gate before any public RTMP, public HLS, DNS-backed
live URL, stream key, OBS workflow, or production broadcast path is used.

## Current Decision

Production broadcast is not approved yet.

The approved next environment target is still isolated test playout only:

- playlist artifacts under `generated/playlists`
- playout outputs under `generated/test-playout`
- no RTMP
- no public/live URLs
- no stream keys
- no DNS changes
- no old OBS/server path

## Completed Gates

- Test checkout can install, test, and build with Node 20.
- Test playout plan-only rejects RTMP, live URLs, stream keys, media paths, and
  output outside `generated/test-playout`.
- File-level playlist expansion exists.
- Test-only playlist materialization writes `playlist.json`, `report.json`,
  `report.md`, and `playlist.ffconcat` only when expansion is fully valid.
- Materialization fails closed when media is missing, files are missing on disk,
  durations are unknown, overlaps exist, or gaps remain unfilled.
- Isolated test playout execution requires explicit confirmation text:
  `RUN ISOLATED TEST PLAYOUT`.
- Isolated test playout writes `run.json`, `status.json`, `ffmpeg.log`, and
  `report.md`.
- Local file and localhost HLS outputs are constrained to
  `generated/test-playout`.

## Emergency Root Decision

The emergency root is approved as:

```text
/srv/daawah/media/emergency
```

It must contain at least:

- an emergency loop
- a technical issue filler
- a safe channel identity fallback

This root is required before production approval. Do not use public broadcast
paths until emergency readiness reports at least one ready emergency file that
exists on disk.

## Required Before Production Approval

- Active published schedule selected.
- File-level materialization completed with `mediaExpansionAvailable=true`.
- `playlist.ffconcat` generated from the same materialization run.
- All media files exist on disk.
- All media durations are known from QC metadata.
- Gap filler and emergency fallback are ready.
- Local file playout test completed.
- Localhost/private HLS test completed.
- Monitoring artifacts reviewed: current item, next item, heartbeat, FFmpeg
  status, output health, errors, memory, and output size/segments.
- Soak tests completed in order: 2 hours, 6 hours, 24 hours.
- Rollback/kill procedure tested.
- Explicit human production approval recorded after the above.
