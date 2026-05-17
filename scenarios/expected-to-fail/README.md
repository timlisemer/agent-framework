Fixtures here describe behaviour the framework does not yet implement. A run with `expectation_reality: "expected-to-pass"` indicates the feature landed; promote to `expected-to-pass/`.

## Recent changes

2026-05-17 Codex subagent respond-first detection:

- Promoted `codex-subagent-respond-first-misses-commentary-before-tools-after-update-plan-should-allow.json` out to `expected-to-pass/` after Codex subagent visible commentary and intervening `function_call_output` no longer make respond-first miss assistant text before the firing tool call.

2026-05-13 scenario reclassification after three full `scenario_tester` runs:

- Demoted stable expected-to-pass regressions into this folder: `appeal-overturns-tool-approve-deny-when-user-named-bash-command-with-flags.json`, `appeal-upholds-tool-approve-deny-when-user-named-different-action.json`, `appeal-upholds-tool-approve-deny-when-user-only-said-go-ahead.json`, `bash-cd-cat-head-chain-blocked-by-tool-approve-should-deny.json`, `bash-npx-tsc-blocked-wrong-reason.json`, `codex-apply-patch-angry-explicit-edit-should-allow.json`, `codex-force-check-uses-codex-wire-name.json`, `drift-free-edit-post-warning.json`, `plan-validate-emits-wrong-remediation-for-ellipsis-in-plan-text-should-deny-with-strip-ellipses-message.json`, `read-unasked-file-instead-of-doing-task-should-deny.json`, `sentiment-explicit-forbid-push.json`, and `tool-approve-fails-to-block-cd-cat-head-bash-violations.json`.
- Moved stable failing fixture-bugs into this folder: `gate-cites-stale-plan3-intent-after-skill-was-already-loaded-and-plan-consolidated-should-allow.json`, `plan3-agent-blocked-by-mood-after-frustrated-slash-invocation-should-allow.json`, and `sentiment-misreads-quoted-session-transcript-as-first-person-anger.json`.
- Promoted stable successes out to `expected-to-pass/`: `all-rules-allows-bash-immediately-after-user-interrupted-prior-tool.json`, `prediction-block-denies-tools-when-user-angrily-demands-action.json`, `stop-after-repeated-partial-state-defense-should-block.json`, and `stop-response-check-misses-ai-claiming-fully-blocked.json`.

`stop-response-check-misses-ai-claiming-errors-pre-existing.json` was promoted out to `expected-to-pass/` after the Stop-hook priority fix made it block deterministically across 3 runs. The block now fires through trailing-question detection rather than a dedicated blame-shift heuristic, but the test as written (`expected: "block"`, `by: "response-align-stop"`) passes; see the promoted fixture's description for the caveat.

`bash-implied-log-inspection-journalctl-should-allow.json` was promoted out to `expected-to-pass/` after prediction-block stopped treating an already-implied Bash request as needing another authorization.
