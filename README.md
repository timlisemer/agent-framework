# Agent Framework

A TypeScript framework for custom AI agents using the Anthropic API. Agents are exposed via three mechanisms:

1. **MCP Server** - For `check`, `confirm`, `commit`, `push`, `validate_intent`, `scenario_labeler`, `scenario_tester` agents (portable, works with any MCP client)
2. **PreToolUse Hook** - Rule-based safety pipeline with `rule-gate`, `tool-approve`, `tool-appeal`, `plan-validate`, `style-drift`, `claude-md-validate`, `question-validate`, `edit-intent`, and `error-acknowledge` agents
3. **Stop Hook** - For `response-align-stop` rule (validates stop responses)
4. **UserPromptSubmit Hook** - For `sentiment` rule (classifies user mood/intent before each tool call sequence)

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical implementation details.

## Agents

The framework implements 16 specialized agents organized into three categories:

### MCP Tools (User-Facing)

| Agent           | Model  | Purpose                                                      |
| --------------- | ------ | ------------------------------------------------------------ |
| check           | sonnet | Run linter + make/just check, return summary with recommendations |
| confirm         | opus   | Binary quality gate: CONFIRMED or DECLINED                   |
| commit          | haiku  | Generate minimal commit message + execute git commit         |
| push            | -      | Execute git push with logging                                |
| validate_intent        | haiku  | Manual post-session review (requires transcript_path)        |
| scenario_labeler   | -      | Test harness operations for the @labeler agent role          |
| scenario_tester    | -      | Test harness operations for the @tester agent role           |

**Note on validate_intent**: Unlike other MCP tools, `validate_intent` is not auto-triggered. It's a manual post-session review tool that analyzes a conversation transcript to check if the AI followed user intentions. Requires `transcript_path` parameter pointing to a `.jsonl` transcript file. Returns `ALIGNED` or `DRIFTED` verdict.

**Note on scenario tools**: These tools wrap scenario runner operations for the labeler and tester workflows. The labeler tool handles transcript labeling workflows; the tester tool handles test execution and report reading. Neither makes LLM calls internally.

### Validation Agents (Hook-Triggered)

| Agent            | Model  | Hook        | Purpose                                        |
| ---------------- | ------ | ----------- | ---------------------------------------------- |
| rule-gate           | haiku  | PreToolUse        | Combined evaluator for triggered rule contexts |
| error-acknowledge   | haiku  | PreToolUse        | Require error acknowledgment before proceeding |
| plan-validate       | sonnet | PreToolUse        | Detect plan drift from user intent             |
| style-drift         | haiku  | PreToolUse        | Detect unrequested cosmetic/style changes (aggregator) |
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
commit ───► runConfirmAgent() ─► runCheckAgent() ─► (full chain)
```

The `commit` agent enforces the complete verification chain before committing.

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
│  ├─ force-check-required (32): Lock to mcp__check after workaround denial
│  ├─ prediction-block (35): Block predicted-bad tools (appealable)
│  ├─ low-risk (38): Auto-approve read-only tools
│  ├─ drift-detect (40): Detect drift from intent (appealable)
│  ├─ error-acknowledge (50): Require error acknowledgment (appealable, LLM)
│  ├─ trusted-path (58): Deny sensitive-path writes
│  ├─ edit-intent (60): Block edits without intent (appealable)
│  ├─ style-drift (65): Detect style changes (appealable, LLM)
│  ├─ gate (70): Gate agent contribution to rule-gate LLM
│  └─ tool-approve (100): Final tool approval (appealable, LLM)
│     └─ fastDeny with appealable → tool-appeal with transcript
│
│  Symmetric short-circuit guards: a later fastAllow OR fastDeny is deferred
│  whenever a higher-priority rule has emitted llmContext, so the rule-gate
│  aggregator's judgment is always authoritative.
│
├─ plan-validate: Check for plan drift on active adapter plan writes
├─ claude-md-validate: Validate CLAUDE.md edits
│
└─ Post-allow bookkeeping (tool count, ExitPlanMode cleanup)
```

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

## Tool Names

The `PreToolUse` hook intercepts tool calls. To configure which tools trigger your hook, you need to know the exact tool names the host agent uses.

### Bash Authorization vs Safety

