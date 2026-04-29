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

- `tool-approve-plan-validation-misfires-on-plan-content-substrings-EXPECTED-TO-FAIL` — captures live repro from session `e1d1591d-5fa8-4a47-9bd3-4b7f24a1bf69` (slug `please-find-out-what-delegated-dragonfly`): the `tool-approve` plan-validation rule substring-matched two phrases inside a ~52KB ExitPlanMode plan markdown ("split off fixed" inside a Rust parser-strategy bullet about variable-length `togglegroup` events; "gates the merge." inside the AGS sequencing recommendation) against denial-cache reasons, producing a `Plan validation failed: ... -> Use Read tool with offset. ... -> You must run mcp__agent-framework__check` blocking error. Expected: `allow` — plan markdown is documentation, not a live tool invocation. Pending fix: plan-validation should stop fuzz-matching prose against denial-cache reasons (or only flag substrings that look like live tool invocations).

(`plan-validate-emits-wrong-remediation-for-ellipsis-in-plan-text-should-deny-with-strip-ellipses-message` was promoted to working/ on 2026-04-29 after the appeal-LLM tightening in `src/utils/agent-configs.ts` and the denied-command-token surfacing in `src/agents/hooks/tool-appeal.ts` made the deterministic fastDeny stick on real LLM calls.)

## Verify

    mcp__agent-framework__test_harness_tester \
      action=run_scenarios \
      scenario_source=todo \
      working_dir=<repo>

Expected: most/all fail. A consistent pass here means the feature
landed — verify 2-3 re-runs, then promote per the policy above.
