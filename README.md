# Agent Framework

A TypeScript framework for custom AI agents using the Anthropic API. Agents are exposed via three mechanisms:

1. **MCP Server** - For `check`, `confirm`, `fullconfirm`, `commit`, `push`, `implement`, `validate_implementation`, `validate_intent`, `create_planfile`, `validate_plan`, `scenario_labeler`, `scenario_tester`, `locate_scenario` tools (portable, works with any MCP client)
2. **PreToolUse Hook** - Rule-based safety pipeline with `rule-gate`, `tool-approve`, `tool-appeal`, `claude-md-validate`, `question-validate`, `edit-intent`, and `error-acknowledge` agents
3. **Stop Hook** - For `response-align-stop` and Codex `<proposed_plan>` acceptance validation
4. **UserPromptSubmit Hook** - For `sentiment` rule and slash/skill workflow prediction seeding before each tool call sequence

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical implementation details.

## AI Backend

The `ai-backend` package entry runs a provider-neutral JSONL session backend
for UI clients. Clients send typed `startSession`, `sendInput`,
`listSessionChoices`, `resumeSession`, `closeSession`, snapshot, event-cursor,
plan-state, tool-decision, and cancel frames. The backend emits ordered session,
turn lifecycle, session-update, continuation, plan-state, provider-metadata,
and error events plus request-correlated `sessionChoices`, `sessionClosed`,
and `requestError` responses using the local protocol exported from
`src/ai-protocol`. Visible transcript rows and tool calls are rebuilt from
provider transcripts through per-event timeline snapshots rather than reduced
from provider stream items. Snapshots carry transcript-projected messages,
tool state, provider metadata, usage, context-window details, compaction
events, and agent-framework session bindings; runtime control events only
cover continuation, plan state, provider metadata, timeline snapshots, turn
completion, and errors. Claude manual tool approvals are overlaid onto the
current transcript snapshot while the SDK is blocked on `canUseTool`, using
the native tool-use ID for follow-up decisions. `sdkRuntimeHome:
"managedAstral"` enables managed Claude/Codex homes and resumable history
discovery for user-runtime sessions. Managed Astral homes mirror the bundled
adapter dotfolders under `adapters/claude/dotclaude` and
`adapters/codex/dotcodex` while preserving local auth files.
The protocol is owned in this repository and uses opaque resume targets instead
of native runtime IDs. Build before running the backend:

```bash
npm run build
npm run ai-backend
```

## Agents

The framework implements specialized agents and MCP tools organized into three categories:

### MCP Tools (User-Facing)

| Agent           | Model  | Purpose                                                      |
| --------------- | ------ | ------------------------------------------------------------ |
| check           | sonnet | Run linter + make/just check plus deterministic filename-reference diagnostics, repository-wide style-drift warnings, and supplemental editor diagnostics, return summary with recommendations |
| confirm         | opus   | Binary quality gate using three SDK reviewers plus aggregator |
| fullconfirm     | opus   | Full tracked-repository quality gate using three SDK reviewers plus aggregator |
| commit          | haiku  | Generate minimal commit message + execute git commit         |
| push            | -      | Execute git push with logging                                |
| validate_intent        | haiku  | Manual post-session review (requires transcript_path)        |
| implement              | sonnet | Plan implementation workflow through internal write SDK agent |
| validate_implementation| sonnet | Read-only validation of completed implementation against plan |
| create_planfile        | -      | Create a named planfile and validate it                     |
| validate_plan          | sonnet | Validate an existing planfile against the planning contract  |
| scenario_labeler   | -      | Test harness operations for the @labeler agent role          |
| scenario_tester    | -      | Scenario execution, reports, and capture materialization     |
| locate_scenario    | haiku  | Locate captured scenario candidates from quote substrings    |

**Note on validate_intent**: Unlike other MCP tools, `validate_intent` is not auto-triggered. It's a manual post-session review tool that analyzes a conversation transcript to check if the AI followed user intentions. Requires `transcript_path` parameter pointing to a `.jsonl` transcript file. Returns `ALIGNED` or `DRIFTED` verdict.

