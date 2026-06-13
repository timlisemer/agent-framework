Fixtures here describe behavior that is currently nondeterministic. They are
not stable enough for `expected-to-pass/`, and they are not consistently broken
enough for `expected-to-fail/`.

A run with `expectation_reality: "expected-to-pass"` is a promotion signal only
after repeated runs show stable passing behavior. A run with
`expectation_reality: "non-deterministic"` confirms at least one failure in a
folder where flakes are expected.

## Move Policy

- Move to `expected-to-pass/` after repeated full `scenario_tester` runs pass
  consistently.
- Move to `expected-to-fail/` after repeated full `scenario_tester` runs fail
  consistently and the scenario still describes a real unimplemented behavior.
- Keep here when repeated runs disagree on pass/fail, rule attribution, or
  `expectation_reality`.

## Recent Changes

2026-06-13 three full scenario sweeps:

- Ran the full scenario union three times through `scenario_tester`:
  119 total scenarios per run, including 6 committed fixtures in this folder.
  Aggregate results were 91/119, 93/119, and 92/119 passing.
- Promoted stable passing scenarios to `expected-to-pass/`:
  `implementer-launch-after-plan-approved-blocked-by-stale-plan5-intent-should-allow.json`,
  `sentiment-misreads-quoted-session-transcript-as-first-person-anger.json`, and
  `tool-approve-plan-validation-misfires-on-plan-content-substrings.json`.
- Kept the offering-options stop fixture here after fresh back-to-back runs
  disagreed on whether the required remediation substring appeared.
- Moved `stop-response-check-misses-ai-claiming-errors-pre-existing.json` here
  from `expected-to-pass/` after it passed two full runs and failed one full run.
- Current nondeterministic fixtures are
  `gate-blocks-outside-project-edit-after-implicit-fix-authorization.json`,
  `respond-first-skips-slash-command.json`, and
  the offering-options stop fixture, plus
  `stop-response-check-misses-ai-claiming-errors-pre-existing.json`.

2026-05-19 rename and reclassification after three full scenario sweeps:

- Renamed this source to `non-deterministic/` across the
  runner, tester, MCP schema, docs, and fixture references.
- Kept nondeterministic fixtures here:
  `gate-blocks-outside-project-edit-after-implicit-fix-authorization.json`,
  the offering-options stop fixture,
  and `tool-approve-plan-validation-misfires-on-plan-content-substrings.json`.
- Moved newly nondeterministic scenarios here:
  `implementer-launch-after-plan-approved-blocked-by-stale-plan5-intent-should-allow.json`,
  `respond-first-skips-slash-command.json`, and
  `sentiment-misreads-quoted-session-transcript-as-first-person-anger.json`.
- Promoted newly stable passing scenarios to `expected-to-pass/`:
  `sentiment-agent-resets-anger-after-calm-directive.json` and
  `sentiment-mood-relief-resets.json`.

Historical notes:

- 2026-05-15: moved three nondeterministic fixtures here from
  `expected-to-pass/`: `gate-blocks-outside-project-edit-after-implicit-fix-authorization.json`,
  the offering-options stop fixture,
  and `tool-approve-plan-validation-misfires-on-plan-content-substrings.json`.
- 2026-05-13: `sentiment-agent-resets-anger-after-calm-directive.json` and
  `sentiment-mood-relief-resets.json` were tracked here as nondeterministic
  before the 2026-05-19 runs stabilized.
