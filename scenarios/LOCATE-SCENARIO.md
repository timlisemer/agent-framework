# Locating a captured scenario from a quote

This file is a recipe for a Claude Code session that has been asked **"find the scenario where the previous session said/did X"**, where X is a quoted string from a different session. Follow the recipe verbatim.

## Where data lives

| Path | What's there |
|------|--------------|
| `~/.claude/projects/<encoded>/<session-id>.jsonl` | The raw Claude transcript — every user/assistant/tool_result line, the user's literal text, the assistant's literal text, tool inputs and outputs. |
| `~/.agent-framework/sessions/<encoded>/<yyyy-mm-dd-HHmm>_<hash>/captures.jsonl` | One ~200-byte pointer per hook fire: `{seq, ts, epoch_id, parent_capture_seq, event, tool_use_id, transcript_anchor_uuid, decision: {decision, by, reason}, state_snapshot_seq, raw_input_hash}`. The `decision.reason` field is the hook's verbatim deny/block message. |
| `~/.agent-framework/sessions/<encoded>/<dir>/state-snapshots.jsonl` | Append-only state snapshots referenced by capture pointers. |
| `~/.agent-framework/sessions/<encoded>/<dir>/epochs.jsonl` | One line per epoch (session-start / compact / rewind / clear). |
| `~/.agent-framework/sessions/<encoded>/<dir>/tool-log.jsonl` | Append-only tool-call log: `{ts, tool, toolUseId, status, gate, reason, ms}`. |
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
grep -rl "$TRANSCRIPT_PATH" ~/.agent-framework/sessions/*/transcript-path.txt | head -1
```

The matching `transcript-path.txt` lives inside the session dir you want. Call its parent `SESSION_DIR`.

```bash
# 3. Find captures whose anchor_uuid is at-or-before Q_UUID in the transcript.
#    The most recent such capture is the scenario for "the hook fire that
#    happened just before this line".
jq -c 'select(.transcript_anchor_uuid)' "$SESSION_DIR/captures.jsonl" |
  awk -F'"' -v target="$Q_UUID" '{ # naive: print every capture; user can match by ordering
    # actually use a small Node/Python script; jq is fine too:
  }'
```

In practice: load `captures.jsonl` and the transcript JSONL together; for each capture, find which transcript line UUID equals `transcript_anchor_uuid`, look up that line's index, pick the capture whose anchor index ≥ Q_UUID's transcript index but is closest from the right (i.e. the next capture after the quote). If you need the capture for the hook fire that PRODUCED a tool_use referenced by the quote, pick the closest capture from the LEFT instead.

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
# Decision reasons live in captures.jsonl as decision.reason.
rg -n --no-heading --color=never "<QUOTE>" ~/.agent-framework/sessions/*/captures.jsonl | head -30
```

Each hit gives you `<SESSION_DIR>/captures.jsonl:<line_no>:<the JSON line>`. Parse the line, extract `seq`, then materialize as in Branch A step 4.

If the quote is the `reason` text from a tool-log entry instead of a capture pointer, swap the file:

```bash
rg -n --no-heading --color=never "<QUOTE>" ~/.agent-framework/sessions/*/tool-log.jsonl | head -30
```

Each tool-log entry has a `toolUseId`. Cross-reference that against `captures.jsonl` (`tool_use_id` field) in the same session to get the matching capture seq.

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
| "the decision that denied X" | `event === "PreToolUse" && decision.decision === "deny"` AND tool/input matches |
| "what the hook said when Y happened" | `event` matches the lifecycle event (Stop, UserPromptSubmit, etc.) |
| "the scenario right before/after the user said Z" | use the transcript-line ordering against `transcript_anchor_uuid` |
| "everything that happened in that turn" | all captures between two consecutive UserPromptSubmit captures |

## Promoting a captured scenario to a fixture

Once located:

1. Materialize → get a v2 Scenario JSON.
2. Run it via `mcp__agent-framework__scenario_tester` action `run_scenario` to confirm it reproduces.
3. If you want it as a permanent regression case, write the JSON to `scenarios/expected-to-pass/<slug>.json` (passes today), `scenarios/fixture-bug/<slug>.json` (the captured behavior is buggy and should be fixed), or `scenarios/expected-to-fail/<slug>.json` (codifies a known-missing feature). Filename stem must equal `scenario.name`. Set `expect.expected` to the CORRECT decision, not necessarily the captured one.

## Notes for the assistant reading this

- Always ask the user for the most distinctive substring from their quote — short distinct phrases beat long ambiguous ones.
- If grep returns more than ~10 hits, ask the user to narrow (date range? project? rough decision: allow vs deny?). Don't materialize 10 scenarios speculatively.
- When in doubt, read the captures.jsonl line first (it's compact) before materializing — the `decision` and `transcript_anchor_uuid` fields usually disambiguate without the full Scenario.
- The `scenario_tester` MCP tool's `list_scenarios` action only enumerates committed fixtures under `scenarios/`. It does NOT walk live captures under `~/.agent-framework/sessions/`. For the recipe above, raw filesystem grep + materializer is the path; if cross-session search becomes a regular need, a future `scenario_find` MCP tool would be the right place to encapsulate it.