**Note on scenario tools**: These tools wrap scenario runner operations for the labeler and tester workflows. The labeler tool handles transcript labeling workflows; the tester tool handles test execution, report reading, and `materialize_scenario` for converting live capture pointers into stored scenario JSON. Neither makes LLM calls internally.

**Note on locate_scenario**: This tool replaces the manual `scenarios/LOCATE-SCENARIO.md` recipe. It accepts one or more quote substrings, runs predefined literal searches over raw Claude/Codex transcripts and agent-framework session logs, resolves candidate session directories/capture sequences where possible, and uses a haiku-level LLM only to summarize successful findings. If no predefined search matches, it returns a failure notice plus manual fallback guidance.

**Style-drift warnings:** `check` performs a bounded scan of tracked and non-ignored untracked text files and reports unreadable, non-regular, or safety-limit omissions in its warning output. Intentional fixtures can place `agent-framework-style-drift-ignore-next-line` in a comment immediately above one exempt line, or `agent-framework-style-drift-ignore-file` in a comment to exempt a fixture file. These markers affect only deterministic style warnings.

Rust policy warnings include Clippy `allow`/`expect` excuses, dead or unused-code suppressions, and the explicitly prohibited crate attribute `#![warn(clippy::disallowed_types)]`.

### Validation Agents (Hook-Triggered)

| Agent            | Model  | Hook        | Purpose                                        |
| ---------------- | ------ | ----------- | ---------------------------------------------- |
| rule-gate           | haiku  | PreToolUse        | Combined evaluator for triggered rule contexts |
| error-acknowledge   | haiku  | PreToolUse        | Require error acknowledgment before proceeding |
| plan-validate       | sonnet | Stop / MCP helper | Validate plan contract and user-intent fit     |
| claude-md-validate  | sonnet | PreToolUse        | Validate CLAUDE.md edits against conventions   |
| question-validate   | haiku  | PreToolUse        | Validate AskUserQuestion before showing to user (side-effect) |
| validate-intent     | haiku  | PreToolUse        | Check if AI followed user intentions (side-effect) |
| edit-intent         | haiku  | PreToolUse        | Classify user message as edit or non-edit intent|
| sentiment           | haiku  | UserPromptSubmit  | Classify user mood/intent; update session state (side-effect) |
| response-align-stop | haiku  | Stop              | Validate stop responses; block stalls and plain-text questions (side-effect) |

### Approval Agents (PreToolUse Hook)

| Agent        | Model | Purpose                                            |
| ------------ | ----- | -------------------------------------------------- |
| tool-approve | haiku | Approve/deny tools based on CLAUDE.md + safety rules |
| tool-appeal  | haiku | Review denials with conversation context           |

## Agent Chaining

Agents call each other in verification chains:

```
check ─────────────────────────► (runs independently)
confirm ──► runCheckAgent() ───► (check must pass first)
fullconfirm ─► runCheckAgent() ─► (check must pass first)
commit ───► normalize moved files ─► runConfirmAgent() ─► runCheckAgent() ─► (full chain)
implement ─► internal write SDK agent ─► runCheckAgent() ─► read-only implementation validator
validate_implementation ─► runCheckAgent() ─► read-only implementation validator
```

The `commit` agent may stage detected moved+recreated path pairs before confirm
so Git reports them as renames, then enforces the complete verification chain
before committing.

The `implement` workflow is MCP-owned: it runs a write-capable internal SDK
agent for the approved planfile, runs parent-owned checks, then validates the
result with a read-only SDK validator. `validate_implementation` runs the check
and validator half for already-applied changes.

## PreToolUse Hook Flow

