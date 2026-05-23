# Test Playout Plan

## Purpose

This document defines the design for an isolated test playout phase and tracks
the control-panel implementation. The current control-panel path supports both
prepare-only plans and explicitly confirmed short FFmpeg test runs, while
keeping output constrained to `generated/test-playout`.

The goal is to prove that a future playout runner can consume approved test
playlist artifacts without touching the live broadcast path, old OBS workflow,
production stream settings, DNS, or media folders.

## Scope

In scope:

- Test-only playout design and implementation.
- Local file output.
- Localhost-only HLS output.
- Safety gates before execution.
- Logging, monitoring, stop, cleanup, and rollback requirements.

Out of scope:

- Production playlist materialization.
- Live stream output.
- DNS, stream key, OBS, or broadcast server changes.

## Test-Only Playout Concept

Test playout must be isolated from production broadcast operations. A future
test runner should read a test playlist artifact produced under the test
checkout, process only approved test media inputs, and write only to a test
output target.

The runner must not:

- Start live broadcast.
- Push to RTMP.
- Use production stream keys.
- Write to media folders.
- Mutate playout cursors.
- Alter active schedule state.
- Generate production playlists.
- Use the old OBS workflow.
- Touch the old broadcast server.

The runner should have an explicit test mode that is visible in logs, output
paths, reports, and UI/status surfaces.

## Allowed Output Targets

Only these output targets are allowed for a future test execution:

1. Local file output under a test-only directory.
   - Example design path:
     `/opt/daawah-broadcast-test/generated/playout-tests/<runId>/output.mp4`
   - The output file must not be referenced by live broadcast tooling.
   - The output directory must be under `/opt/daawah-broadcast-test/generated/`.

2. Localhost-only HLS test path.
   - Example design path:
     `/opt/daawah-broadcast-test/generated/playout-tests/<runId>/hls/`
   - Any preview server must bind only to `127.0.0.1`.
   - HLS artifacts must not be copied or linked to production web roots.

## Forbidden Output Targets

The following targets are always forbidden during test playout:

- Live RTMP endpoints.
- Production stream keys.
- DNS-backed live URLs.
- Public stream URLs.
- Old OBS workflow.
- Old broadcast server.
- Any destination outside the new server test checkout.
- Any destination inside media folders.

## Required Inputs

A future test playout run may proceed only after these inputs are available and
approved:

- Approved active schedule state on the new server test checkout.
- Dry-run playlist artifacts generated under:
  `/opt/daawah-broadcast-test/generated/playlists/`
- A specific dry-run `runId` selected for the test.
- QC-passed media references only in a later implementation phase.
- Explicit Hossam approval for the specific test run.

Until QC-passed media inputs are available, test playout should use a tiny
synthetic playlist or explicitly approved sample assets in a test-only location.

## Test Phases

### Phase A: Tiny Synthetic Playlist

Purpose:

- Validate process lifecycle, logs, output path containment, and stop handling.

Expected duration:

- A few short synthetic items.
- No production schedule dependency.
- No media folder access.

Required result:

- Test output is created only under the approved generated test path.
- Process exits cleanly.
- Logs contain current item, next item, timing, and exit status.

### Phase B: Short Controlled Sample

Purpose:

- Validate realistic item transitions and timing behavior.

Expected duration:

- 10 to 20 minutes.

Required result:

- Drift is measured.
- Expected versus actual item duration is reported.
- Output remains local file or localhost-only HLS.
- No stream keys, live URLs, OBS, or broadcast services are used.

### Phase C: Longer Soak Test

Purpose:

- Validate stability over a longer controlled run after the short sample passes.

Expected duration:

- To be decided after Phase B review.

Required result:

- CPU, RAM, disk usage, HLS segment count, error rate, and drift remain within
  approved limits.

## Safety Gates

Before any future test playout execution, the operator must confirm:

- Hossam has explicitly approved the specific test run.
- The server IP is `144.91.124.112`.
- The checkout path is `/opt/daawah-broadcast-test`.
- The selected output target is local file or localhost-only HLS.
- No production URL is present in the command or configuration.
- No production stream key is present in the command or configuration.
- No live RTMP endpoint is present.
- No old OBS workflow is involved.
- No old broadcast server is involved.
- No media folder path is used as an output path.
- The run writes only under `/opt/daawah-broadcast-test/generated/`.
- Cursor mutation is disabled.
- Production playlist materialization is not part of the run.

If any gate fails, the test must not start.

## Logging Requirements

Each future test playout run must produce a structured log and a markdown report.

The log must include:

- Run ID.
- Start time.
- Stop time.
- Input playlist ID or path.
- Output target type.
- Output path.
- Current item.
- Next item.
- Item start time.
- Item end time.
- Expected duration.
- Actual duration.
- Drift.
- FFmpeg exit status.
- Errors and warnings.
- Safety summary.

