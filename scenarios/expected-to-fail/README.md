Fixtures here describe behavior the framework does not yet implement, or
known regressions that currently fail consistently. Every fixture in this
folder is expected to fail on repeated full `scenario_tester` runs.

A run with `expectation_reality: "expected-to-pass"` indicates the feature
landed or the regression recovered; promote to `expected-to-pass/` after
repeated confirmation. If repeated runs disagree, move the fixture to
`non-deterministic/`.

## Recent Changes

2026-05-19 scenario reclassification after three full scenario sweeps:

- Moved newly consistent expected-pass regression into this folder:
  `prediction-context-stale-read-intent-blocks-just-build-after-explicit-reminder-should-allow.json`.
- Promoted newly stable passing scenarios out to `expected-to-pass/`:
  `appeal-overturns-tool-approve-deny-when-user-named-bash-command-with-flags.json`,
  `drift-free-edit-post-warning.json`, and
  `tool-approve-plan-validation-misfires-on-node-substring.json`.
- Moved nondeterministic scenario out to `non-deterministic/`:
  `sentiment-misreads-quoted-session-transcript-as-first-person-anger.json`.

2026-05-17 Codex subagent respond-first detection:

- Promoted `codex-subagent-respond-first-misses-commentary-before-tools-after-update-plan-should-allow.json` out to `expected-to-pass/` after Codex subagent visible commentary and intervening `function_call_output` no longer make respond-first miss assistant text before the firing tool call.

Historical reclassification notes:

- Demoted stable expected-to-pass regressions into this folder on 2026-05-13:
  `appeal-upholds-tool-approve-deny-when-user-named-different-action.json`,
  `appeal-upholds-tool-approve-deny-when-user-only-said-go-ahead.json`,
  `bash-cd-cat-head-chain-blocked-by-tool-approve-should-deny.json`,
  `bash-npx-tsc-blocked-wrong-reason.json`,
  `codex-apply-patch-angry-explicit-edit-should-allow.json`,
  `codex-force-check-uses-codex-wire-name.json`,
  `plan-validate-emits-wrong-remediation-for-ellipsis-in-plan-text-should-deny-with-strip-ellipses-message.json`,
  `read-unasked-file-instead-of-doing-task-should-deny.json`,
  `sentiment-explicit-forbid-push.json`, and
  `tool-approve-fails-to-block-cd-cat-head-bash-violations.json`.
- Moved stable failing nondeterministic fixtures into this folder on 2026-05-13:
  `gate-cites-stale-plan3-intent-after-skill-was-already-loaded-and-plan-consolidated-should-allow.json`
  and `plan3-agent-blocked-by-mood-after-frustrated-slash-invocation-should-allow.json`.
- `stop-response-check-misses-ai-claiming-errors-pre-existing.json` and
  `bash-implied-log-inspection-journalctl-should-allow.json` were promoted out
  after their fixes landed.