```
┌─ Tool Call Received
│
├─ Rule Pipeline (evaluateRules, sequential by priority):
│  ├─ respond-first (5): AI must respond before tools (deterministic)
│  ├─ plan-mode-block (15): Block writes in plan mode; fast-allow plan files
│  ├─ background-agent-block (25): Deny Agent(run_in_background=true)
│  ├─ prediction-question-judge (28): Block stalling AskUserQuestion under frustration
│  ├─ question-validate (30): Validate AskUserQuestion
│  ├─ force-check-required (32): Lock to check-satisfying MCPs after workaround denial
│  ├─ prediction-block (35): Block predicted-bad tools (deterministic, non-appealable)
│  ├─ create-planfile-allow (36): Deterministically allow authorized create_planfile calls
│  ├─ drift-detect (40): Detect drift from intent (appealable)
│  ├─ error-acknowledge (50): Require error acknowledgment (appealable, LLM)
│  ├─ trusted-path (58): Deny sensitive-path access
│  ├─ edit-intent (60): Block edits without intent (appealable)
│  ├─ gate (70): Gate agent contribution to rule-gate LLM
│  └─ tool-approve (100): Final tool approval (appealable, LLM)
│     └─ fastDeny with appealable → tool-appeal with transcript
│
│  Symmetric short-circuit guards: a later fastAllow OR fastDeny is deferred
│  whenever a higher-priority rule has emitted llmContext, so the rule-gate
│  aggregator's judgment is always authoritative.
│
│  Workflow-only slash/skill invocations seed an ordered
│  `explicitlyRequiredTools` queue from canonicalized workflow instruction text. The
│  prediction gate enforces the next required tool, `nonBlockingTools` may run
│  without consuming the queue. Default non-blocking support tools are derived
│  from the shared low-risk tool list, excluding queue-consuming waits.
│
├─ claude-md-validate: Validate CLAUDE.md edits
│
└─ Post-allow bookkeeping (tool count, ExitPlanMode cleanup)
```

Planfile writes are no longer validated on every file edit tool call.
Plan1/plan3/plan5 consolidation calls `create_planfile`, which resolves the
current session through the shared agent-framework session resolver, writes the
named planfile, normalizes the header/footer, and runs the plan contract
validator immediately. MCP calls without a transcript path recover the current
session from the latest `transcript-path.txt` sidecar for the active project.
`validate_plan` remains available for explicit revalidation and for the
remediation workflow shown in validation failures. Codex Stop-hook acceptance
resolves the file-backed planfile through the shared planfile locator. Existing
populated matching planfiles are the source of truth: the Stop hook validates
or trusts the exact file content instead of overwriting it from inline
`<proposed_plan>` transcript text. Missing or empty planfiles keep the extracted
content so the remediation workflow has a concrete file to edit. If the first
inline Codex plan has no valid `Plan Name` and the session has no accepted
planfiles yet, the Stop hook derives a session planfile name, creates that
planfile through the same creator path, validates it, and blocks with the
created path plus validation feedback. The session current-plan sidecar is
updated only after validation passes.

Captured hook decisions can be reconstructed through the `scenario_tester` MCP
action `materialize_scenario`. The materializer reads `transcript-path.txt`,
parses the raw transcript through the inferred adapter (`/.claude/` or
`/.codex/`, with active-adapter fallback), writes the scenario under
`~/.agent-framework/test-runs/scenarios/`, and can immediately run it with
`run_materialized: true`. Use this MCP action instead of `node -e` snippets in
agent sessions.

Captured scenario lookup should go through the `locate_scenario` MCP first. It
searches quote substrings across raw adapter transcripts and live
agent-framework session logs, summarizes found candidates, and tells the caller
to materialize via the adapter-active `scenario_tester` MCP only when the user
already requested materialization.

## Performance

Every rule runs on every tool call. Rules short-circuit with `fastAllow` or `fastDeny` (pure TypeScript, <10ms) or contribute `llmContext`. Triggered `llmContext` rules are aggregated into a single rule-gate haiku LLM call. `background-agent-block` non-appealably denies `Agent(run_in_background=true)` so Agent work stays foregrounded.

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details.

## Build & Install