`prediction-block` handles user-intent authorization, not full Bash safety. If
the latest user message clearly implies Bash (for example, asking the agent to
check logs with Bash commands), prediction-block must not deny simply to demand
a second Bash authorization. Separate safety layers still apply: deterministic
blacklist checks run before prediction-block, and `tool-approve` evaluates the
command afterward for task fit and policy violations.

### Tool Risk Categories

| Risk Level     | Tools                                                                                                                                                                         | Notes                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Low**        | `LSP`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `ListMcpResources`, `ReadMcpResource`, `TodoWrite`, `TaskOutput`, `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `Skill` | Read-only or no filesystem impact          |
| **Low**        | `mcp__*`                                                                                                                                                                      | All MCP tools auto-approved                |
| **Path-based** | `Read`, `Write`, `Edit`, `NotebookEdit`                                                                                                                                       | Low if inside project or `~/.claude/`, otherwise high |
| **High**       | `Bash`, `Agent`/`Task`, `KillShell`                                                                                                                                           | Execute commands, spawn agents             |

**Path-based classification**: File tools are auto-approved when:
- File path is inside the project directory (`CLAUDE_PROJECT_DIR` or cwd), OR
- File path is inside `~/.claude/` (the host agent's own files)
- AND the path doesn't match sensitive patterns (`.env`, `credentials`, `.ssh`, `.aws`, `secrets`, `.key`, `.pem`, `password`)

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
- `"(Bash|Edit|Write)"` - Only specific high-risk tools
- `"mcp__.*"` - Only MCP tools
- `""` (empty) - Matches all tools

**Important**: Tool names are case-sensitive. `Bash` ≠ `bash`.

## Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Required for hooks - avoids expensive filesystem traversal on every hook invocation
AGENT_FRAMEWORK_ROOT=/path/to/agent-framework

# Optional - set by the host agent automatically
CLAUDE_PROJECT_DIR=/path/to/project

# Optional - alternative API endpoint (e.g., OpenRouter)
# ANTHROPIC_BASE_URL=https://openrouter.ai/api
# ANTHROPIC_AUTH_TOKEN=your-openrouter-api-key

# Optional - provider configuration (see Provider Configuration section)
# AGENT_FRAMEWORK_PROVIDER=openrouter
# AGENT_FRAMEWORK_SDK_PROVIDER=claude-subscription

# Optional - telemetry (all three required if enabled)
# TELEMETRY_HOST_ID=your-host-id
# TELEMETRY_ENDPOINT=https://your-telemetry-endpoint.com
# AGENT_FRAMEWORK_API_KEY=your-api-key
```

## Provider Configuration

The framework supports two LLM providers:

| Provider | Description | Cost Tracking |
|----------|-------------|---------------|
| `openrouter` | OpenRouter API (default) | Via generation IDs, shown on LLM cost dashboard |
| `claude-subscription` | Claude Pro/Max subscription | Excluded from cost dashboard (included in subscription) |

### Configuration Methods

**Environment variables** (highest priority):
```bash
# Global default
export AGENT_FRAMEWORK_PROVIDER=openrouter

# Per-mode overrides
export AGENT_FRAMEWORK_DIRECT_PROVIDER=openrouter
export AGENT_FRAMEWORK_SDK_PROVIDER=claude-subscription
```

**Config file** (`.agent-framework.json` in project root or `~/.config/agent-framework/config.json`):
```json
{
  "default": "openrouter",
  "modes": {
    "sdk": "claude-subscription"
  }
}
```

### Provider Constraints

- **Direct mode**: Supports both `openrouter` and `claude-subscription`
- **SDK mode**: Only supports `claude-subscription` (the host agent's SDK subprocess cannot use custom base URLs)

### Recommended Setup

Use OpenRouter for direct API agents (cheaper models like Grok, Gemini) and Claude subscription for SDK mode (confirm agent):

```json
{
  "default": "openrouter",
  "modes": {
    "sdk": "claude-subscription"
  }
}
```

This gives you:
- Fast, cheap haiku/sonnet agents via OpenRouter
- Unlimited confirm agent usage via Claude subscription
- Full telemetry tracking (events tracked, just excluded from cost dashboard for subscription)

## Usage

### From the Host Agent

Once configured, the agent can:

```
> Use the check tool to verify code quality
[Runs linter + make/just check, returns summary]

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

This project does not have automated tests.
