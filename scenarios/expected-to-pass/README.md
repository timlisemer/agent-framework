Fixtures here describe behavior the framework implements consistently. Every
fixture in this folder should pass on repeated full `scenario_tester` runs.

A run with `expectation_reality: "non-deterministic"` is a regression or flake
signal. Re-run before moving; if results disagree, move the fixture to
`non-deterministic/`. If it fails consistently, move it to
`expected-to-fail/`.

## Recent Changes

2026-06-17 five full scenario sweeps:

- Ran the committed scenario union five times through `scenario_tester`: 95
  total scenarios per run. Aggregate results were 84/95, 83/95, 83/95, 84/95,
  and 82/95 passing.
- Moved consistently failing fixtures to `expected-to-fail/`:
  `appeal-overturns-tool-approve-deny-when-user-literally-named-just-build`,
  `appeal-overturns-tool-approve-deny-when-user-named-bash-command-with-flags`,
  `implementer-launch-after-plan-approved-blocked-by-stale-plan5-intent-should-allow`,
  `sentiment-agent-resets-anger-after-calm-directive`, and
  `sentiment-misreads-quoted-session-transcript-as-first-person-anger`.
- Moved nondeterministic fixtures to `non-deterministic/`:
  `labeler-blocked-after-user-says-i-am-not-angry`,
  `prediction-block-denies-edit-after-requested-fontconfig-repro-should-allow`,
  and `tool-approve-plan-validation-misfires-on-plan-content-substrings`.
- This folder now contains 79 committed fixtures.

2026-06-13 three full scenario sweeps:

- Ran the full scenario union three times through `scenario_tester`:
  119 total scenarios per run, including 87 committed fixtures in this folder,
  6 in `expected-to-fail/`, 4 in `non-deterministic/`, and 22 home scenarios.
  Aggregate results were 91/119, 93/119, and 92/119 passing.
- Promoted stable passing scenarios from `expected-to-fail/`:
  `confirm-quickconfirm-omits-required-extra-context-should-deny.json`,
  `drift-block-misclassifies-shell-redirect-as-workaround-escalation.json`,
  `prediction-block-denies-edit-after-requested-fontconfig-repro-should-allow`,
  and `stop-memory-answer-after-completed-task-should-pass.json`.
- Promoted stable passing scenarios from `non-deterministic/`:
  `implementer-launch-after-plan-approved-blocked-by-stale-plan5-intent-should-allow`,
  `sentiment-misreads-quoted-session-transcript-as-first-person-anger`, and
  `tool-approve-plan-validation-misfires-on-plan-content-substrings`.
- Demoted `stop-response-check-misses-ai-claiming-errors-pre-existing.json` to
  `non-deterministic/` after it passed two full runs and failed one full run.
- Promoted two fixed prediction identity scenarios from `expected-to-fail/`.
- Promoted two newly fixed scenarios from `expected-to-fail`: one for scenario
  labeler authorization under stale anger, and one for legitimate multi-region
  same-file edits.

2026-05-30 Stop prior-error remediation coverage:

- Added `stop-prior-planfile-remediation-refusal-should-block.json` for the regression where prior `validate_plan` feedback told the assistant to edit a named planfile directly, but the assistant stopped by arguing that active Plan Mode or higher-level write restrictions prevented the required file edit. The fixture proves the Stop hook blocks through transcript-derived prior actionable feedback.

2026-05-19 scenario reclassification after three full scenario sweeps:

- Promoted newly stable passing scenarios from `expected-to-fail/`:
  `appeal-overturns-tool-approve-deny-when-user-named-bash-command-with-flags`,
  `drift-free-edit-post-warning.json`, and
  `tool-approve-plan-validation-misfires-on-node-substring.json`.
- Promoted newly stable passing scenarios from `non-deterministic/`:
  `sentiment-agent-resets-anger-after-calm-directive` and
  `sentiment-mood-relief-resets.json`.
- Moved newly consistent regressions out to `expected-to-fail/`:
  `prediction-context-stale-read-intent-blocks-just-build-after-explicit-reminder-should-allow.json`.
- Moved nondeterministic scenarios out to `non-deterministic/`:
  `implementer-launch-after-plan-approved-blocked-by-stale-plan5-intent-should-allow`
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

- `stop-response-check-misses-ai-claiming-errors-pre-existing.json` was promoted from `expected-to-fail/` after repeated deterministic passing runs, then moved to `non-deterministic/` on 2026-06-13 after a new three-run sweep showed a flake.
- `codex-respond-first-misses-text-before-parallel-tools-should-allow.json` and `codex-respond-first-misses-raspberrypi-bootloader-captured-text-before-tools-should-allow.json` were promoted after transcript assistant grouping started collapsing adjacent assistant entries into one logical turn.
- `bash-implied-log-inspection-journalctl-should-allow.json` was promoted after prediction-block stopped demanding a second Bash authorization when the latest user message already implied Bash.
