Fixtures here describe behaviour the framework already implements correctly. A run with `expectation_reality: "fixture-bug"` is a regression.

## Recent changes

2026-05-18 scenario cleanup and new regressions:

- Added `bash-rg-escaped-quote-pattern-should-allow.json` for the escaped-double-quote Bash parser regression where `routes/config` inside a quoted `rg` pattern was misread as a shell segment.
- Added `stop-inline-proposed-plan-missing-plans-md-structure-should-block.json` for plain-text plan approval in plan mode; Stop now blocks and tells the assistant to write the plan file and use ExitPlanMode.
- Removed scenario-level fake LLM outputs from committed fixtures. Scenario fixtures should exercise the normal hook/provider path; if a scenario only passes by forcing a fake agent answer, fix the rule path or the fixture shape instead.
- Updated `codex-cargo-fmt-check-parallel-batch-allowed-before-later-deny.json` to expect the current deterministic `blacklist` gate for check-routed formatter commands.

2026-05-17 Full user-message intent logic:

- Added `full-user-message-edit-intent-after-snippet-boundary-should-allow.json` for the regression where the display snippet is ambiguous but the full transcript user message contains an explicit edit request after the old snippet boundary. The fixture asserts that logic uses the full user message while keeping displayed evidence short.

2026-05-17 Stop-hook corrective-promise stall detection:

- Added `stop-after-apology-promises-helper-search-without-action-should-block.json` for the live helper-search repro where the assistant apologized, named the exact requested search, promised to stay on topic, and stopped without doing the search. The expected block reason is the deterministic `Resume the task` feedback.

2026-05-17 Codex subagent respond-first detection:

- Promoted `codex-subagent-respond-first-misses-commentary-before-tools-after-update-plan-should-allow.json` after Codex transcript normalization started treating subagent `event_msg` `agent_message` commentary as assistant-authored text and current-turn grouping stopped treating `function_call_output` as a fresh human prompt.

2026-05-16 Codex plan-mode detection:

- Added `codex-default-mode-ignores-stale-plan-sidecar-should-allow.json`.
- Added `codex-stop-inline-plan-uses-stored-plan-mode-when-marker-missed.json` to cover Codex Stop inline-plan handling with current plan mode expressed via `env.codex_collaboration_mode`.
- Codex plan-mode detection treats current hook input and transcript collaboration-mode markers as authoritative, even when the latest collaboration marker is outside the recent transcript tail; when no Codex collaboration marker is found, hooks may fall back to stored `plan-mode-state.json`.
- Stale `plan-mode-state.json` must not make explicit default-mode Codex edits look like plan-mode edits.
- New Codex scenarios should prefer `env.codex_collaboration_mode` or `env.permission_mode` to express current mode. Do not seed `plan_mode_state` to make Codex appear to be in plan mode; sidecar state is only fixture context for stale-state regressions.

2026-05-15 scenario reclassification at commit `4e4b851`:

- Promoted `codex-cargo-fmt-check-parallel-batch-allowed-before-later-deny.json` into this folder after generic check-routed formatter policy made it pass as `deny` by `blacklist`.
- Moved nondeterministic fixtures to `fixture-bug/`: `gate-blocks-outside-project-edit-after-implicit-fix-authorization.json`, `stop-after-offering-options-when-user-complained-about-being-ignored-should-block.json`, and `tool-approve-plan-validation-misfires-on-plan-content-substrings.json`.

2026-05-13 scenario reclassification after three full `scenario_tester` runs:

- Promoted stable expected-fail successes: `all-rules-allows-bash-immediately-after-user-interrupted-prior-tool.json`, `prediction-block-denies-tools-when-user-angrily-demands-action.json`, `stop-after-repeated-partial-state-defense-should-block.json`, and `stop-response-check-misses-ai-claiming-fully-blocked.json`.
- Promoted stable passing fixture-bug: `respond-first-skips-slash-command.json`.
- Demoted stable regressions to `expected-to-fail/`: `appeal-overturns-tool-approve-deny-when-user-named-bash-command-with-flags.json`, `appeal-upholds-tool-approve-deny-when-user-named-different-action.json`, `appeal-upholds-tool-approve-deny-when-user-only-said-go-ahead.json`, `bash-cd-cat-head-chain-blocked-by-tool-approve-should-deny.json`, `bash-npx-tsc-blocked-wrong-reason.json`, `codex-apply-patch-angry-explicit-edit-should-allow.json`, `codex-force-check-uses-codex-wire-name.json`, `drift-free-edit-post-warning.json`, `plan-validate-emits-wrong-remediation-for-ellipsis-in-plan-text-should-deny-with-strip-ellipses-message.json`, `read-unasked-file-instead-of-doing-task-should-deny.json`, `sentiment-explicit-forbid-push.json`, and `tool-approve-fails-to-block-cd-cat-head-bash-violations.json`.
- Moved nondeterministic `sentiment-mood-relief-resets.json` to `fixture-bug/` after a pass/fail/fail pattern across the same three runs.

Stop-hook priority fix (response-align-stop): the deterministic `detectStallShape` now catches the "I won't / will not / cannot do X until/unless you Y" refusal-until-condition shape regardless of response length, and the LLM-classifier branch substitutes `HOSTILE_STALL` for `QUESTION` when the user is hostile. Two consequences for this folder:

- New fixture `stop-after-wont-launch-stall-on-repeated-plan3-request-should-block-for-stalling.json` codifies the live `/plan3` stalling repro and asserts the correct `Resume the task` block reason.
- `stop-after-offering-options-when-user-complained-about-being-ignored-should-block.json` had its `expect.reason_must` tightened to require the `Resume the task` reason and forbid the old `Do not ask questions in plain text` reason. Several sibling stop-after-* fixtures here now also produce the `Resume the task` reason via the deterministic path; previously some of them passed via the LLM classifier with the `Do not ask questions in plain text` reason and were noted as such in their descriptions.
- `stop-response-check-misses-ai-claiming-errors-pre-existing.json` was promoted from `expected-to-fail/` after 3/3 deterministic passing runs. See its description for a note that the block currently fires via trailing-question detection rather than the labeler's intended blame-shift heuristic - same end-state, different rule path; a future blame-shift heuristic would supersede.
- `codex-respond-first-misses-text-before-parallel-tools-should-allow.json` and `codex-respond-first-misses-raspberrypi-bootloader-captured-text-before-tools-should-allow.json` were promoted from `expected-to-fail/` after transcript assistant grouping started collapsing adjacent assistant entries into one logical turn without requiring `env.adapter`.
- `bash-implied-log-inspection-journalctl-should-allow.json` was promoted from `expected-to-fail/` after prediction-block stopped demanding a second Bash authorization when the latest user message already implied Bash. The fix preserves separate Bash safety checks in blacklist/tool-approve.
- `prediction-block-uses-stale-angry-intent-for-explicit-rm-should-allow.json` was promoted from `expected-to-fail/` after prediction-block started honoring the latest explicit `rm` instruction for simple Bash `rm <path>` commands instead of using an older angry prediction snippet as the authorization basis.
