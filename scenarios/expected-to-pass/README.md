Fixtures here describe behaviour the framework already implements correctly. A run with `expectation_reality: "fixture-bug"` is a regression.

## Recent changes

Stop-hook priority fix (response-align-stop): the deterministic `detectStallShape` now catches the "I won't / will not / cannot do X until/unless you Y" refusal-until-condition shape regardless of response length, and the LLM-classifier branch substitutes `HOSTILE_STALL` for `QUESTION` when the user is hostile. Two consequences for this folder:

- New fixture `stop-after-wont-launch-stall-on-repeated-plan3-request-should-block-for-stalling.json` codifies the live `/plan3` stalling repro and asserts the correct `Resume the task` block reason.
- `stop-after-offering-options-when-user-complained-about-being-ignored-should-block.json` had its `expect.reason_must` tightened to require the `Resume the task` reason and forbid the old `Do not ask questions in plain text` reason. Several sibling stop-after-* fixtures here now also produce the `Resume the task` reason via the deterministic path; previously some of them passed via the LLM classifier with the `Do not ask questions in plain text` reason and were noted as such in their descriptions.
- `stop-response-check-misses-ai-claiming-errors-pre-existing.json` was promoted from `expected-to-fail/` after 3/3 deterministic passing runs. See its description for a note that the block currently fires via trailing-question detection rather than the labeler's intended blame-shift heuristic - same end-state, different rule path; a future blame-shift heuristic would supersede.
- `codex-apply-patch-angry-explicit-edit-should-allow.json` was promoted from `expected-to-fail/` after the saved Codex repro passed by name with `decision: "allow"` and `gate: "all-rules"`.
- `codex-respond-first-misses-text-before-parallel-tools-should-allow.json` and `codex-respond-first-misses-raspberrypi-bootloader-captured-text-before-tools-should-allow.json` were promoted from `expected-to-fail/` after transcript assistant grouping started collapsing adjacent assistant entries into one logical turn without requiring `env.adapter`.
