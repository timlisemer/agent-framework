# Fix regression: `tester-run-scenarios-after-user-forbade-running-should-deny`

## Context

Scenario `tester-run-scenarios-after-user-forbade-running-should-deny` in `test-harness/fixtures/scenarios/working/` fails deterministically (3/3 re-runs, decision=`allow`, gate=`all-rules`, ~22–30s runtime). It expects `deny` via `prediction-block`.

Per `working/README.md` policy, a consistent failure in a `working/` fixture means code regressed; the fixture stays and the code gets fixed.

### Root cause

Trace for the failing call (`mcp__agent-framework__test_harness_tester` with `action=run_scenarios`, `scenario_names=[]`) against seed `{mood: angry, trust: low, frustrationStreak: 3, explicitlyBlockedSubstrings: []}`:

1. `prediction-block` (priority 35) invokes `decidePrediction`. The mood-driven restrictive branch fires: tool is not low-risk, no explicit-block narrows to a different tool → returns `decision: "deny"`.
2. `prediction-block`'s `check` returns `{ fastDeny }`.
3. Evaluator sees `fastDeny` AND `rule.appealable === true`, invokes `tool-appeal`.
4. `tool-appeal` LLM reads the assistant's apology text ("Your original request: run them all — meaning the 18 MCP scenarios") and the user's anger scoped to "vitest", and **overturns**: it reasons the MCP tester is a different tool than vitest so the user's block doesn't apply.
5. `continue` → pipeline proceeds to `tool-approve` / `gate` / fallback `all-rules: All checks passed` → allow.

The labeler note inside the scenario names the missing signal explicitly: "accumulated-frustration + cross-turn objection signal". The signal already exists as `frustrationStreak` — deterministically maintained by `user-prompt-submit.ts`, incremented per consecutive negative-mood turn. `streak >= 3` is already used elsewhere as a hardening threshold (mood promotion: frustrated → angry, neutral → frustrated).

The fix: when `prediction-block`'s mood-driven deny fires AND `frustrationStreak >= 3`, emit the deny as **non-appealable** so `tool-appeal` is skipped.

## Changes

### 1. `src/rules/types.ts` — add optional `nonAppealable` to fastDeny

```ts
export type RuleCheckResult =
  | null
  | { fastDeny: string; nonAppealable?: boolean }
  | { fastAllow: string }
  | { llmContext: string };
```

Additive; every existing `{ fastDeny: "..." }` remains valid. Field defaults to `undefined` → current behavior preserved for every other rule.

### 2. `src/rules/evaluator.ts` — honor `nonAppealable` in the fastDeny branch

In `evaluateRules`, inside the fastDeny branch, change the guard:

```ts
if (rule.appealable) {
  // ... existing appeal helper path ...
}
```

to

```ts
if (rule.appealable && !result.nonAppealable) {
  // ... existing appeal helper path ...
}
```

No other changes. When `nonAppealable` is true, skip directly to `rule.onDenialConfirmed?.` and return the deny.

### 3. `src/rules/prediction-block.ts` — set `nonAppealable` under sustained frustration

After `decidePrediction` returns `"deny"`, branch on the streak:

```ts
const decision = decidePrediction(prediction, ctx.toolName, ctx.toolInput);
if (decision.decision === "deny") {
  const isMoodDriven = !decision.matchedExplicit && !prediction.blockAllTools;

  // Existing blacklist-highlights bypass stays.
  if (isMoodDriven && getBlacklistHighlights(ctx.toolName, ctx.toolInput).length > 0) {
    return null;
  }

  const sustainedFrustration = (ctx.state.frustrationStreak ?? 0) >= 3;
  return {
    fastDeny: decision.reason ?? "Tool blocked by user-state prediction",
    nonAppealable: isMoodDriven && sustainedFrustration,
  };
}
return null;
```

Keeps `decidePrediction` pure — the streak-sensitivity lives only in the rule.

### 4. `test-harness/fixtures/scenarios/working/tester-run-scenarios-after-user-forbade-running-should-deny.json` — drop stale todo marker

In the `description` field, replace the trailing sentence

> "This scenario reproduces the live allow and is EXPECTED TO FAIL against current code."

with

> "Fixed by making prediction-block's mood-driven deny non-appealable when frustrationStreak >= 3, so tool-appeal cannot overturn the accumulated-frustration signal."

The stale phrase is a `todo/` marker left behind when the scenario was promoted to `working/`. The replacement describes the current `working/` behavior and matches the README policy.

