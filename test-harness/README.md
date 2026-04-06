# Test Harness

Replay testing system for agent-framework hooks. Executes real `pre-tool-use` and `stop-response-check` hooks against sliced transcript segments with reconstructed session state. Makes real LLM calls via the Anthropic API.

**Next file to read:** [`fixtures/README.md`](fixtures/README.md) — transcript format, sanitization, fixture index. No other documentation files exist in this directory.

## Quick Start

Ensure `dist/` is up to date and `ANTHROPIC_API_KEY` is set, then:

```bash
# 1. Copy a recent transcript into fixtures
cp ~/.claude/projects/-home-tim-Coding-public-repos-agent-framework/<session-id>.jsonl \
  test-harness/fixtures/transcripts/my-session.jsonl

# 2. List testable tool calls
npx tsx test-harness/run.ts --list test-harness/fixtures/transcripts/my-session.jsonl

# 3. Run a test (use a line number from the --list output)
npx tsx test-harness/run.ts \
  --hook pre-tool-use \
  --transcript test-harness/fixtures/transcripts/my-session.jsonl \
  --line <N> \
  --expect allow \
  --label "Description of what this tests"
```

## Concepts

### Transcripts

A **transcript** is a JSONL file (one JSON object per line) that Claude Code writes during every session. Each line is a conversation message — user turns, assistant turns (with `tool_use` content blocks), tool results, and metadata. Claude Code stores transcripts at:

```
~/.claude/projects/<project-dir>/<session-id>.jsonl
```

The `<project-dir>` is the absolute project path with both `/` and `_` replaced by `-`. For example, `/home/tim/Coding/public_repos/agent-framework` becomes `-home-tim-Coding-public-repos-agent-framework`. Inside each project directory are `<session-id>.jsonl` files (UUID-named). To find recent sessions, list by modification time: `ls -lt ~/.claude/projects/<project-dir>/`.

The first few lines (lines 0-N) contain session metadata — permission mode, file history snapshots, deferred tool lists, MCP instructions, etc. The number of metadata lines varies per session. After metadata, lines alternate between user messages, assistant responses (which may contain `tool_use` blocks), and `tool_result` blocks.

Example transcript lines (abbreviated):

```jsonl
{"type":"permission-mode","permissionMode":"default","sessionId":"70c52a93-..."}
{"type":"file-history-snapshot","messageId":"...","snapshot":{...}}
{"type":"user","message":{"role":"user","content":"Fix the bug in main.ts"},"cwd":"/home/user/project"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"main.ts"}}]}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"...file contents..."}]}}
```

### Hooks

This harness tests two hook types from the agent-framework:

- **`pre-tool-use`** — Runs before every tool call. Decides whether to **allow** or **deny** the tool. This is the main safety gate that checks tool access, plan-mode restrictions, edit-intent alignment, etc.
- **`stop-response-check`** — Runs after the assistant's response. Decides whether to **pass** (accept) or **block** (reject and force a retry). Used for response quality and alignment checks.

### Session state reconstruction

When you run a test, the harness reconstructs the session state that hooks normally read at runtime. It builds this from the transcript prefix (all lines before `--line`):

- **`state.json`** — `toolCallCount` (number of prior tool calls, default 10), `editIntent` (whether the user asked for edits), `lastUserMessageHash` (MD5 of the last user message)
- **`tool-log.jsonl`** — reconstructed from prior `tool_use`/`tool_result` pairs in the transcript
- **`summary.md`** — template with user intent extracted from the first user message
- **Gate caches** — `gate-reasoning.json`, `prediction-cache.json`, `correction-cache.json`, `hook-denials.json`, `rewind-cache.json`, `active-subagents.json` — all initialized empty

The `--edit-intent` and `--tool-call-count` flags let you override the derived values to test specific state scenarios.

## Prerequisites

- **Node.js** (v20+) and `npx` available
- **Built dist/ directory** — hooks are spawned from `dist/hooks/`, so `dist/` must be up to date. Build before running tests
- **`ANTHROPIC_API_KEY`** environment variable — hooks make real LLM calls to gate agents

