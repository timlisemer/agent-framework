# Locating a captured scenario from a quote

This file is a recipe for an agent session that has been asked **"find the scenario where the previous session said/did X"**, where X is a quoted string from a different session. Follow the recipe verbatim.

## Where data lives

| Path | What's there |
|------|--------------|
| `~/.claude/projects/<encoded>/<session-id>.jsonl` | The raw Claude transcript — every user/assistant/tool_result line, the user's literal text, the assistant's literal text, tool inputs and outputs. (Claude-specific path; future adapters use their own transcript directories.) |
| `~/.agent-framework/sessions/<encoded>/<yyyy-mm-dd-HHmm>_<hash>/captures.jsonl` | One compact pointer per hook fire: `{seq, ts, epoch_id, parent_capture_seq, event, tool_use_id, decision, state_snapshot_seq}` plus optional forward-compatible fields. `decision` is a string such as `allow`, `deny`, `ok`, `pass`, `block`, or `error`; gate names and reason text live in `tool-log.jsonl`. |
| `~/.agent-framework/sessions/<encoded>/<dir>/state-snapshots.jsonl` | Append-only state snapshots referenced by capture pointers. |
| `~/.agent-framework/sessions/<encoded>/<dir>/epochs.jsonl` | One line per epoch (session-start / compact / rewind / clear). |
| `~/.agent-framework/sessions/<encoded>/<dir>/tool-log.jsonl` | Append-only tool-call log: `{ts, tool, toolUseId, status, gate, reason, ms}`. |
| `~/.agent-framework/sessions/<encoded>/<dir>/plan-mode-events.jsonl` | Append-only plan-mode entered/exited transition log. |
| `~/.agent-framework/sessions/<encoded>/<dir>/session-injections.jsonl` | Append-only generic injected-context log. File-backed injections include exact captured source content and hashes. |
| `~/.agent-framework/sessions/<encoded>/<dir>/transcript-path.txt` | Sidecar: absolute path back to the corresponding `~/.claude/projects/` transcript. |

The session dir name encodes time-of-creation; older subdirs are older sessions. `<encoded>` is the project path with `/` replaced by `-` (e.g. `home-tim-Coding-myproj`).

## Recipe — pick the branch that matches the quote

### Branch A: Quote is from user or assistant text

The quote is something the human typed or that the model said.

```bash
# 1. Find every transcript line containing the quote.
rg -n --no-heading --color=never "<QUOTE>" ~/.claude/projects/ | head -30
```

Each hit gives you a transcript file path + line number. Open the JSONL line(s); extract the `uuid` field — call it `Q_UUID` — and the `sessionId`.

```bash
# 2. Map that transcript to its agent-framework session dir.
TRANSCRIPT_PATH="<the path from step 1>"
grep -rl "$TRANSCRIPT_PATH" ~/.agent-framework/sessions/*/*/transcript-path.txt | head -1
```

The matching `transcript-path.txt` lives inside the session dir you want. Call its parent `SESSION_DIR`.

```bash
# 3. Inspect captures around the turn. Captures are ordered by seq.
jq -c . "$SESSION_DIR/captures.jsonl" | tail -50
```

In practice: load `captures.jsonl`, `tool-log.jsonl`, and the transcript JSONL together. Use capture `event`, `tool_use_id`, `decision`, and nearby transcript ordering to pick the relevant hook fire. For a tool call, first find the `tool_use` block in the transcript, then match its `id` to `captures.jsonl` `tool_use_id`. For a text-only response, use the nearest `Stop` capture after the assistant text. For plan-mode or context-injection behavior, also inspect `permission_mode`, `plan_mode`, `injection_seqs`, and `injection_hashes` on the capture; use `injection_seqs` to read the exact records from `session-injections.jsonl`.

```bash
# 4. Materialize the full Scenario JSON from that capture.
node -e "
  const m = require('$AGENT_FRAMEWORK_ROOT/dist/src/scenario/materialize.js');
  m.materializeScenario('$SESSION_DIR', <CAPTURE_SEQ>).then(s => console.log(JSON.stringify(s, null, 2)));
"
```

### Branch B: Quote is from a hook decision/reason string

