# Agent Framework

A TypeScript framework for custom AI agents using the Anthropic API. Agents are exposed via three mechanisms:

1. **MCP Server** - For `check`, `confirm`, `commit`, `push`, `validate_intent`, `test_harness_labeler`, `test_harness_tester` agents (portable, works with any MCP client)
2. **PreToolUse Hook** - Rule-based safety pipeline with `rule-gate`, `tool-approve`, `tool-appeal`, `plan-validate`, `style-drift`, `claude-md-validate`, `question-validate`, `edit-intent`, and `error-acknowledge` agents
3. **Stop Hook** - For `response-align` agent (validates stop responses)

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical implementation details.

## Agents

The framework implements 17 specialized agents organized into three categories:

### MCP Tools (User-Facing)

| Agent           | Model  | Purpose                                                      |
| --------------- | ------ | ------------------------------------------------------------ |
| check           | sonnet | Run linter + make/just check, return summary with recommendations |
| confirm         | opus   | Binary quality gate: CONFIRMED or DECLINED                   |
| commit          | haiku  | Generate minimal commit message + execute git commit         |
| push            | -      | Execute git push with logging                                |
| validate_intent        | sonnet | Manual post-session review (requires transcript_path)        |
| test_harness_labeler   | -      | Test harness operations for the @labeler subagent            |
| test_harness_tester    | -      | Test harness operations for the @tester subagent             |

**Note on validate_intent**: Unlike other MCP tools, `validate_intent` is not auto-triggered. It's a manual post-session review tool that analyzes a conversation transcript to check if the AI followed user intentions. Requires `transcript_path` parameter pointing to a `.jsonl` transcript file. Returns `ALIGNED` or `DRIFTED` verdict.

**Note on test_harness tools**: These are subagent-only tools that wrap `test-harness/replay.ts` operations. The labeler tool handles transcript labeling workflows; the tester tool handles test execution and report reading. Neither makes LLM calls internally.

### Validation Agents (Hook-Triggered)

| Agent            | Model  | Hook        | Purpose                                        |
| ---------------- | ------ | ----------- | ---------------------------------------------- |
| rule-gate        | haiku  | PreToolUse  | Combined evaluator for triggered rule contexts |
| respond-first-quality | haiku | PreToolUse | Validate AI's first response acknowledges user message |
| error-acknowledge| haiku  | PreToolUse  | Require error acknowledgment before proceeding |
| plan-validate    | sonnet | PreToolUse  | Detect plan drift from user intent             |
| gate             | haiku  | PreToolUse  | Validate tool calls against user intent/errors |
| style-drift      | haiku  | PreToolUse  | Detect unrequested cosmetic/style changes      |
| claude-md-validate| sonnet | PreToolUse  | Validate CLAUDE.md edits against conventions   |
| question-validate| haiku  | PreToolUse  | Validate AskUserQuestion before showing to user|
| edit-intent      | haiku  | PreToolUse  | Classify user message as edit or non-edit intent|

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
│  ├─ respond-first (5): AI must respond before tools
│  ├─ low-risk (10): Auto-approve read-only tools
│  ├─ plan-mode-block (15): Block writes in plan mode
│  ├─ subagent (20): Subagent tool approval
│  ├─ question-validate (30): Validate AskUserQuestion
│  ├─ force-check-required (32): Lock to mcp__check after workaround denial
│  ├─ prediction-block (35): Block predicted-bad tools
│  ├─ drift-detect (40): Detect drift from intent
│  ├─ error-acknowledge (50): Require error acknowledgment
│  ├─ sensitive-path-block (58): Deny sensitive-path writes
│  ├─ edit-intent (60): Block edits without intent
│  ├─ style-drift (65): Detect style changes
│  ├─ gate (70): Gate agent contribution to rule-gate LLM
│  └─ tool-approve (100): Final tool approval
│     └─ fastDeny with appealable → tool-appeal with transcript
│
├─ plan-validate: Check for plan drift on ~/.claude/plans writes
├─ claude-md-validate: Validate CLAUDE.md edits
│
└─ Post-allow bookkeeping (tool count, ExitPlanMode cleanup)
```

## Performance

Every rule runs on every tool call. Rules short-circuit with `fastAllow` or `fastDeny` (pure TypeScript, <10ms) or contribute `llmContext`. Triggered `llmContext` rules are aggregated into a single rule-gate haiku LLM call. Subagents use a dedicated lightweight path via `subagentRule` with `skipLlmOnClean: true`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details.

## Build & Install

```bash
# Install dependencies
npm install

# Build
npm run build

