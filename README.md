# Agent Framework

A TypeScript framework for custom AI agents using the Anthropic API. Agents are exposed via three mechanisms:

1. **MCP Server** - For `check`, `confirm`, `commit`, `push`, `validate_intent` agents (portable, works with any MCP client)
2. **PreToolUse Hook** - Multi-layer safety gate with `tool-approve`, `tool-appeal`, `error-acknowledge`, `plan-validate`, `style-drift`, and `claude-md-validate` agents
3. **Stop Hook** - For `intent-validate` agent (detects when AI goes off-track)

## Agents

The framework implements 12 specialized agents organized into three categories:

### MCP Tools (User-Facing)

| Agent           | Model  | Purpose                                                      |
| --------------- | ------ | ------------------------------------------------------------ |
| check           | sonnet | Run linter + make check, return summary with recommendations |
| confirm         | opus   | Binary quality gate: CONFIRMED or DECLINED                   |
| commit          | haiku  | Generate minimal commit message + execute git commit         |
| push            | -      | Execute git push with logging                                |
| validate_intent | haiku  | Check if AI followed user intentions (post-session review)   |

### Validation Agents (Hook-Triggered)

| Agent            | Model  | Hook        | Purpose                                        |
| ---------------- | ------ | ----------- | ---------------------------------------------- |
| intent-validate  | haiku  | Stop        | Detect off-topic questions or misunderstood requests |
| plan-validate    | sonnet | PreToolUse  | Detect plan drift from user intent             |
| error-acknowledge| haiku  | PreToolUse  | Detect when AI ignores errors or feedback      |
| style-drift      | haiku  | PreToolUse  | Detect unrequested cosmetic/style changes      |
| claude-md-validate| sonnet | PreToolUse  | Validate CLAUDE.md edits against conventions   |

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
├─ Auto-approve low-risk tools (Grep, Glob, LSP, MCP tools, etc.)
│
├─ error-acknowledge: Check if AI is ignoring errors
│  └─ BLOCK if errors not acknowledged
│
├─ Path-based classification for file tools
│  ├─ Trusted path (project dir or ~/.claude) + not sensitive → ALLOW
│  └─ plan-validate: Check for plan drift on ~/.claude/plans writes
│
├─ tool-approve: Evaluate tool call against CLAUDE.md + rules
│  └─ DENY → tool-appeal: Review with transcript context
│           ├─ OVERTURN: APPROVE → allow
│           ├─ OVERTURN: <reason> → deny with new reason
│           └─ UPHOLD → deny with original reason
│
└─ Workaround detection: Escalate after 3 similar denied attempts
```

## Build & Install

```bash
# Install dependencies
npm install

# Build
npm run build

# Register MCP server with Claude Code (see claude/mcp.json for config)
claude mcp add agent-framework node $(pwd)/dist/mcp/server.js

# Symlink to ~/.claude:
ln -s $(pwd)/dist/hooks ~/.claude/hooks
ln -s $(pwd)/claude/commands ~/.claude/commands
ln -s $(pwd)/claude/settings.json ~/.claude/settings.json
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

# Optional - Home Assistant logging
WEBHOOK_ID_AGENT_LOGS=your-webhook-id
```

## Home Assistant Integration

All agents log decisions to Home Assistant via webhook for monitoring and debugging:

```typescript
interface AgentLog {
  agent: string;    // Agent name (e.g., 'tool-approve', 'commit')
  level: string;    // 'info', 'error', 'decision', 'escalation'
  problem: string;  // What was evaluated
  answer: string;   // The decision made
}
```

Set `WEBHOOK_ID_AGENT_LOGS` environment variable to enable logging. Logs are fire-and-forget (non-blocking).

## Usage

### From Claude Code

Once configured, Claude Code can:

```
> Use the check tool to verify code quality
[Runs linter + make check, returns summary]

> Run confirm to check my changes
CONFIRMED

> Use commit to commit these changes
a1b2c3d
```

The tool-approve hook runs automatically on every tool call Claude tries to execute.

The intent-validate hook runs when Claude stops and is waiting for user input. It detects when Claude:

- Asks questions that were already answered earlier in the conversation
- Asks questions unrelated to what the user requested
- Suggests actions the user never asked for

When detected, it injects a course-correction message to get Claude back on track.

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
