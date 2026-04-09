# Test Harness -- Transcript Replay

Full session replay through the real hook system. One script, one transcript, sequential replay. Hooks make real LLM API calls -- each replay costs real money.

**EVERY tool call and stop point must be labeled. The replay script rejects
incomplete label sets and will not run. No exceptions.**

## Folder Structure

Each transcript gets a persistent folder under `~/.agent-framework/test-runs/`:

```
~/.agent-framework/test-runs/{transcript-name}/
  transcript.jsonl          # copy of original transcript
  labels.draft.json         # label file in progress
  labels.json               # finalized label file (renamed from draft)
  report.json               # test report (overwrites on re-test)
  notes_and_questions.md    # uncertainty notes from labeler/tester
  cache/                    # ephemeral hook runtime files
    replay.pid
    transcript.jsonl        # incremental transcript fed to hooks
    tool-log.jsonl
    pids/
    ...
```

Cache files are cleaned at the **start** of the next run, not at the end of the current run.

### Label File Naming

- `labels.draft.json` -- labeling is in progress or not yet reviewed
- `labels.json` -- labeling is complete, ready for testing

## Quick Start

    # 1. Generate labels from actual hook decisions (costs money)
    npx tsx test-harness/replay.ts --generate-labels --transcript <path.jsonl>
    # Creates: ~/.agent-framework/test-runs/<name>/labels.draft.json

    # 2. Scaffold -- generate starter label file from user reactions (no cost)
    npx tsx test-harness/replay.ts --scaffold --transcript <path.jsonl>
    # Creates: ~/.agent-framework/test-runs/<name>/labels.draft.json

    # 3. Scan -- see all tool calls and user reactions (no cost)
    npx tsx test-harness/replay.ts --list --transcript <path.jsonl>

    # 4. Investigate -- expand context around a hook (no cost)
    npx tsx test-harness/replay.ts --list --transcript <path.jsonl> --expand <tool_use_id>

    # 5. Validate -- check completeness without running hooks (no cost)
    npx tsx test-harness/replay.ts --validate --transcript <path.jsonl> \
      --expect ~/.agent-framework/test-runs/<name>/labels.draft.json

    # 6. Rename labels.draft.json to labels.json when labeling is done

    # 7. Run -- replay through real hooks (costs money)
    npx tsx test-harness/replay.ts --transcript <path.jsonl> \
      --expect ~/.agent-framework/test-runs/<name>/labels.json

## CLI Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--transcript` | yes | Path to JSONL transcript file |
| `--generate-labels` | no | Run hooks and record actual decisions as labels. Creates folder, copies transcript, writes `labels.draft.json`. No report generated. Costs money |
| `--list` | no | List tool calls with user reactions and suggested labels, then exit. No hooks fired, no cost |
| `--expand` | no | With `--list`: expand context around a tool_use_id or stop key (e.g. `stop:20`) |
| `--depth` | no | With `--expand`: context radius multiplier. Default: 1 (+-3 messages). Use 2 for +-6, 3 for +-9 |
| `--scaffold` | no | Generate a starter label file from user reaction heuristics (no hooks fired, no cost) |
| `--validate` | no | Check label file completeness and value validity without running hooks. Requires --expect. No cost |
| `--expect` | no | Path to a .json label file. Inline JSON is NOT supported. Must contain one label per scorable hook |
| `--cwd` | no | Project dir. Default: first `cwd` field found scanning transcript entries |
| `--timeout` | no | Per-hook timeout ms. Default: 60000 |

## Labeling Modes

### Generate Labels (recommended for automation)

Records what the hooks **actually decide** by running them against the transcript:

    npx tsx test-harness/replay.ts --generate-labels --transcript <path.jsonl>

This fires real hooks (costs money) and writes `labels.draft.json` with the actual hook decisions. Hook errors or timeouts are recorded as `"INVESTIGATE"`. No report is generated.

### Scaffold (free alternative)

Generates labels based on **user reaction heuristics** (no hooks fired, free):

    npx tsx test-harness/replay.ts --scaffold --transcript <path.jsonl>

This scans user reactions in the transcript. Positive/neutral reactions get `"allow"`/`"pass"`, negative reactions get `"INVESTIGATE"`.

## Labeling Workflow

Labels come from **user reactions in the transcript**, not from guessing what hooks should do.

### Step 1: Generate or scaffold labels

Use `--generate-labels` (recommended, costs money) or `--scaffold` (free heuristic).

### Step 2: Review and resolve

For each label, expand context to understand the user reaction:

    npx tsx test-harness/replay.ts --list --transcript <path.jsonl> --expand <tool_use_id>
    npx tsx test-harness/replay.ts --list --transcript <path.jsonl> --expand <tool_use_id> --depth 2

Change each `"INVESTIGATE"` to a final value. Review all other labels with hindsight.

### Step 3: Validate

    npx tsx test-harness/replay.ts --validate --transcript <path.jsonl> \
      --expect ~/.agent-framework/test-runs/<name>/labels.draft.json

### Step 4: Finalize

Rename `labels.draft.json` to `labels.json` to mark labeling as complete.