The quote is something a hook printed — a deny reason, a block message, a gate-name, "Use Read tool", "Workaround Bash command was denied earlier", etc.

```bash
# Gate names and reason strings live in tool-log.jsonl.
rg -n --no-heading --color=never "<QUOTE>" ~/.agent-framework/sessions/*/*/tool-log.jsonl | head -30
```

Each hit gives you `<SESSION_DIR>/tool-log.jsonl:<line_no>:<the JSON line>`. Parse `toolUseId`, then cross-reference that against `captures.jsonl` (`tool_use_id` field) in the same session to get the matching capture `seq`.

If the quote is only the decision string (`allow`, `deny`, `block`, etc.) or hook event name, search captures directly:

```bash
rg -n --no-heading --color=never "<QUOTE>" ~/.agent-framework/sessions/*/*/captures.jsonl | head -30
```

If the quote is injected context, such as plan-mode guidance, search injection logs directly:

```bash
rg -n --no-heading --color=never "<QUOTE>" ~/.agent-framework/sessions/*/*/session-injections.jsonl | head -30
```

Each hit gives a session directory and injection `seq`. Cross-reference that
`seq` with `captures.jsonl` `injection_seqs` to find the hook fire that emitted
it.

### Branch C: Quote is a tool name + a fragment of input

E.g. "the Bash command that ran `npm run build`" — the quote is the Bash command body.

```bash
# Tool inputs are in the transcript JSONL inside tool_use blocks.
rg -n --no-heading --color=never "<QUOTE>" ~/.claude/projects/ | head -30
```

From there proceed as Branch A.

### Branch D: Quote is exact but no hits anywhere

The session is too old and was rotated out of the capture cap (default 5000 entries per session, configurable via `AGENT_FRAMEWORK_CAPTURE_CAP`). The transcript JSONL may still exist under `~/.claude/projects/`; you can read it directly without a paired capture.

If even the transcript is gone, the quote can't be resolved — tell the user.

## Picking which capture is "the right one"

A single user turn can produce many captures (PreToolUse + N PostToolUse + Stop). Pick the one that matches the user's intent:

| User asked for... | Pick capture where... |
|---|---|
| "the decision that denied X" | `event === "PreToolUse" && decision === "deny"` AND tool/input matches |
| "what the hook said when Y happened" | `event` matches the lifecycle event (Stop, UserPromptSubmit, etc.) |
| "the scenario right before/after the user said Z" | use transcript-line ordering plus nearby `UserPromptSubmit` / `Stop` captures |
| "everything that happened in that turn" | all captures between two consecutive UserPromptSubmit captures |

## Promoting a captured scenario to a fixture

Once located:

1. Materialize → get a v2 Scenario JSON.
2. Run it via `mcp__agent-framework__scenario_tester` action `run_scenario` to confirm it reproduces.
3. If you want it as a permanent regression case, write the JSON to `scenarios/expected-to-pass/<slug>.json` (passes today), `scenarios/fixture-bug/<slug>.json` (the captured behavior is buggy and should be fixed), or `scenarios/expected-to-fail/<slug>.json` (codifies a known-missing feature). Filename stem must equal `scenario.name`. Set `expect.expected` to the CORRECT decision, not necessarily the captured one.

Materialized plan-mode injection scenarios seed the prior plan-mode sidecar and
write captured source files through `setup_files`. Do not replace those seeded
values with the current repo files; they are part of the reproduction.

## Notes for the assistant reading this

- Always ask the user for the most distinctive substring from their quote — short distinct phrases beat long ambiguous ones.
- If grep returns more than ~10 hits, ask the user to narrow (date range? project? rough decision: allow vs deny?). Don't materialize 10 scenarios speculatively.
- When in doubt, read the captures.jsonl line first (it's compact) before materializing — the `event`, `tool_use_id`, `decision`, and `state_snapshot_seq` fields usually disambiguate without the full Scenario.
- The `scenario_tester` MCP tool's `list_scenarios` action only enumerates committed fixtures under `scenarios/`. It does NOT walk live captures under `~/.agent-framework/sessions/`. For the recipe above, raw filesystem grep + materializer is the path; if cross-session search becomes a regular need, a future `scenario_find` MCP tool would be the right place to encapsulate it.