# Set env var (add to shell profile)
export AGENT_FRAMEWORK_ROOT=/path/to/agent-framework

# Register MCP server with Claude Code
claude mcp add agent-framework node $AGENT_FRAMEWORK_ROOT/dist/mcp/server.js

# Symlink commands (slash commands like /check, /commit)
ln -s $AGENT_FRAMEWORK_ROOT/claude/commands ~/.claude/commands

# Symlink skills (auto-applied by Claude when relevant)
ln -s $AGENT_FRAMEWORK_ROOT/claude/skills ~/.claude/skills

# Copy settings.json (hooks use $AGENT_FRAMEWORK_ROOT internally)
cp $AGENT_FRAMEWORK_ROOT/claude/settings.json ~/.claude/settings.json
```

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

## Claude Code Tool Names

The `PreToolUse` hook intercepts tool calls. To configure which tools trigger your hook, you need to know the exact tool names Claude Code uses.

### How Tool Names Were Discovered

**The problem**: Claude Code's documentation doesn't provide a complete list of tool names. We needed to find them to properly configure hook matchers.

**Discovery process**:

1. **Web search** - Searched for "Claude Code PreToolUse hook matcher tool names" but official docs only mention a few examples (Bash, Edit, Write, Read)

2. **SDK type definitions** - The `@anthropic-ai/claude-agent-sdk` package contains TypeScript definitions. Found the tool list by exploring:

   ```bash
   find node_modules -name "*.d.ts" -path "*anthropic*"
   ```

3. **Found the source** - The file `sdk-tools.d.ts` contains a `ToolInputSchemas` union type that defines input schemas for ALL tools. The tool name maps to the input type name (e.g., `BashInput` → tool name `Bash`, `FileReadInput` → tool name `Read`)

```bash
# The SDK exposes tool input schemas in:
node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts
```

This file defines a `ToolInputSchemas` union type that lists all available tools:

```typescript
export type ToolInputSchemas =
  | AgentInput // Tool: Agent (or Task)
  | BashInput // Tool: Bash
  | TaskOutputInput // Tool: TaskOutput
  | ExitPlanModeInput // Tool: ExitPlanMode
  | FileEditInput // Tool: Edit
  | FileReadInput // Tool: Read
  | FileWriteInput // Tool: Write
  | GlobInput // Tool: Glob
  | GrepInput // Tool: Grep
  | KillShellInput // Tool: KillShell
  | ListMcpResourcesInput // Tool: ListMcpResources
  | McpInput // Tool: mcp__<server>__<tool>
  | NotebookEditInput // Tool: NotebookEdit
  | ReadMcpResourceInput // Tool: ReadMcpResource
  | TodoWriteInput // Tool: TodoWrite
  | WebFetchInput // Tool: WebFetch
  | WebSearchInput // Tool: WebSearch
  | AskUserQuestionInput; // Tool: AskUserQuestion
```

Additional tools exist but aren't in the SDK types:
- `LSP` - Language Server Protocol queries
- `EnterPlanMode` - Enter planning mode
- `Skill` - Invoke skills like /commit, /push

### Tool Risk Categories

| Risk Level     | Tools                                                                                                                                                                         | Notes                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Low**        | `LSP`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `ListMcpResources`, `ReadMcpResource`, `TodoWrite`, `TaskOutput`, `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `Skill` | Read-only or no filesystem impact          |
| **Low**        | `mcp__*`                                                                                                                                                                      | All MCP tools auto-approved                |
| **Path-based** | `Read`, `Write`, `Edit`, `NotebookEdit`                                                                                                                                       | Low if inside project or `~/.claude/`, otherwise high |
| **High**       | `Bash`, `Agent`/`Task`, `KillShell`                                                                                                                                           | Execute commands, spawn agents             |

**Path-based classification**: File tools are auto-approved when:
- File path is inside the project directory (`CLAUDE_PROJECT_DIR` or cwd), OR
- File path is inside `~/.claude/` (Claude Code's own files)
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

# Optional - set by Claude Code automatically
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
- **SDK mode**: Only supports `claude-subscription` (Claude Code subprocess cannot use custom base URLs)

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

### From Claude Code

Once configured, Claude Code can:

```
> Use the check tool to verify code quality
[Runs linter + make/just check, returns summary]

> Run confirm to check my changes
CONFIRMED

> Use commit to commit these changes
a1b2c3d
```

The tool-approve hook runs automatically on every tool call Claude tries to execute.

The respond-first-quality agent runs on the first tool call after a user message. It verifies the AI's text response adequately acknowledges, interprets, and states planned actions before proceeding with tools.

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
