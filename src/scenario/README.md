# Scenario System

The scenario system provides two complementary ways to exercise hook logic:

## Modules

| Module            | Purpose |
|-------------------|---------|
| `types.ts`        | Scenario schema, `validateScenario`, hook vocabularies |
| `runner.ts`       | Single-hook and fan-out scenario execution |
| `replay.ts`       | Full-session transcript replay |
| `validate.ts`     | Re-exports `validateScenario` / `validateReasonMustExpectation` |
| `capture.ts`      | Append-only JSONL log of hook-fire events (CapturePointer) |
| `snapshot.ts`     | Point-in-time state snapshots (StateSnapshot), written before each hook |
| `epoch.ts`        | Transcript-continuity boundaries; detects rewinding / compaction |
| `lifecycle.ts`    | Epoch-rotation side-effects (reset derived caches) |
| `materialize.ts`  | Reconstruct a Scenario from a capture pointer |
| `lib/`            | Shared harness, classifier, hook-runner, replay-types |

## Runner

`runner.ts` materializes a JSON scenario fixture into a temp JSONL transcript,
fires exactly one hook (or a fan-out batch), scores the result, and writes
`report-scenario.json`.

## Capture / Snapshot / Epoch Pipeline

Every hook fire appends a `CapturePointer` to `captures.jsonl` and a
`StateSnapshot` to `state-snapshots.jsonl`. Epoch boundaries (rewinds,
compactions) are tracked in `epochs.jsonl`. These files form an immutable
forensic audit trail.

Plan-mode and injected-context reproducibility use additional session sidecars:
- `plan-mode-state.json` stores the current plan-mode state used by hooks.
- `plan-mode-events.jsonl` records entered/exited transitions.
- `plans/<name>.md` stores named session planfiles for non-native adapters.
- `current-plan.json` points at the active file-backed plan descriptor.
- `plan-validation-status.json` caches exact-content plan validation results,
  keyed by resolved planfile path plus content hash. Explicit `validate_plan`
  MCP calls write this cache; plan-exit hooks now trust the populated planfile
  itself and only delegate validation when the hook must populate a missing or
  empty planfile from the extracted plan block.

Scenario and replay transcripts are written under their test-run cache
directory, and the shared session resolver treats that containing cache
directory as the session directory. The harness does not use a session-dir
environment override.
- `session-injections.jsonl` stores generic injected context records, including
  exact file-backed source content for planning-contract injections.

Captures include the hook's `permission_mode`, plan-mode transition metadata,
and injection seq/hash pointers. Snapshots include plan-mode state and
injection-log offset/hash metadata so materialized scenarios can replay from the
same prior sidecar state.

## Materialize

`materializeScenario(sessionDir, captureSeq)` reconstructs a `Scenario` from a
live session's capture pointer. Useful for converting observed regressions into
reproducible test fixtures.

For plan-mode context injections, materialization seeds the target hook's prior
`plan-mode-state.json`, writes captured file-backed sources through
`setup_files`, and adds injection/context-output expectations for records
referenced by the capture.

**Round-trip caveat**: UUIDs are not preserved through
materialization-then-replay. A replayed materialized scenario will have
different transcript UUIDs than the original session.

## Fixtures

Fixtures live under `scenarios/` at the repo root, organized into:
- `expected-to-pass/` — must pass on every CI run
- `fixture-bug/` — known flaky or broken scenarios
- `expected-to-fail/` — intentionally failing (documenting known gaps)
