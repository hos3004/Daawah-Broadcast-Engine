# Playlist Materialization Plan

## Scope

This plan defines how an active published schedule should be converted into playlist artifacts in a test-only workflow. It is design-only and does not implement or run materialization, playout, broadcast, media scanning, ffmpeg, ffprobe, DNS changes, OBS changes, media writes, or cursor mutation.

## Safety Principles

- Materialization must be a separate workflow from publish and activation.
- The only valid input is the currently active published schedule.
- The first implementation must be dry-run capable and must default to dry-run behavior.
- Dry-run materialization must not mutate media cursors.
- Generated artifacts must be written only under the test checkout, never under media folders.
- The workflow must not start playout or broadcast.
- The workflow must not call ffmpeg or ffprobe.
- The workflow must not modify, rename, normalize, copy, link, or delete media files.
- Every run must produce an audit/report artifact with enough detail to review before any playout phase.

## Input

The materializer reads one active schedule from scheduler state:

- active published schedule ID
- immutable published schedule snapshot
- schedule date range
- timezone
- slots
- program metadata
- folder matches
- validation summary
- source Excel filename and hash

The materializer must reject the run if:

- no active schedule exists
- the active schedule cannot be read
- the published schedule is not immutable/read-only
- validation status is not clean
- validation summary contains errors or conflicts
- schedule date range is invalid
- timezone is invalid

## Output

All outputs must stay under the test checkout. Recommended root:

```text
/opt/daawah-broadcast-test/generated/playlists/
```

Recommended structure:

```text
/opt/daawah-broadcast-test/generated/playlists/<run-id>/
  manifest.json
  report.json
  report.md
  days/
    YYYY-MM-DD.json
```

Optional future ffconcat artifacts may be added later under the same run directory, but not in the first implementation unless separately approved:

```text
/opt/daawah-broadcast-test/generated/playlists/<run-id>/ffconcat/YYYY-MM-DD.ffconcat
```

## JSON Playlist Format

Each daily playlist JSON should include:

- `runId`
- `scheduleId`
- `date`
- `timezone`
- `generatedAt`
- `dryRun`
- `items`
- `summary`
- `warnings`
- `errors`

Each playlist item should include:

- `type`: `program`, `gap_filler`, or `emergency`
- `source`: schedule slot ID, folder match ID, or filler source ID
- `programKey`, if applicable
- `title`
- `absolutePath`
- `relativePath`
- `start`
- `end`
- `durationSeconds`
- `trimStartSeconds`
- `trimEndSeconds`
- `isTrimmed`
- `validationStatus`

The JSON format should be deterministic so a later verification step can compare repeated dry-runs.

## Gap Filler Integration

Gap filler selection should use the established professional sequence:

```text
main, seasonal, general, general, general
```

Rules:

- Fill positive gaps between scheduled items.
- Use only known ready filler candidates from registry-derived data or already validated metadata.
- Prefer dry-run cursor planning over persisted cursor mutation.
- In dry-run, compute the next cursor state in memory and include it in the report only.
- Support final filler trim so the last filler item can be shortened to fit the exact gap.
- Never create a negative-duration item.
- Never leave a gap unreported.
- If no suitable filler exists, record a warning or error depending on whether emergency fallback is available.

Emergency fallback should be designed as a last-resort source. The emergency root must exist and contain approved fallback media before any real playout readiness claim.

## Dry-Run Behavior

The first materialization API/CLI should support dry-run only unless a later phase explicitly approves writes of playlist artifacts. Dry-run must:

- read active schedule state
- compute day playlists
- compute gap filler plan
- validate media references
- write report artifacts only under `/opt/daawah-broadcast-test/generated/`
- not update cursors
- not activate, publish, or alter schedules
- not start playout
- not call ffmpeg or ffprobe
- not write inside `/srv/daawah/media`

If artifact writing is enabled in the dry-run phase, it must be limited to generated test output under:

```text
/opt/daawah-broadcast-test/generated/
```

## Validation

Before writing any playlist JSON, the materializer must validate:

- active schedule exists
- schedule status and validation status are clean
- every scheduled item resolves to a non-empty media reference
- every referenced media file exists, using read-only existence checks
- durations are known from trusted metadata
- no item has zero or negative duration
- no gap has negative duration
- no scheduled items overlap
- every item is inside the expected day boundary
- generated daily totals are sane
- gap filler rows are marked clearly
- final filler trim never produces a negative duration
- no playlist file path escapes the generated output root

Missing media should block materialization unless the design explicitly marks the run as report-only. Unknown durations should block playlist output because later playout cannot be timed safely without known durations.

## API / CLI Proposal

Recommended dry-run endpoint:

```text
POST /api/scheduler-foundation/active-schedule/materialize-playlists/dry-run
```

Recommended CLI:

```text
npm run materialize:playlists:dry-run --workspace=server
```

Both should require an active schedule and should produce the same validation and report format. The API should be admin-only. The CLI should print the output report path and exit non-zero if validation fails.

## Report

Every run should write:

- `report.json` for machine checks
- `report.md` for human review
- one `manifest.json` tying schedule ID, run ID, and generated files together

Report fields:

- run ID
- active schedule ID
- schedule name
- date range
- timezone
- source Excel filename and hash
- generated output root
- dry-run flag
- item count
- total scheduled duration
- total gap duration
- total filler duration
- emergency fallback count
- missing file count
- unknown duration count
- warnings
- errors
- planned cursor changes, in memory only
- safety summary

Safety summary must explicitly state:

- publish: false
- activate: false
- playlist artifacts used for playout: false
- cursor mutation: false
- ffmpeg: false
- ffprobe: false
- playout: false
- broadcast: false
- media modification: false

## Audit

The workflow should write an audit entry for each materialization dry-run attempt with:

- run ID
- active schedule ID
- user, if available
- timestamp
- validation result
- output report path
- errors/warnings count
- dry-run flag

Audit entries must not imply playout readiness unless validation is clean and the emergency fallback decision has been resolved.

## Failure Handling

On validation failure:

- do not write partial daily playlist files unless they are clearly marked invalid
- write a report explaining the failure
- return a non-zero CLI exit code or a non-2xx API status
- keep cursor state unchanged
- keep active schedule unchanged

On unexpected exceptions:

- fail closed
- write no playable artifacts
- include the exception summary in the report if a report can be written safely

## Recommended Phase 12 Implementation

The next implementation phase should add a dry-run materializer only:

- branch: `feature/playlist-materialization-dry-run`
- read active schedule
- generate JSON playlist artifacts under `/opt/daawah-broadcast-test/generated/`
- generate report artifacts
- validate all references and timing
- keep cursor changes in memory only
- add server tests with temp DB and temp generated output
- do not integrate with playout
- do not create ffconcat files unless separately approved

## Phase 12 Dry-Run Foundation

Implemented dry-run endpoints:

- `GET /api/scheduler-foundation/active-schedule`
- `POST /api/scheduler-foundation/playlist-materialization/dry-run`
- `GET /api/scheduler-foundation/playlist-materialization/runs`
- `GET /api/scheduler-foundation/playlist-materialization/runs/:id`

Dry-run output is constrained to:

```text
generated/playlists/<runId>/
```

Each run writes:

- `playlist.json`
- `report.json`
- `report.md`

The first dry-run foundation uses the active or selected published schedule snapshot only. It does not expand real media files unless that data is already safely available in the schedule snapshot. When expansion is not available, the run reports `MEDIA_FILE_EXPANSION_NOT_AVAILABLE`.

The dry-run foundation does not deploy, scan media, access `/srv/daawah/media`, call ffmpeg/ffprobe, start playout, broadcast, write production playlists, modify media files, or mutate cursors.