```bash
# Install dependencies
npm install

# Build TypeScript and refresh Codex hook trust hashes
just build

# Set env var (add to shell profile)
export AGENT_FRAMEWORK_ROOT=/path/to/agent-framework

# Register MCP server with your AI coding tool
claude mcp add agent-framework node $AGENT_FRAMEWORK_ROOT/dist/mcp/server.js
```

`just build` compiles the TypeScript sources and rewrites the generated Codex
hook trust block in `adapters/codex/dotcodex/config.toml`. Codex stores a
`trusted_hash` for each unmanaged hook command so it can detect command changes
and require review before running hooks. These hashes are not secrets; they are
review fingerprints derived from `adapters/codex/dotcodex/hooks.json`.

### Deploy Dotfolders

The adapter dotfolders contain the host-agent configuration:

- `adapters/claude/dotclaude/` maps to `~/.claude/`.
- `adapters/codex/dotcodex/` maps to `~/.codex/`.

Linux manual copy:

```bash
mkdir -p ~/.claude ~/.codex
cp -a adapters/claude/dotclaude/. ~/.claude/
cp -a adapters/codex/dotcodex/. ~/.codex/
```

Linux symlink mode:

```bash
mkdir -p ~/.claude ~/.codex
ln -sfn "$PWD/adapters/claude/dotclaude/settings.json" ~/.claude/settings.json
ln -sfn "$PWD/adapters/codex/dotcodex/config.toml" ~/.codex/config.toml
ln -sfn "$PWD/adapters/codex/dotcodex/hooks.json" ~/.codex/hooks.json
ln -sfn "$PWD/adapters/codex/dotcodex/AGENTS.md" ~/.codex/AGENTS.md
```

For Codex, copy skill directories if you use agent-framework skills because
Codex skill discovery does not reliably follow symlinked skill directories:

```bash
mkdir -p ~/.codex/skills ~/.codex/agents
cp -a adapters/codex/dotcodex/skills/. ~/.codex/skills/
ln -sfn "$PWD"/adapters/codex/dotcodex/agents/*.toml ~/.codex/agents/
```

Automated deployment:

```bash
# mcp-toolbox clones agent-framework, runs npm install && just build,
# then exposes the built repo through its Docker volume.
make -C /path/to/mcp-toolbox build
make -C /path/to/mcp-toolbox run
```

On NixOS, symlinks into the host agent config dirs are normally managed
declaratively. Run `nixos-rebuild switch` after `just build` to activate new
hook scripts or regenerated Codex hook trust hashes. See
[`adapters/claude/README.md`](adapters/claude/README.md) and
[`adapters/codex/README.md`](adapters/codex/README.md) for adapter details.

For manual MCP config (alternative to `claude mcp add`):
```json
{
  "mcpServers": {
    "agent-framework": {
      "command": "node",
      "args": ["/path/to/agent-framework/dist/mcp/server.js"]
    }
  }
}
```

When the host supports per-server tool timeout configuration, set the
agent-framework MCP host timeout to an effectively disabled value
(`2147483647`). Agent-framework enforces its own adapter-independent active-work
timeouts: tools default to 300 seconds. Direct `check` calls use a 300-second
command timeout plus a 30-second summary grace window, and check subprocess
runtime is governed by the command timeout instead of consuming the MCP
active-work budget. `commit`, `confirm`, `fullconfirm`, `implement`, and
`validate_implementation` use 1500 seconds, and time spent waiting for MCP
elicitation forms does not count against the active-work budget.

Codex has a repository-managed MCP server entry in
`adapters/codex/dotcodex/config.toml`, so that host timeout is checked in
there. Claude Code MCP registration is user/project managed through
`claude mcp add` or `--mcp-config`; this repository does not ship a Claude MCP
server config file to edit. The timeout policy still remains adapter-independent
because every Claude and Codex MCP call reaches the same `src/mcp/server.ts`
wrapper and `src/mcp/timeout.ts` budget logic.

## Tool Names

