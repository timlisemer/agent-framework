# Replicating Live Hook Behavior (self-reference)

How to turn an observed live hook output into a scenario that produces the same `decision`, `gate`, and `reason`.

## Workflow

1. **Capture live output verbatim.** Record the hook's `decision` (allow/deny/block/pass), the attributed `gate`/`rule` name, and the full `reason` string. These are your string-match targets.

2. **Find the tool call's jsonl context in the transcript.** Note the last user message before the tool call, any text blocks in the same assistant turn, and whether the turn was split across multiple jsonl lines (same `message.id`, different content arrays).

3. **Mirror user message and tool input exactly.** User wording (typos, casing, punctuation, profanity) and tool inputs go in character-for-character. Any paraphrase changes downstream LLM classification.

4. **Pick the assistant-turn shape to match what flushed live.** See "Shapes" below.

5. **Seed session state to match live.** See "Seeding" below.

6. **Set `expect.expected` to the correct behavior, not live behavior.** Scenarios that capture bugs MUST fail against current code. When live allows but should deny → `expected: "deny"`. When live passes a stop but should block → `expected: "block"`. Pair with `expect.by` when wrong-rule attribution is the bug.

7. **Run the scenario inline on first execution.** `run_scenario` with only `scenario_name` errors when the test-runs cache is empty. Pass the full `scenario` object inline to populate `~/.agent-framework/test-runs/scenarios/<name>/scenario.json`; thereafter the name alone suffices. The on-disk fixture under `test-harness/fixtures/scenarios/` is NOT what the tester executes — it runs the test-runs cache copy. Keep them in sync manually or re-pass inline after each edit.

## Shapes (`src/utils/transcript.ts :: currentTurnAssistantState`)

The current turn's classification picks which rule gets first shot at the deny. The priority order is `respond-first` (5) → `plan-mode-block` (15) → `subagent` (20) → `prediction-question-judge` (28) → `question-validate` (30) → `force-check-required` (32) → `prediction-block` (35) → `low-risk` bypass path (38) → `drift-detect` (40) → `error-acknowledge` (50) → `trusted-path` (58) → `edit-intent` (60) → `style-drift` (65) → `gate` (70) → `tool-approve` (100).

- **Single-line singleton, tool_use only** → `no-text-definitive` → `respond-first` fires fastDeny.
- **Single-line singleton, text + tool_use** → `has-text` → `respond-first` contributes llmContext but does not fastDeny.
- **Multi-line `assistant_split`, any shape without text in any line** → `no-text-racing` → `respond-first` returns null. Next priority rule wins.
- **Single-line singleton with thinking + tool_use** → still `no-text-definitive` for a synthetic singleton (harness marks it). Different from real Claude Code flush behavior, which treats thinking+tool_use as racing unless the message id is a harness singleton marker.

When the live bug was attributed to a non-`respond-first` rule, USE `assistant_split` with two or more `lines[]` sharing one `msg_id`. This forces `no-text-racing` and lets the real rule fire. Otherwise `respond-first` preempts and the scenario passes for the wrong reason.

## Seeding

`seed_state` is REQUIRED — the harness rejects scenarios without it. Every field of `SessionState` must be declared; partials get merged with defaults.

```json
"seed_state": {
  "currentPrediction": {
    "mood": "neutral|angry|frustrated|satisfied|happy",
    "trust": "low|normal|high",
    "intent": "<short sentence matching what live printed in the Intent: field>",
    "blockedIntent": "<what the user explicitly does NOT want, or empty>",
    "explicitlyAllowedTools": [],
    "explicitlyBlockedSubstrings": [],
    "blockAllTools": false,
    "userMessageSnippet": "<exact user words, first ~200 chars>"
  },
  "forceCheckPending": false,
  "frustrationStreak": 0,
  "currentWindowSize": 2
}
```

Map live `reason` strings back to seed fields:

