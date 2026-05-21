# Publish/Activate Workflow Plan

## Scope

This plan defines the scheduler publish and activation workflow that should exist before any schedule can become active. It is design-only and does not introduce playout, playlist materialization, cursor mutation, DNS changes, OBS changes, or production broadcast behavior.

## Core Principles

- Drafts remain editable review objects and are never active by default.
- Only a server-validated draft with `validation_status = draft_valid` and no validation errors can be published.
- Publishing creates an immutable schedule version.
- Activation is separate from publishing and only marks one published schedule as active in the database.
- Activation must not start playout, push a stream, materialize playlists, or update media cursors.
- Playlist materialization and cursor mutation must remain separate explicit workflows.
- Every publish and activation attempt must be auditable.

## Proposed Data Model

### Published Schedules

Add a new published schedule table rather than reusing mutable draft rows.

Suggested fields:

- `id`
- `source_draft_id`
- `name`
- `status`, constrained to `published`
- `is_active`, default `0`
- `schedule_start_date`
- `schedule_end_date`
- `timezone`
- `source_excel_filename`
- `source_excel_sha256`
- `validation_summary_json`
- `validation_status`
- `validation_errors_json`
- `settings_json`
- `programs_json`
- `slots_json`
- `folder_matches_json`
- `issues_json`
- `schedule_preview_json`
- `published_by`
- `published_at`
- `created_at`

Published rows should be immutable after insertion. If changes are needed, publish a new version from a valid draft.

### Active Schedule State

Activation can be represented either by a single active row in the published schedules table or by a small `active_schedule_state` table. Prefer a state table if future rollback metadata needs to be explicit.

Suggested fields:

- `id`
- `published_schedule_id`
- `activated_by`
- `activated_at`
- `previous_published_schedule_id`
- `confirmation_text`
- `safety_check_summary_json`

The database should enforce at most one active published schedule. Activation should happen in a transaction.

### Audit Log

Use or extend the existing audit log pattern for:

- publish attempt
- publish success
- publish rejection
- activation attempt
- activation success
- activation rejection
- rollback activation

Audit details should include schedule IDs, user, timestamp, validation status, confirmation text presence, safety summary, and reason for rejection.

## Publish Workflow

### API

Recommended endpoints:

- `POST /api/scheduler-foundation/draft-schedules/:id/publish`
- `GET /api/scheduler-foundation/published-schedules`
- `GET /api/scheduler-foundation/published-schedules/:id`

### Server Checks

Publishing must require:

- Draft exists.
- Draft `status = draft`.
- Draft `is_active = 0`.
- Draft `validation_status = draft_valid`.
- Draft `validation_errors_json` is empty.
- Validation summary has zero errors.
- Date range is sane.
- Timezone is valid.
- Slot overlaps are not present.
- Source Excel SHA-256 is present and valid.

If any check fails, reject the publish request and write an audit entry. Do not create a partial published schedule.

### Publish Result

On success:

- Insert one immutable published schedule row.
- Copy the complete draft snapshot into the published row.
- Set `status = published`.
- Set `is_active = 0`.
- Record `published_at`, `published_by`, and `source_draft_id`.
- Return the published schedule ID and safety summary.

Publishing must not:

- activate the schedule
- materialize playlists
- start playout
- update cursors
- touch media files

## Activation Workflow

### API

Recommended endpoint:

- `POST /api/scheduler-foundation/published-schedules/:id/activate`

### Required Confirmation

Activation must require:

- Explicit confirmation flag.
- Published schedule ID in the path.
- Matching schedule ID in the request body.
- Typed confirmation text, for example `ACTIVATE SCHEDULE <schedule-id>`.
- Safety check summary shown to the user before submission.

The server must verify the typed confirmation exactly. The UI should make the user review the schedule name, date range, validation state, current active schedule, and what activation will not do.

### Server Checks

Activation must require:

- Published schedule exists.
- Published schedule has status `published`.
- Published schedule validation is clean.
- Published schedule date range is sane.
- No slot conflicts or validation errors.
- Confirmation text exactly matches the required phrase.
- Request body schedule ID matches the URL schedule ID.

### Activation Result

Activation should happen in one transaction:

- Mark previous active published schedule inactive, if any.
- Mark selected published schedule active.
- Write active schedule state row or audit metadata.
- Return current active schedule summary.

Activation must not:

- start playout
- create playlist files
- update cursor rows
- touch media files
- call ffmpeg or ffprobe
- change DNS or stream links

## UI Design

### Draft Review

The draft review screen should show publish eligibility. A Publish Draft action should appear only when:

- draft status is `draft`
- `is_active = false`
- `validation_status = draft_valid`
- validation errors are empty

If the draft is invalid, show the validation errors and do not expose a publish action.

### Publish Confirmation

The publish confirmation should show:

- draft ID
- draft name
- date range
- timezone
- slot count
- validation summary
- source Excel filename and hash
- safety summary

The confirmation copy must state that publish does not activate, materialize playlists, update cursors, start playout, or broadcast.

### Activation Confirmation

The activation confirmation should show:

- published schedule ID
- schedule name
- date range
- current active schedule
- previous active schedule that will be replaced
- validation summary
- safety checklist
- typed confirmation input

There should be no production playout/start-broadcast control in this workflow.

## Rollback Plan

Rollback should mean activating a previously published schedule, not editing the active schedule in place.

Recommended behavior:

- Keep published schedule versions immutable.
- Keep previous active schedule ID in activation audit details.
- Provide a rollback action only for previously published valid schedules.
- Require the same activation confirmation process for rollback.
- Write an audit entry naming both the old active schedule and the restored schedule.

Rollback must not:

- restore cursor state
- rebuild playlists
- start or stop playout
- touch media files

Any future cursor or playlist rollback should be designed separately.

## Safety Check Summary

Before publish and activation, the server should return or compute a safety summary:

- validation status
- validation error count
- warning count
- schedule date range
- timezone
- slot count
- overlap status
- draft or published schedule ID
- whether current request will activate
- whether current request will materialize playlists
- whether current request will update cursors
- whether current request will start playout
- whether current request will call ffmpeg

For publish, activation/materialization/cursors/playout/ffmpeg must all be false.

For activation, materialization/cursors/playout/ffmpeg must all be false, and activation must be the only true state-changing item.

## Risk Points

- Treating publish as activation would make review and rollout unsafe.
- Allowing invalid drafts to publish would undermine the hardening work.
- Updating cursors during activation would make rollback ambiguous.
- Materializing playlists during activation would couple two workflows that need separate validation.
- Missing audit records would make schedule changes hard to trace.
- Activation without typed confirmation could allow accidental schedule changes.

## Recommended Next Implementation Phase

Phase 9 should implement publish only:

- published schedule persistence
- publish API and read APIs
- immutable published schedule snapshot
- publish confirmation UI
- audit metadata
- tests proving publish does not activate, materialize playlists, update cursors, start playout, or touch media

Activation should remain unimplemented until the publish workflow is merged and separately approved.