### Step 5: Run

    npx tsx test-harness/replay.ts --transcript <path.jsonl> \
      --expect ~/.agent-framework/test-runs/<name>/labels.json

### Step 6: Investigate failures

- **Hook wrong, label correct**: The hook made a bad decision. Fix the hook code.
- **Label wrong, hook correct**: Re-examine the user reaction and update the label.

## Label File Format

Stored at `~/.agent-framework/test-runs/<name>/labels.draft.json` (or `labels.json` when finalized).

Structured format (generated by --scaffold and --generate-labels):

    {
      "_meta": {
        "transcript": "/path/to/transcript.jsonl",
        "created": "2026-04-08T12:00:00.000Z",
        "commit": "abc1234...",
        "total_hooks": 73,
        "needs_review": 4
      },
      "labels": {
        "toolu_01PiWo8CmJAVxuBQU6fXD5qt": "allow",
        "toolu_01XYZ...": "deny",
        "stop:20": "block",
        "stop:45": "pass"
      }
    }

Flat format (also accepted):

    {
      "toolu_01PiWo8CmJAVxuBQU6fXD5qt": "allow",
      "stop:20": "pass"
    }

Keys starting with `_` are metadata and ignored during validation/replay.

### Valid label values

| Hook type | Valid values |
|-----------|-------------|
| Tool calls (pre-tool-use) | `"allow"`, `"deny"` |
| Stop points (stop-response-check) | `"pass"`, `"block"` |

`"INVESTIGATE"` is a placeholder. It must be resolved before replay.
Tool_use_id prefixes (minimum 12 characters) are accepted as keys.

## Replay Output Format

A single JSON report to stdout, also written to `~/.agent-framework/test-runs/<name>/report.json`:

    {
      "transcript": "/path/to/transcript.jsonl",
      "label_file": "~/.agent-framework/test-runs/<name>/labels.json",
      "commit": "abc1234...",
      "total_hooks_fired": 185,
      "scored": 73,
      "passed": 71,
      "failed": 2,
      "errors": 0,
      "elapsed_ms": 45200,
      "failures": [...]
    }

- `commit`: the git commit hash at the time of the test run
- `total_hooks_fired`: all hooks including non-scored (session-start, user-prompt-submit, post-tool-use)
- `scored`: hooks with labels (pre-tool-use + stop-response-check)
- `failures`: only hooks where the actual decision differed from the label. Omitted when all pass
- `gate` and `reason` show which gate agent made the decision (matches `tool-log.jsonl`)

## Build

The harness automatically runs `just build` before firing hooks. No manual build step needed.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All scored passed, or generate-labels completed, or no expectations |
| 1 | Any scored expectation failed |
| 2 | Error: incomplete labels, invalid label file, build failure, or parse error |

## Automated Workflow (Subagents)

Two Claude Code subagents automate the labeling and testing workflow:

- **`@labeler`**: Finds unlabeled transcripts, runs `--generate-labels`, reviews labels with hindsight, writes `notes_and_questions.md` for uncertain decisions, finalizes `labels.json`.
- **`@tester`**: Finds labeled-but-untested transcripts, runs the harness, analyzes failures, fixes hook code, re-runs until passing.

See `claude/agents/labeler.md` and `claude/agents/tester.md` for details.

## Finding Transcripts

Transcripts live in `~/.claude/projects/`. Each project directory contains:

- **Main session transcripts**: `{session-uuid}.jsonl` -- files directly in the project directory
- **Subagent transcripts**: `{session-uuid}/subagents/agent-{id}.jsonl` -- inside subdirectories

**Only use main session transcripts** (the `*.jsonl` files at the top level, not inside `subagents/` directories).

**Filtering**: Some top-level `.jsonl` files are actually sidechain/subagent transcripts (both `agent-*.jsonl` and regular UUID files). Check the first line for `isSidechain` -- if present, skip that file.

To list available transcripts for this project:

    ls ~/.claude/projects/-home-tim-Coding-public-repos-agent-framework/*.jsonl

Do **not** read from `test-harness/fixtures/` -- use real transcripts from `~/.claude/projects/`.

**Do not read the replay script or harness source code.** This README is the complete interface -- follow the labeling workflow above, nothing else.

## Transcript Anatomy

Key fields on each JSONL line:

| Field | Description |
|-------|-------------|
| `type` | Line type: `user`, `assistant`, `system`, `permission-mode`, `file-history-snapshot` |
| `isMeta` | If `true`, this user message is system-injected (stop-hook feedback, slash command instructions), not real user input. Skipped during replay and filtered from hook agent context. |
| `isSidechain` | If `true`, belongs to a subagent transcript. Only use main session transcripts. |
| `message` | The API message object with `role` and `content`. |
| `stop_reason` | On assistant messages: `"end_turn"`, `"tool_use"`, or `null` (streaming chunk). |

## Known Limitations

- Replaying transcripts that contain baked-in synthetic entries (EnterPlanMode/ExitPlanMode) may duplicate them
- `ANTHROPIC_API_KEY` must be set -- hooks make real LLM calls