The `PreToolUse` hook intercepts tool calls. To configure which tools trigger your hook, you need to know the exact tool names the host agent uses.

### Bash Authorization vs Safety

`prediction-block` handles user-intent authorization, not full Bash safety. If
the latest user message clearly implies Bash (for example, asking the agent to
check logs with Bash commands), prediction-block must not deny simply to demand
a second Bash authorization. Separate safety layers still apply: deterministic
blacklist checks run before prediction-block, and `tool-approve` evaluates the
command afterward for task fit and policy violations.

Bash safety is implemented through `src/utils/bash-policy/`: a shared analyzer
tokenizes shell segments, unwraps supported command wrappers, and exposes shell,
`eval`, and `xargs` payloads to focused topic classifiers. The public
`blacklist` vocabulary remains stable, but the registry now selects one terminal
owner for each Bash command: git, check-routed, read-only, file-write,
script-exec, run/install/remote, find/sed, or fallback. Check/typecheck/build/
lint/test/format commands such as `npx --yes tsc --noEmit` are routed
deterministically to the agent-framework check MCP instead of being left to
prediction-block or prose-oriented regex matching.

### Tool Risk Categories

| Risk Level     | Tools                                                                                                                                                                         | Notes                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Low**        | `LSP`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `ListMcpResources`, `ReadMcpResource`, `TodoWrite`, `TaskOutput`, `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `Skill` | Read-only or no filesystem impact          |
| **Low**        | `mcp__*`                                                                                                                                                                      | Low-risk prediction class unless slash-command gated or heavyweight |
| **Path-based** | `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`                                                                                                                          | Low if inside project or the active adapter's host config root, otherwise high |
| **High**       | `Bash`, `Agent`/`Task`, `KillShell`                                                                                                                                           | Execute commands, spawn agents             |

**Path-based classification**: File tools are auto-approved when:
- File path is inside the project directory (`AGENT_FRAMEWORK_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, or cwd), OR
- File path is inside the active adapter's host config root (`~/.claude/` for Claude, `~/.codex/` for Codex)
- AND the path doesn't match sensitive patterns. Real environment files and local variants, credential/secret/password names, `.ssh`, `.aws`, `.gnupg`, `.kube`, SOPS files, age keys, private-key names, and key-store material are blocked. See [provider-configuration.md](docs/provider-configuration.md) for a copyable provider configuration template.

### Hook Matcher Configuration

In `settings.json`, the `matcher` field is a regex that determines which tools trigger your hook:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*", // Match ALL tools
        "hooks": [{ "type": "command", "command": "node /path/to/hook.js" }]
      }
    ]
  }
}
```

Common matcher patterns:

- `".*"` - All tools (recommended for full control)
- `"(Bash|Edit|MultiEdit|Write|NotebookEdit)"` - Only specific high-risk tools
- `"mcp__.*"` - Only MCP tools
- `""` (empty) - Matches all tools

**Important**: Tool names are case-sensitive. `Bash` ≠ `bash`.

## Environment Variables

See [provider-configuration.md](docs/provider-configuration.md) for the
copyable local configuration template, including hook paths, provider
selection, OpenRouter routing, and optional telemetry variables.

## Provider Configuration

The framework supports three LLM providers for both direct and SDK execution:

| Provider | Direct runtime | SDK runtime | Cost tracking |
|----------|----------------|-------------|---------------|
| `openrouter` | OpenRouter Anthropic API skin | Claude Agent SDK or Codex SDK | Direct calls use OpenRouter generation IDs |
| `claude-subscription` | Claude Agent SDK, one turn, no tools | Claude Agent SDK | Excluded from cost dashboard |
| `openai-subscription` | Codex SDK, one turn, no tools | Codex SDK | Excluded from cost dashboard |

See [`providers/`](providers/README.md) for provider-specific setup, official links, and subscription compliance notes.

### Configuration Methods

**Environment variables** (highest priority):
```bash
# Global default
export AGENT_FRAMEWORK_PROVIDER=openrouter

