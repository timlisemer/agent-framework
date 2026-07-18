Use `scenario_tester` for canonical fixture work. Call `help` first, then use
`list_fixtures`, `read_fixture`, `run_fixture`, `run_fixtures`,
`inspect_report`, or `materialize_scenario`. Always pass the current checkout
as `working_dir`.

Fixtures always dispatch canonical commands directly through the runtime.
Deterministic effects are reserved for journal, reducer, recovery, and replay
mechanics. Rule-behavior fixtures use `effects.mode: "live"`, dispatch canonical
host commands such as `hostUserPromptSubmitted`, `hostPreToolUse`, or
`hostStopped`, and assert the resulting rule evaluations and workflow state.
Use `snapshotArrayMinLength` when a behavior contract requires proof that the
live rule pipeline emitted evaluations. Committed behavior groups reject
deterministic effects in the fixture-purity check.
Validate adapter wire translation and output separately with adapter tests.

Investigate failures in the canonical runtime, reducer, rules, adapters, or
fixture code. Fix root causes; do not weaken expectations or rewrite
a fixture merely to make a failure disappear. Manual user feedback is
append-only run data and must never be converted into fixture expectations.