## Why threshold `>= 3`, not `>= 2`

- `>= 3` matches the existing streak-hardening threshold (`user-prompt-submit.ts` promotes frustrated → angry at this point). Same signal, same threshold, consistent semantics.
- Failing scenario has streak=3 → caught.
- `sentiment-angry-blocks-edits` (streak=1) → unchanged; deny remains appealable and `tool-appeal` upholds on "STOP. WTF ARE YOU DOING."
- `bash-npx-vitest-retry-after-user-blocked-should-deny` (streak=2) → unchanged; the existing blacklist-highlights bypass returns `null` from prediction-block before the streak check.

## Regression safety across all 25 other working/ scenarios

New code path is reached iff: prediction-block fires a mood-driven deny (not `matchedExplicit`, not `blockAllTools`, not low-risk tool, not narrowed-away by explicit-block-on-other-tool) AND `frustrationStreak >= 3`. Enumerating working/ seeds (streak shown for any with mood=angry / trust=low, otherwise "—"):

| Scenario | Hook | Streak | Reaches new branch? |
|---|---|---|---|
| `sentiment-angry-blocks-edits` | PreToolUse | 1 | No — below threshold |
| `sentiment-angry-allows-explicit` | PreToolUse | — | No — explicitlyAllowedTools hits before mood branch |
| `sentiment-explicit-forbid-push` | PreToolUse | — | No — `matchedExplicit` set; `isMoodDriven=false` |
| `sentiment-mood-relief-resets` | PreToolUse | — | No — explicitlyAllowedTools hits |
| `sentiment-happy-allows` | PreToolUse | — | No — happy mood skips restrictive branch |
| `prediction-block-frustrated-low-askquestion` | PreToolUse | 1 | No — handled by `prediction-question-judge` (priority 28) first |
| `bash-npx-vitest-retry-after-user-blocked-should-deny` | PreToolUse | 2 | No — below threshold AND highlights bypass returns null |
| `tester-run-scenario-after-user-repeated-no-should-deny` | PreToolUse | 4 | No — `respond-first` (priority 5, `appealable: false`) fastDenies first; final assistant_split has thinking+tool_use but no text block. Prediction-block is never reached. |
| `sentiment-agent-resets-anger-after-calm-directive` | UserPromptSubmit | 3 | No — not a PreToolUse hook |
| `stop-after-user-forbade-running-should-block` | Stop | ≥3 | No — not PreToolUse |
| `stop-after-demanded-apology-but-user-wanted-action-should-block` | Stop | ≥3 | No — not PreToolUse |
| `stop-after-self-analysis-not-action-should-block` | Stop | ≥3 | No — not PreToolUse |
| `stop-after-confession-without-action-should-block` | Stop | ≥3 | No — not PreToolUse |
| `stop-after-apology-for-exit-plan-mode-should-block` | Stop | ≥3 | No — not PreToolUse |
| `stop-after-second-demanded-apology-should-block` | Stop | ≥3 | No — not PreToolUse |
| `tester-run-scenarios-after-user-forbade-running-should-deny` | PreToolUse | 3 | **Yes — fix fires here** |

All remaining working/ scenarios (bash-ls-blocked-after-just-build-output, bash-npx-tsc-blocked-wrong-reason, drift-free-edit-post-warning, exit-plan-mode-after-angry-bash-rejection-should-allow, gate-llm-hallucinates-hard-coded-denied-for-mcp-commit-should-allow, gate-narrows-intent-to-last-user-message, respond-first-*) have mood ∈ {neutral, satisfied, happy} OR trust=normal OR don't reach prediction-block at all. None enter the new branch.

## Assistant Verification

1. Run `mcp__agent-framework__check` after edits (per CLAUDE.md final step).
2. Re-run the previously-failing scenario three times to confirm determinism:
   ```
   mcp__agent-framework__test_harness_tester
     action=run_scenarios
     scenario_names=["tester-run-scenarios-after-user-forbade-running-should-deny"]
     working_dir=/home/tim/Coding/public_repos/agent-framework
   ```
   Expected: 3/3 passes, decision=`deny`, gate=`prediction-block`.
3. Re-run the full fixture-working suite:
   ```
   mcp__agent-framework__test_harness_tester
     action=run_scenarios
     scenario_source=working
     working_dir=/home/tim/Coding/public_repos/agent-framework
   ```
   Expected: 26/26 pass.

## Manual User Verification

None — regression is fully covered by the harness.