## Usage

### List mode — find testable moments

Scan a transcript for all `tool_use` entries:

```bash
npx tsx test-harness/run.ts --list test-harness/fixtures/transcripts/<your-file>.jsonl
```

Example output:

```
line:6 tool:Grep plan-mode:no input:{"pattern":"some search term","output_mode":"content"} context:(none)
line:8 tool:Read plan-mode:no input:{"file_path":"/home/user/project/src/main.ts","offset":100,"limit":40} context:(none)
line:11 tool:Bash plan-mode:no input:{"command":"git blame -L 10,30 src/main.ts","description":"Git blame on main.ts"} context:(none)
```

Output format — one line per tool call:

| Column | Meaning |
|---|---|
| `line` | 0-indexed JSONL line number — use this as `--line` in test mode |
| `tool` | Tool name (e.g. `Read`, `Bash`, `Edit`, `Write`) |
| `plan-mode` | Whether plan mode was active at this point in the transcript |
| `input` | First 100 chars of the tool input JSON |
| `context` | First 120 chars of the preceding user message, or `(none)` |

### Test mode — run a hook test

```bash
npx tsx test-harness/run.ts \
  --hook <hook-type> \
  --transcript <transcript.jsonl> \
  --line <N> \
  --expect <decision>
```

### Batch mode

There is no built-in batch runner. Script multiple tests with a bash loop:

```bash
#!/usr/bin/env bash
set -e
T=test-harness/fixtures/transcripts/my-session.jsonl

npx tsx test-harness/run.ts --hook pre-tool-use --transcript "$T" --line 6 --expect allow --label "Allow Grep"
npx tsx test-harness/run.ts --hook pre-tool-use --transcript "$T" --line 8 --expect allow --label "Allow Read"
npx tsx test-harness/run.ts --hook pre-tool-use --transcript "$T" --line 11 --expect allow --label "Allow Bash"

echo "All tests passed"
```

## Options Reference

