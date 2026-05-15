Fixtures here describe behaviour that is INTENTIONALLY broken — the fixture itself is the bug demonstration. A run with `expectation_reality: "expected-to-pass"` indicates the underlying bug got fixed; promote to `expected-to-pass/`.

## Recent changes

2026-05-15 scenario reclassification at commit `4e4b851`:

- Moved three nondeterministic fixtures here from `expected-to-pass/`: `gate-blocks-outside-project-edit-after-implicit-fix-authorization.json`, `stop-after-offering-options-when-user-complained-about-being-ignored-should-block.json`, and `tool-approve-plan-validation-misfires-on-plan-content-substrings.json`.
- `codex-cargo-fmt-check-parallel-batch-allowed-before-later-deny.json` now lives in `expected-to-pass/` after the check-routed formatter policy fix.

2026-05-13 scenario reclassification after three full `scenario_tester` runs:

- Kept nondeterministic fixture `sentiment-agent-resets-anger-after-calm-directive.json` here after a fail/pass/pass pattern.
- Moved nondeterministic `sentiment-mood-relief-resets.json` here from `expected-to-pass/` after a pass/fail/fail pattern.
- Promoted stable passing `respond-first-skips-slash-command.json` to `expected-to-pass/`.
- Demoted stable failing fixtures to `expected-to-fail/`: `gate-cites-stale-plan3-intent-after-skill-was-already-loaded-and-plan-consolidated-should-allow.json`, `plan3-agent-blocked-by-mood-after-frustrated-slash-invocation-should-allow.json`, and `sentiment-misreads-quoted-session-transcript-as-first-person-anger.json`.
