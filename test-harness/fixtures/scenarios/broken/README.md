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

- `sentiment-agent-resets-anger-after-calm-directive` — SENTIMENT_AGENT
  on `UserPromptSubmit` returns mood=angry, trust=low and an intent
  paraphrase that does not contain the literal substring "scenario", so
  `must_not_have_mood`, `must_not_have_trust`, and `intent_must_contain`
  all fail. The fixture's prediction assertions are too strict for the
  agent's natural paraphrasing — re-tune the assertions (broaden mood
  set / drop the substring check) before re-promoting (demoted from
  working).
- `sentiment-misreads-quoted-session-transcript-as-first-person-anger`
  — SENTIMENT_AGENT correctly avoids `mood=angry` / `trust=low` for the
  quoted hostile transcript, but returns an empty intent string, so
  `intent_must_contain: "scenario"` fails. Fixture needs a looser intent
  assertion (or to drop it) before re-promoting (demoted from working).

## Verify

    mcp__agent-framework__test_harness_tester \
      action=run_scenarios \
      scenario_source=broken \
      working_dir=<repo>

Expected: zero scenarios (empty is success). If anything shows up here,
it is a known-wrong fixture awaiting correction per the policy above.
