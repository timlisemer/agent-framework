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
compactions) are tracked in `epochs.jsonl`. These three files form an
immutable forensic audit trail.

## Materialize

`materializeScenario(sessionDir, captureSeq)` reconstructs a `Scenario` from a
live session's capture pointer. Useful for converting observed regressions into
reproducible test fixtures.

**Round-trip caveat**: UUIDs are not preserved through
materialization-then-replay. A replayed materialized scenario will have
different transcript UUIDs than the original session.

## Fixtures

Fixtures live under `scenarios/` at the repo root, organized into:
- `expected-to-pass/` — must pass on every CI run
- `fixture-bug/` — known flaky or broken scenarios
- `expected-to-fail/` — intentionally failing (documenting known gaps)
