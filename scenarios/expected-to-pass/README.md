Fixtures here describe behavior the framework implements consistently. Every
fixture in this folder should pass on repeated full `scenario_tester` runs.

A run with `expectation_reality: "non-deterministic"` is a regression or flake
signal. Re-run before moving; if results disagree, move the fixture to
`non-deterministic/`. If it fails consistently, move it to
`expected-to-fail/`.

## Recent Changes

2026-05-19 scenario reclassification after three full scenario sweeps:

- Promoted newly stable passing scenarios from `expected-to-fail/`:
  `appeal-overturns-tool-approve-deny-when-user-named-bash-command-with-flags.json`,
  `drift-free-edit-post-warning.json`, and
  `tool-approve-plan-validation-misfires-on-node-substring.json`.
- Promoted newly stable passing scenarios from `non-deterministic/`:
  `sentiment-agent-resets-anger-after-calm-directive.json` and
  `sentiment-mood-relief-resets.json`.
- Moved newly consistent regressions out to `expected-to-fail/`:
  `prediction-context-stale-read-intent-blocks-just-build-after-explicit-reminder-should-allow.json`.
- Moved nondeterministic scenarios out to `non-deterministic/`:
  `implementer-launch-after-plan-approved-blocked-by-stale-plan5-intent-should-allow.json`
  and `respond-first-skips-slash-command.json`.

2026-05-18 scenario cleanup and new regressions:

- Added `bash-rg-escaped-quote-pattern-should-allow.json` for the escaped-double-quote Bash parser regression where `routes/config` inside a quoted `rg` pattern was misread as a shell segment.
- Added `prediction-block-latest-user-message-move-reuse-quote-should-allow.json` and `prediction-block-latest-user-message-plan-approval-code-quote-should-allow.json` for regressions where cached angry snippets overrode the latest quote-stripped user turn.
- Added `stop-inline-proposed-plan-missing-plans-md-structure-should-block.json` for plain-text plan approval in plan mode; Stop now blocks and tells the assistant to write the plan file and use ExitPlanMode.
- Removed scenario-level fake LLM outputs from committed fixtures. Scenario fixtures should exercise the normal hook/provider path; if a scenario only passes by forcing a fake agent answer, fix the rule path or the fixture shape instead.
- Updated `codex-cargo-fmt-check-parallel-batch-allowed-before-later-deny.json` to expect the current deterministic `blacklist` gate for check-routed formatter commands.

2026-05-17 updates:

- Added `full-user-message-edit-intent-after-snippet-boundary-should-allow.json` for the regression where the display snippet is ambiguous but the full transcript user message contains an explicit edit request after the old snippet boundary.
- Added `stop-after-apology-promises-helper-search-without-action-should-block.json` for the live helper-search repro where the assistant stopped without doing the promised search.
- Promoted `codex-subagent-respond-first-misses-commentary-before-tools-after-update-plan-should-allow.json` after Codex transcript normalization started treating subagent visible commentary as assistant-authored text.

Older promotion notes retained for context:

- `stop-response-check-misses-ai-claiming-errors-pre-existing.json` was promoted from `expected-to-fail/` after repeated deterministic passing runs. Its block currently fires through trailing-question detection rather than a dedicated blame-shift heuristic.
- `codex-respond-first-misses-text-before-parallel-tools-should-allow.json` and `codex-respond-first-misses-raspberrypi-bootloader-captured-text-before-tools-should-allow.json` were promoted after transcript assistant grouping started collapsing adjacent assistant entries into one logical turn.
- `bash-implied-log-inspection-journalctl-should-allow.json` was promoted after prediction-block stopped demanding a second Bash authorization when the latest user message already implied Bash.
