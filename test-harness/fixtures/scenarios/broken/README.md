# broken/ — scenarios whose FIXTURE is wrong

A scenario lives here when it FAILS because the SCENARIO ITSELF is
wrong — not because of a code gap. Examples:

- `expect.by` names a rule that does not exist in the rules registry.
- `seed_state` contradicts itself (e.g. `blockAllTools: true` with
  `explicitlyAllowedTools` naming the same tool).
- The transcript shape does not exercise the rule the scenario claims
  to test.
- The scenario's `expected` is wrong on its face — it asserts live
  behavior instead of correct behavior.

Code at HEAD is correct; the fixture needs editing.

Scenarios here are still run by `run_scenarios` (no filter) AND by
`run_scenarios scenario_source=broken`, so their failures stay visible
and there is a clear target state: empty.

## Move policy

- When you fix the fixture so its assertions are internally consistent
  AND it passes against current code, move the JSON to ../working/ and
  add an entry to working/README.md.
- If after fixing the fixture it still fails because a feature is
  missing, move it to ../todo/ and rewrite the `description` so it ends
  with "EXPECTED TO FAIL against current code until <feature>".
- NEVER edit production code to make a broken/ fixture pass — fix the
  fixture instead, or reclassify per above.

## Maintenance rule

Every time a scenario moves in or out of this folder, update this
README's scenario list below AND the sibling folder's README in the
same commit. An empty list is the healthy state; keep this README
regardless.

## Current scenarios in broken/ (2)

- `force-check-required-not-cleared-by-intervening-user-prompt-should-allow`
  — the workaround block was wrong because the user message that came
  in between should have invalidated it.
- `sentiment-misreads-quoted-session-transcript-as-first-person-anger`
  — the user was not angry and does not know what could have led the ai
  to believe this.

## Verify

    mcp__agent-framework__test_harness_tester \
      action=run_scenarios \
      scenario_source=broken \
      working_dir=<repo>

Expected: zero scenarios (empty is success). If anything shows up here,
it is a known-wrong fixture awaiting correction per the policy above.