# Per-mode overrides
export AGENT_FRAMEWORK_DIRECT_PROVIDER=openrouter
export AGENT_FRAMEWORK_SDK_PROVIDER=openai-subscription

# OpenRouter SDK runtime choice
export AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME=codex # claude | codex
```

**Config file** (`.agent-framework.json` in project root or `~/.config/agent-framework/config.json`):
```json
{
  "default": "openrouter",
  "modes": {
    "direct": "openrouter",
    "sdk": "openai-subscription"
  },
  "providers": {
    "openrouter": {
      "sdkRuntime": "codex"
    }
  }
}
```

### Provider Notes

- `openrouter` direct mode uses `https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN`, and an explicitly empty `ANTHROPIC_API_KEY`.
- `openrouter` SDK mode uses `AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME=claude|codex`.
- `claude-subscription` scrubs API/OpenRouter env vars and uses persistent Claude sessions only for opt-in continuable SDK sessions.
- `openai-subscription` uses Codex SDK with ChatGPT/Codex sign-in and scrubs API env vars. Internal direct/read-only SDK runs use per-run framework-owned homes under `~/.agent-framework/internal/{direct,read-only}/codex/<runId>` plus volatile state, not raw `/tmp/agent-framework-*` homes. Internal write runs use disposable per-run homes under `~/.agent-framework/internal/write/codex/<runId>` and persist framework implementation session state under `~/.agent-framework/internal/sessions/write/<runId>`. User-runtime sessions use the normal Codex home/config unless `sdkRuntimeHome: "managedAstral"` requests the managed Astral Codex home under `~/.agent-framework/astral-ai/codex` for history listing and resume. Managed Astral refreshes replace framework-owned adapter config while preserving `sessions/` history and auth/local-secret files. Opt-in continuable SDK sessions keep live Codex thread state until the owning session is disposed.

`implement` is an MCP-owned workflow: the slash command/skill calls the MCP,
which runs the internal write implementer, runs parent-owned check, then runs
the read-only implementation validator. `validate_implementation` exposes the
validation half. Both tools accept `extra_context` only as exact quoted user
text.

### Example Setups

```json
{
  "default": "openrouter",
  "modes": {
    "sdk": "claude-subscription"
  }
}
```

```json
{
  "default": "openai-subscription"
}
```

## Usage

### From the Host Agent

Once configured, the agent can:

```
> Use the check tool to verify code quality
[Runs linter + make/just check plus deterministic filename-reference diagnostics (deleted/renamed errors and docs/config missing-file warnings), repository-wide style-drift warnings, and supplemental editor diagnostics, returns summary]

> Run confirm to check my changes
CONFIRMED

> Use commit to commit these changes
a1b2c3d
```

The tool-approve hook runs automatically on every tool call the agent tries to execute.

The respond-first rule (priority 5) is purely deterministic: it fastDenies whenever the assistant calls a tool without first emitting any text in the current turn, with narrow carve-outs for slash commands, confirmation patterns, and inaction-complaint sentiment. Semantic alignment between text and user intent is left to prediction-block / gate / tool-approve.

### Programmatic Usage

```typescript
import { runCheckAgent } from './agents/mcp/check.js';
import { runConfirmAgent } from './agents/mcp/confirm.js';
import { runCommitAgent } from './agents/mcp/commit.js';

const checkResult = await runCheckAgent('/path/to/project');
console.log(checkResult);

const confirmResult = await runConfirmAgent('/path/to/project');
if (confirmResult === 'CONFIRMED') {
  await runCommitAgent('/path/to/project');
}
```

### Testing MCP Server Directly

You can test the MCP server using JSON-RPC messages via stdin:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"commit","arguments":{"working_dir":"/path/to/project"}}}\n' | node dist/mcp/server.js
```

## Testing

Automated tests use Vitest. `npm test` runs `vitest run`.

Use `just check` for the full repository check. It runs:

- `npx tsc --noEmit`
- `npx vitest run`
- `npx tsx scripts/check-fixture-purity.ts`
