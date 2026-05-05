Fixtures here describe behaviour the framework does not yet implement. A run with `expectation_reality: "expected-to-pass"` indicates the feature landed; promote to `expected-to-pass/`.

## Recent changes

`stop-response-check-misses-ai-claiming-errors-pre-existing.json` was promoted out to `expected-to-pass/` after the Stop-hook priority fix made it block deterministically across 3 runs. The block now fires through trailing-question detection rather than a dedicated blame-shift heuristic, but the test as written (`expected: "block"`, `by: "response-align-stop"`) passes; see the promoted fixture's description for the caveat.

`codex-apply-patch-angry-explicit-edit-should-allow.json` was promoted out to `expected-to-pass/` after edit-class authorization started treating Codex `apply_patch` as covered by `Edit`/`Write` permissions.

`codex-respond-first-misses-text-before-parallel-tools-should-allow.json` has no `env.adapter` so it runs through default-adapter materialization, where the text and tool_use lines carry distinct `msg_id`s and `buildAssistantGroups` splits them. Promote when default-adapter handling collapses adjacent assistant entries into one turn.
