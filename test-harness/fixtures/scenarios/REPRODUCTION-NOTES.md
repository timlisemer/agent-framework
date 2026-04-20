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

The classifier returns one of three states -- msg_id grouping is hidden inside the utility and NEVER leaks to rules:

- **`responded`** -- the current-turn assistant group contains at least one text block (whether single-line or multi-line `assistant_split`). `respond-first` contributes llmContext but does not fastDeny.
- **`silent`** -- the current-turn group has no text block at hook-fire time. Applies to both single-line singletons with tool_use only AND multi-line `assistant_split` without text in any sub-line. `respond-first` fastDenies.
- **`no-current-turn`** -- no non-meta user entry precedes the firing tool_use (nothing to respond to). `respond-first` returns null.

When authoring a scenario that should reach a NON-`respond-first` rule, include a text block in the assistant turn (put it in the same content array as the tool_use, or add a text sub-line in an `assistant_split`). A silent turn -- in any shape -- will always be taken by `respond-first` first.

## Transcript user entries

Every `user` entry in `scenario.transcript` has a required `isMeta: true | false` field (see `src/agents/mcp/scenario-types.ts :: ScenarioUserEntry`).

- `isMeta: false` — a real user turn the person typed. Almost every entry is this.
- `isMeta: true` — a system-injected user-role message Claude Code writes into the jsonl on your behalf. Examples from real transcripts: the body text attached to a slash command (`You MUST use the MCP tools ...`), `<local-command-caveat>` lines from `!`-prefixed bash, stop-hook feedback echoed back. `excludeMetaMessages` (default true in `readTranscriptExact`) skips these so system blurbs don't get mistaken for real instructions.

The flag matters for rule behavior when the newest user-role entry is meta. `newestUserWasSlashCommand` in `src/utils/transcript.ts` is computed on the FIRST user-role entry encountered during backward iteration, which can be the meta entry that Claude Code wrote AFTER the real slash-command line. If that meta entry lacks the `<command-name>` tag, the flag becomes false and respond-first fails to skip — exactly the live bug captured in `respond-first-cites-plan-approved-after-slash-command-should-allow.json`. You cannot reproduce that bug class without setting `isMeta: true` on the right entry.

When authoring a scenario that mirrors a `/slash` command live turn, the pattern is:

```json
{ "role": "user", "isMeta": false, "content": "<command-message>quickpush</command-message>\n<command-name>/quickpush</command-name>" },
{ "role": "user", "isMeta": true, "content": [{ "type": "text", "text": "You MUST use the MCP tools ..." }] }
```

Two user entries per slash invocation, meta-flag on the body only.

## MCP Zod vs on-disk scenario files

The scenario JSON on disk is the declarative source of truth. The MCP `run_scenario` tool accepts an inline `scenario` parameter that goes through a Zod schema at the MCP boundary — Zod strips any field it doesn't know about. If a new scenario field has been added to `src/agents/mcp/scenario-types.ts` and the validator but NOT yet mirrored into the Zod schema in `src/mcp/server.ts`, inline-passed scenarios silently lose that field even though editing the on-disk scenario.json works fine.

If inline passes behave differently from on-disk runs, verify the Zod schema in `src/mcp/server.ts` mirrors the authoritative type in `src/agents/mcp/scenario-types.ts`. The MCP server process also has to be restarted after rebuilding for the updated Zod to take effect.

## Seeding

`seed_state` is REQUIRED — the harness rejects scenarios without it. Every field of `SessionState` must be declared; partials get merged with defaults.

An optional `seed_state.toolLog: ToolLogEntry[]` pre-populates `cache/tool-log.jsonl` with prior tool-call entries before the target hook fires. Use this to reproduce live behavior for rules that read the session tool log (`drift-detect`'s repetition heuristic, `force-check-required`'s denial cache). Each entry requires `tool`, `status`, `gate`; `ts` and `ms` default to monotonic values (older entries older) when omitted. Without seeded entries those rules see an empty log and never fire.

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