| Live reason shape | Seed signal |
|---|---|
| `User explicitly asked for no tools right now. User said: "…". Intent: …` | `blockAllTools: true`, `intent`, `userMessageSnippet` |
| `User appears angry (trust: low). Blocking X unless explicitly requested.` | `mood: "angry"`, `trust: "low"`, `intent` |
| `User explicitly forbade this in their last message: "…"` | `explicitlyBlockedSubstrings: [{tool, reason}]` |
| `Workaround Bash command was denied earlier. You must run … check …` | `forceCheckPending: true` |
| `Tool call misaligned with user intent: …` | `intent` (the gate LLM's output paraphrases the seed intent) |

The scenario harness fires ONLY the target hook. UserPromptSubmit is NOT run first, so `SENTIMENT_AGENT` does NOT regenerate `currentPrediction`; the seed stands as-is. Session-start runs before the target hook but only initializes defaults when `state.json` is missing — it does not overwrite the seed.

## Expected-field writing

- Plain string: `"expected": "deny"` — just matches decision.
- Rich: `"expected": "deny", "by": "respond-first"` — matches decision AND attributed gate. Use this for wrong-rule bugs.
- Wrong-rule scenarios string-compare `gate_expected` vs `gate`. If decision matches but gate differs, the result is a FAIL with message "decision matched (deny) but wrong rule: got X, expected Y".

## Appeal gate pitfalls

Rules with `appealable: true` (includes `prediction-block`, `gate`, `edit-intent`) run `appealHelper` after a fastDeny. The appeal LLM reads the scenario's transcript and can OVERTURN the deny.

- Long, expository prior user messages give the appeal LLM signal to overturn. If the scenario allows when you expect deny, TRIM the transcript — include only what the live hook saw before the firing tool call.
- Live user messages that clarify intent AFTER the block were never seen by the live appeal. Do not include them.
- Intent strings in the seed that cleanly describe what the user wants help the gate-LLM correlate — which can either help it deny (if tool is clearly misaligned) or help the appeal overturn (if tool looks aligned). Calibrate vagueness to match the live sentiment agent's typical output.

## Rules that bypass earlier denies

- **`low-risk-bypass`** auto-approves tools in the low-risk allowlist (Read, Glob, Grep, MCP reads, `test_harness_tester` actions, etc). It runs AFTER the prediction rules and fast-allows, short-circuiting anything downstream. If live `gate: "low-risk-bypass"` and `reason: "Low-risk tool auto-approval"`, then even with `mood: "angry"` and seeded blocks, prediction-block never gets to deny. The scenario faithfully reproduces this by keeping the target tool in the low-risk list.
- **`force-check-required`** fastDenies any non-check tool when `forceCheckPending: true`. It fires before `prediction-block` (priority 32 < 35). Use `forceCheckPending: true` when the live hook's reason starts with "Workaround Bash command was denied earlier."

## Determinism

- `respond-first` fastDeny: deterministic (pure transcript classification).
- `prediction-block` fastDeny: deterministic (pure state read + `decidePrediction`).
- `force-check-required` fastDeny: deterministic.
- `low-risk-bypass` fast-allow: deterministic.
- `gate` / `rule-gate` LLM: non-deterministic. Same input can APPROVE or DENY across runs depending on Haiku variance.
- Appeal LLM on an appealable fastDeny: non-deterministic. Same input can overturn or not.
- `stop-hook` alignment agent: non-deterministic. Same stop text can pass or block across runs. If a stop-block scenario flaps between pass and block, the alignment agent is the cause.

Expect some scenario runs to flap. Run a failing-expected scenario 2–3 times to confirm it consistently reproduces live, not just once.

## Debug checklist when a scenario does not match live

1. `~/.agent-framework/test-runs/scenarios/<name>/cache/state.json` — confirm seed actually landed (all fields present, `blockAllTools`, `forceCheckPending`).
2. `~/.agent-framework/test-runs/scenarios/<name>/cache/tool-log.jsonl` — see which gate fired and its reason. `status: "allowed"` + `gate: "all-rules"` when you expected a fastDeny usually means the appeal overturned — trim transcript.
3. Wrong rule fired → check priorities. Use `assistant_split` to neutralize `respond-first` if it preempts.
4. `seed_state` ignored → must be at top level of scenario JSON, with `currentPrediction` nested inside (plus the three siblings `forceCheckPending`, `frustrationStreak`, `currentWindowSize`).
5. The fixture on disk differs from what the cache ran → the cache wins. Re-pass scenario inline to refresh the cache.
6. Gate field says `gate` vs `tool-approve` vs a specific rule name — `gate` means the aggregated rule-gate LLM denied (multiple rules contributed llmContext and the LLM decided); a specific name means that rule fastDenied directly.
7. LLM variance suspected → re-run 2–3 times and check if the result is consistent.
