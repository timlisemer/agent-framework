# todo/ — scenarios that codify UNIMPLEMENTED features

A scenario lives here when it FAILS because the feature the scenario
codifies is not yet implemented in code. Every scenario here currently
fails against HEAD; each one's `description` explicitly states
"EXPECTED TO FAIL against current code until <feature>".

The scenario is the executable spec for a feature that has been
identified but not yet built. Running `todo/` scenarios prints the
current feature-TODO backlog with concrete reproductions.

## Move policy

When the missing feature lands and the scenario passes:

1. Re-run the scenario 2-3 times to rule out LLM flap (REPRODUCTION-
   NOTES.md section "Determinism" — several here use LLM-backed rules).
2. Update `status: "todo"` markers / "EXPECTED TO FAIL" sentence in the
   `description` field to remove the expected-to-fail framing.
3. Move the JSON to ../working/.
4. Update BOTH ../working/README.md (add the scenario) and this README
   (remove the scenario).

If a `todo/` fixture's failure turns out to be fixture-side (the
assertion was wrong, not the code), move it to ../broken/ instead.

## Maintenance rule

Every time a scenario moves in or out of this folder, update this
README's scenario list below AND the sibling folder's README in the
same commit. Scenarios added here must include the literal phrase
"EXPECTED TO FAIL against current code" in their description — that
phrase is the signal the failure is intended pending code.

## Current scenarios in todo/ (1)

- `plan-validate-emits-wrong-remediation-for-ellipsis-in-plan-text-should-deny-with-strip-ellipses-message`
  — exercises the new `reason_must` harness assertion: the deny for
  `node -e 'console.log("…tail…")'` must NOT contain the bash `tail`
  remediation "Use Read tool with offset" and MUST contain the
  legitimate "node not covered by just check" message. The upstream
  `command-patterns.ts` fix scoping cat/head/tail to executable
  segment heads has landed, but the appeal LLM (tool-approve is
  appealable) consistently overturns the deterministic fastDeny in
  this scenario's transcript — 3/3 runs return all-rules allow with
  no flap, so the `reason_must` assertion is never reached. Promotion
  blocker: add `env.llm_stubs = { "tool-appeal": "UPHOLD" }` using
  the new harness stubbing mechanism to pin the appeal verdict
  deterministically.

## Verify

    mcp__agent-framework__test_harness_tester \
      action=run_scenarios \
      scenario_source=todo \
      working_dir=<repo>

Expected: most/all fail. A consistent pass here means the feature
landed — verify 2-3 re-runs, then promote per the policy above.