When FFmpeg exits non-zero, the control panel should preserve the raw log and
also classify common failures as:

- `MISSING_FILE`
- `DTS_PTS`
- `DECODER_ERROR`
- `HLS_OUTPUT_STALE`

The markdown report must include:

- Files/items played.
- Total expected duration.
- Total actual duration.
- Maximum drift.
- Average drift.
- Exit status.
- CPU/RAM summary.
- Disk usage summary.
- Confirmation that no production output was touched.

## Monitoring Requirements

During a test run, monitoring must show:

- Process status.
- PID.
- Current item.
- Next item.
- Elapsed time.
- Remaining time.
- CPU usage.
- RAM usage.
- Disk usage for the test output directory.
- Error count.
- Last heartbeat time.

For localhost-only HLS tests, monitoring must also show:

- HLS output directory.
- Segment count.
- Manifest/index age.
- Stale threshold.
- HLS healthy/stale state.

The isolated runner treats HLS as unhealthy if `index.m3u8` exists but has not
updated within `HLS_STALE_THRESHOLD` seconds. The default threshold is 30
seconds. If this happens during an isolated run, FFmpeg is stopped and the run
records `HLS_OUTPUT_STALE`.

## Stop And Kill Procedure

The future implementation must provide a safe stop flow.

Process discovery:

- Find only the test playout process for the selected run ID.
- Match by a dedicated test-run marker, not by broad process names alone.
- Confirm the process command contains no production URL or stream key.

Graceful stop:

- Send the supported graceful stop signal or control request.
- Wait for a bounded shutdown timeout.
- Record final item, final timestamp, and exit status.

Force kill:

- Use only after graceful stop fails.
- Target only the confirmed test-run PID.
- Record that force kill was used.
- Record remaining artifacts.

Cleanup:

- Remove or archive only the selected test output directory under:
  `/opt/daawah-broadcast-test/generated/playout-tests/<runId>/`
- Do not remove playlist dry-run artifacts unless explicitly approved.
- Do not remove reports unless explicitly approved.
- Do not touch media folders.

## Rollback

Because test playout must not touch production, rollback is limited to test
cleanup:

- Stop the test process.
- Verify no test process remains.
- Remove test output artifacts only if approved.
- Preserve logs and reports unless Hossam asks to clean them.
- Do not rollback production because production is not changed.
- Do not alter active schedules, published schedules, or cursors.

## Future Implementation Notes

Any later implementation PR must keep these concerns separate:

- Test playout runner.
- Production playout readiness.
- Playlist materialization.
- Cursor mutation.
- Broadcast output.
- Monitoring UI.

The first implementation should support a dry, local-only test path before any
real media playout is considered.

## Phase 14A/14B Control-Panel Harness

Phase 14A implemented a plan-only harness foundation. Phase 14B adds explicit
isolated execution with typed confirmation and status/log artifact reads.

Implemented endpoints:

- `POST /api/scheduler-foundation/test-playout/plans`
- `GET /api/scheduler-foundation/test-playout/plans`
- `GET /api/scheduler-foundation/test-playout/plans/:id`
- `POST /api/scheduler-foundation/test-playout/runs`
- `GET /api/scheduler-foundation/test-playout/runs`
- `GET /api/scheduler-foundation/test-playout/runs/:id`
- `GET /api/scheduler-foundation/test-playout/runs/:id/logs`

The prepare endpoint requires:

- `confirmPrepareOnly=true`
- `sourcePlaylistPath` under `generated/playlists/<runId>/playlist.json`
- `outputMode` of `local_file` or `localhost_hls`
- `durationLimitSeconds` no greater than 1200 seconds

The harness stores planned output targets only under:

- `generated/test-playout/<planId>/output.mp4`
- `generated/test-playout/<planId>/hls/`

The generated plan command preview is for review only. Execution requires
`confirmExecution=true` and exact confirmation text:

```text
RUN ISOLATED TEST PLAYOUT
```

The execution route spawns FFmpeg only for the isolated run, uses concat filter
instead of concat demuxer for mixed MP4 input, writes only under
`generated/test-playout`, and records status/report/log artifacts. It does not
push RTMP, use stream keys, mutate cursors, or broadcast.

Rejected targets include:

- `rtmp://`
- `rtmps://`
- HTTP/HTTPS live URLs
- Output outside `generated/test-playout`
- Stream-key fields or stream-key-looking values
- `/srv/daawah/media` paths
- Old OBS paths
- Production paths

## Explicit Non-Actions

These restrictions remain true for the control-panel test path:

- No ffprobe command execution.
- No scan.
- No broadcast.
- No stream key handling.
- No DNS or live URL changes.
- No production materialization.
- No cursor mutation.
