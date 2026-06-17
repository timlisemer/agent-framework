Fixtures here describe behavior the framework does not yet implement, or
known regressions that currently fail consistently. Every fixture in this
folder is expected to fail on repeated full `scenario_tester` runs.

A run with `expectation_reality: "expected-to-pass"` indicates the feature
landed or the regression recovered; promote to `expected-to-pass/` after
repeated confirmation. If repeated runs disagree, move the fixture to
`non-deterministic/`.

## Similarity Groups

### Command policy / tool-approve attribution

- `plan-validate-emits-wrong-remediation-for-ellipsis-in-plan-text-should-deny-with-strip-ellipses-message.json`
- `tool-approve-fails-to-block-cd-cat-head-bash-violations.json`

These scenarios cover Bash/tool policy denials firing with the correct rule and
actionable reason. Typecheck commands should point to the check MCP, inline
`node -e` should not receive bogus `tail` remediation, and dense `cd` / `cat` /
`head` commands should be caught by tool-approve.

### Stale intent / workflow progression

- `prediction-context-stale-read-intent-blocks-just-build-after-explicit-reminder-should-allow.json`

This scenario covers stale cached intent or already-satisfied prerequisites
being treated as still blocking after the workflow moved forward.

### Explicit user prohibition state

- `sentiment-explicit-forbid-push.json`

This scenario covers preserving and enforcing an explicit prediction block for
`git push` after the user says not to push.

## Recent Changes

2026-06-13 three full scenario sweeps:

- Ran the full scenario union three times through `scenario_tester`:
  119 total scenarios per run before reclassification; after the promotions
  below, this folder retained 4 committed fixtures.
  Aggregate results were 91/119, 93/119, and 92/119 passing.
- Promoted stable passing scenarios to `expected-to-pass/`:
  `confirm-quickconfirm-omits-required-extra-context-should-deny.json`,
  `drift-block-misclassifies-shell-redirect-as-workaround-escalation.json`,
  `prediction-block-denies-edit-after-requested-fontconfig-repro-should-allow.json`,
  and `stop-memory-answer-after-completed-task-should-pass.json`.
- Kept the offering-options stop fixture in `non-deterministic/` after
  back-to-back runs disagreed on whether the required remediation substring
  appeared.
- Removed README-only references to
  `stop-grouped-expected-fail-scenarios-after-user-asked-should-pass.json`;
  no matching fixture exists in this folder.
- Promoted two fixed prediction identity scenarios to `expected-to-pass/`.
- Promoted two additional fixed scenarios to `expected-to-pass/`: one for
  scenario labeler authorization under stale anger, and one for legitimate
  multi-region same-file edits.

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
  `plan-validate-emits-wrong-remediation-for-ellipsis-in-plan-text-should-deny-with-strip-ellipses-message.json`,
  `sentiment-explicit-forbid-push.json`, and
  `tool-approve-fails-to-block-cd-cat-head-bash-violations.json`.
- `stop-response-check-misses-ai-claiming-errors-pre-existing.json` and
  `bash-implied-log-inspection-journalctl-should-allow.json` were promoted out
  after their fixes landed.
