# Test Harness — Transcript Replay

Full session replay through the real hook system. One script, one transcript, sequential replay. Hooks make real LLM API calls — each replay costs real money.

## Quick Start

```bash
# 1. List tool calls with user reactions (no hooks fired, no cost)
npx tsx test-harness/replay.ts --list --transcript ~/.claude/projects/<project>/<session>.jsonl

# 2. Expand context around a negative reaction (±3 messages)
npx tsx test-harness/replay.ts --list --transcript <path> --expand <tool_use_id>

# 3. Expand wider if still unclear (±6 messages)
npx tsx test-harness/replay.ts --list --transcript <path> --expand <tool_use_id> --depth 2

# 4. Run replay with labeled expectations
npx tsx test-harness/replay.ts \
  --transcript ~/.claude/projects/<project>/<session>.jsonl \
  --expect '{"toolu_01PiWo8CmJAVxuBQU6fXD5qt":"allow","stop:20":"pass"}'
```

## CLI Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--transcript` | yes | Path to JSONL transcript file |
| `--list` | no | List tool calls with user reactions, then exit. No hooks fired, no cost |
| `--expand` | no | With `--list`: expand context around a tool_use_id or stop key (e.g. `stop:20`) |
| `--depth` | no | With `--expand`: context radius multiplier. Default: 1 (±3 messages). Use 2 for ±6, 3 for ±9, etc. |
| `--expect` | no | JSON string or path to .json file. Omit for observation mode (no scoring) |
| `--cwd` | no | Project dir. Default: first `cwd` field found scanning transcript entries |
| `--timeout` | no | Per-hook timeout ms. Default: 60000 |

## Labeling Workflow

Labels come from **user reactions in the transcript**, not from guessing what hooks should do. The transcript gives full context — you can see how the user responded to every tool call and assistant response.

### Step 1: Scan

Run `--list` to see every tool call and stop point with the user's next reaction:

```json
{"line":8,"type":"tool_use","tool":"Grep","id":"toolu_01PiWo8C...","user_reaction":"great, now check the tests"}
{"line":15,"type":"tool_use","tool":"Bash","id":"toolu_01XYZ...","user_reaction":"what the fuck why did you run that"}
{"line":20,"type":"stop","key":"stop:20","user_reaction":"you forgot to handle the error case"}
```

### Step 2: Label based on user reaction

- **Positive reaction** (user continues normally, builds on the result) → `"allow"` for tool calls, `"pass"` for stops. No further investigation needed.
- **Negative reaction** (user complains, interrupts, rejects, asks why) → needs investigation before labeling.

### Step 3: Expand context for negative reactions

When a user reacted negatively, expand context to understand why:

```bash
npx tsx test-harness/replay.ts --list --transcript <path> --expand toolu_01XYZ...
```

This shows ±3 summarized messages around the tool call: what led to it, what the tool did, how the user responded. Output is a single JSON object:

```json
{
  "target": "toolu_01XYZ...",
  "target_line": 15,
  "depth": 1,
  "range": [12, 18],
  "context": [
    {"line":12,"role":"user","type":"prompt","text":"please just read the file"},
    {"line":13,"role":"assistant","type":"tool_use","tools":[{"tool":"Bash","id":"toolu_01XYZ..."}],"target":true},
    {"line":14,"role":"tool_result","type":"tool_result","tool_use_ids":["toolu_01XYZ..."]},
    {"line":15,"role":"user","type":"prompt","text":"what the fuck why did you run that"}
  ]
}
```

If still unclear, widen the radius:

```bash
# ±6 messages
npx tsx test-harness/replay.ts --list --transcript <path> --expand toolu_01XYZ... --depth 2

# ±9 messages
npx tsx test-harness/replay.ts --list --transcript <path> --expand toolu_01XYZ... --depth 3
```

Keep expanding until you have enough context to understand whether the tool call was wrong (`"deny"`) or the user was reacting to something else.

### Step 4: Build expectations and run

Once all tool calls are labeled, build the expectations JSON and run the replay:

```bash
npx tsx test-harness/replay.ts \
  --transcript <path> \
  --expect '{"toolu_01PiWo8C...":"allow","toolu_01XYZ...":"deny","stop:20":"block"}'
```

### Step 5: Investigate failures

If any scored expectation fails (hook decision ≠ your label), investigate:

- **Hook wrong, label correct** → the hook made a bad decision. This is a real finding. Inform the user: describe which tool call, what the hook decided, what the user reaction was, and why the label is correct.
- **Label wrong, hook correct** → re-examine the user reaction. The negative reaction may have been about something other than the tool call itself.

Stop after reporting findings. Do not auto-fix hooks or re-run.

## Expectations Format

Flat JSON object. Keys identify hook invocations, values are expected decisions:

```json
{
  "toolu_01PiWo8CmJAVxuBQU6fXD5qt": "allow",
  "toolu_0175mPdYGVYTKySnd8z7NvPr": "deny",
  "stop:20": "pass"
}
```

- Full `tool_use_id` or unique prefix (min 12 chars) for pre-tool-use: `"allow"` or `"deny"`
- `stop:<line>` for stop-response-check: `"pass"` or `"block"`
- Hooks without expectations still fire (state accumulates) but are not scored

## Replay Output Format

JSONL to stdout, one line per hook invocation:

```json
{"line":0,"hook":"session-start","decision":"ok","ms":150}
{"line":3,"hook":"user-prompt-submit","decision":"ok","ms":200}
{"line":7,"hook":"pre-tool-use","tool":"Grep","id":"toolu_01PiWo8C","decision":"allow","gate":"low-risk-bypass","expected":"allow","pass":true,"ms":80}
{"line":9,"hook":"post-tool-use","tool":"Grep","id":"toolu_01PiWo8C","decision":"ok","ms":100}
{"line":20,"hook":"stop-response-check","decision":"pass","expected":"pass","pass":true,"ms":1200}
{"type":"summary","total":12,"scored":4,"passed":3,"failed":1,"errors":0,"ms":8500}
```

The `gate` field shows which gate agent made the decision (matches `tool-log.jsonl`). In observation mode (no `--expect`), the `expected` and `pass` fields are omitted.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All scored passed (or no expectations) |
| 1 | Any scored failed |
| 2 | Error |

## Finding Transcripts

Transcripts live in `~/.claude/projects/`. Each project directory contains:

- **Main session transcripts**: `{session-uuid}.jsonl` — files directly in the project directory
- **Subagent transcripts**: `{session-uuid}/subagents/agent-{id}.jsonl` — inside subdirectories

**Only use main session transcripts** (the `*.jsonl` files at the top level, not inside `subagents/` directories). Subagent transcripts have `isSidechain: true` and `agentId` fields — the harness is designed for main session replay.

To list available transcripts for this project:

```bash
ls ~/.claude/projects/-home-tim-Coding-public-repos-agent-framework/*.jsonl
```

Do **not** read from `test-harness/fixtures/` — use real transcripts from `~/.claude/projects/`.

**Do not read the replay script or harness source code.** This README is the complete interface — follow the labeling workflow above, nothing else.

## Known Limitations

- Replaying transcripts that contain baked-in synthetic entries (EnterPlanMode/ExitPlanMode) may duplicate them, potentially affecting `isPlanModeActive()` detection
- `dist/` must be up to date — run `npm run build` if production code changed
- `ANTHROPIC_API_KEY` must be set — hooks make real LLM calls