| Flag | Required | Description |
|---|---|---|
| `--hook <type>` | Yes | Hook to test: `pre-tool-use` or `stop-response-check` |
| `--transcript <path>` | Yes | Path to a JSONL transcript file (see [Transcripts](#transcripts)) |
| `--line <N>` | Yes | 0-indexed JSONL line number. For `pre-tool-use`: must point to a line containing a `tool_use` block. For `stop-response-check`: points to the last assistant message line; the transcript is sliced up to and including this line, and the hook evaluates the full response. Get line numbers from `--list` output |
| `--expect <decision>` | Yes | Expected hook decision. See [Expected values](#expected-values) below |
| `--expect-agent <name>` | No | Assert which gate agent made the decision. See [Agent names](#agent-names) below |
| `--label <text>` | No | Human-readable test description. Appears in the results log for documentation |
| `--cwd <path>` | No | Override the working directory. Defaults to the `cwd` field in the transcript's metadata. Falls back to the current working directory if the transcript has no `cwd` field |
| `--edit-intent <value>` | No | Override edit-intent state: `true`, `false`, or `null` |
| `--tool-call-count <N>` | No | Override the simulated tool call count (default: 10) |
| `--timeout <ms>` | No | Hook execution timeout in milliseconds (default: 60000) |

### Expected values

| Hook | Valid `--expect` values | Meaning |
|---|---|---|
| `pre-tool-use` | `allow` | Hook permits the tool call |
| `pre-tool-use` | `deny` | Hook blocks the tool call |
| `stop-response-check` | `pass` | Hook accepts the response |
| `stop-response-check` | `block` | Hook rejects the response |

Using `deny` with `stop-response-check` or `block` with `pre-tool-use` will always fail — each hook type has its own decision vocabulary.

### Agent names

Valid `--expect-agent` values correspond to the gate agents in the framework. The most common ones:

| Agent | Hook | Description |
|---|---|---|
| `low-risk-bypass` | pre-tool-use | Deterministic auto-approval for low-risk tools (Read, Glob, Grep, etc.) |
| `plan-mode-block` | pre-tool-use | Deterministic deny for writes/executions during plan mode |
| `subagent-bash-block` | pre-tool-use | Deterministic deny for Bash in subagents |
| `trusted-path` | pre-tool-use | Deterministic approval for known-safe file paths |
| `exit-plan-mode` | pre-tool-use | ExitPlanMode handling |
| `tool-approve` | pre-tool-use | LLM-based blacklist violation check |
| `gate` | pre-tool-use | LLM-based general gate agent |
| `style-drift` | pre-tool-use | LLM-based style/formatting drift check on edits |
| `plan-validate` | pre-tool-use | LLM-based plan adherence check |
| `claude-md-validate` | pre-tool-use | LLM-based CLAUDE.md edit validation |
| `question-validate` | pre-tool-use | LLM-based question quality check |
| `response-align` | pre-tool-use | LLM-based response alignment check |
| `intent-validate` | stop-response-check | LLM-based intent alignment on stop |
| `response-align-stop` | stop-response-check | LLM-based response alignment on stop |

Deterministic agents always produce the same result for the same input. LLM-based agents make API calls and may vary between runs — use `--expect-agent` with these when you want to verify which agent path was taken, not just the final decision.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Pass — hook decision matched `--expect` (and `--expect-agent` if provided) |
| `1` | Fail — hook decision did not match expectations |
| `2` | Error — crash, invalid args, or timeout |

### Error output

When `--line` points to a line that isn't a `tool_use` block:

```json
{"pass":false,"hook":"pre-tool-use","decision":"error","expected":"allow","ms":0,"error":"No tool_use block found at line 3. Found type: attachment"}
```

When the hook crashes or times out:

```json
{"pass":false,"hook":"pre-tool-use","decision":"timeout","expected":"allow","ms":60012,"error":"Hook timed out after 60000ms"}
```

When args are missing:

```
Error: --hook is required
```

## Examples

After copying a transcript to `test-harness/fixtures/transcripts/my-session.jsonl` and running `--list`:

```bash
# Test that a Grep call is allowed (deterministic low-risk bypass)
npx tsx test-harness/run.ts \
  --hook pre-tool-use \
  --transcript test-harness/fixtures/transcripts/my-session.jsonl \
  --line 6 \
  --expect allow \
  --expect-agent low-risk-bypass \
  --label "Allow Grep - low risk tool"

# Test that a Bash command is allowed (goes through LLM gate)
npx tsx test-harness/run.ts \
  --hook pre-tool-use \
  --transcript test-harness/fixtures/transcripts/my-session.jsonl \
  --line 11 \
  --expect allow \
  --label "Allow Bash git blame"

# Test that a stop-response-check passes
npx tsx test-harness/run.ts \
  --hook stop-response-check \
  --transcript test-harness/fixtures/transcripts/my-session.jsonl \
  --line 8 \
  --expect pass
```

## Results

Every test run appends a JSON line to `test-harness/results/log.jsonl`. The `results/` directory is created automatically. The log file is gitignored.

Each entry contains:

| Field | Type | Description |
|---|---|---|
| `pass` | boolean | Whether the test passed |
| `hook` | string | `pre-tool-use` or `stop-response-check` |
| `decision` | string | Actual hook decision (`allow`, `deny`, `pass`, `block`, `timeout`, `error`) |
| `expected` | string | The `--expect` value |
| `agent` | string? | Which gate agent made the decision (from tool-log) |
| `expectedAgent` | string? | The `--expect-agent` value, if provided |
| `reason` | string? | Gate reasoning text (from tool-log) |
| `label` | string? | The `--label` value, if provided |
| `ms` | number | Execution time in milliseconds |
| `error` | string? | Error message on timeout or crash |

Review results with standard JSONL tools:

```bash
# View all results
cat test-harness/results/log.jsonl | jq .

# View only failures
cat test-harness/results/log.jsonl | jq 'select(.pass == false)'

# Count pass/fail
cat test-harness/results/log.jsonl | jq -s 'group_by(.pass) | map({pass: .[0].pass, count: length})'
```
