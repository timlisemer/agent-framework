# Agent Framework

A TypeScript framework for custom AI agents using the Claude Agent SDK. Agents are exposed via three mechanisms:

1. **MCP Server** - For `check`, `confirm`, `commit` agents (portable, works with any MCP client)
2. **PreToolUse Hook** - For `tool-approve` agent (intercepts Claude Code's bash commands)
3. **Stop Hook** - For `off-topic-check` agent (detects when AI goes off-track)

## Agents

| Agent | Model | Mechanism | Purpose |
|-------|-------|-----------|---------|
| tool-approve | haiku | PreToolUse Hook | Approve/deny bash commands based on CLAUDE.md + common sense |
| off-topic-check | haiku | Stop Hook | Detect when AI asks irrelevant/already-answered questions |
| check | sonnet | MCP Tool | Linter + make check -> summary with recommendations |
| confirm | opus | MCP Tool | Binary gate: CONFIRMED or DECLINED |
| commit | sonnet | MCP Tool | Generate commit message + commit |

## Build & Install

```bash
# Install dependencies
npm install

# Build
npm run build

# Register MCP server with Claude Code
claude mcp add agent-framework node $(pwd)/dist/mcp/server.js

# Copy hook config to your project
cp claude-integration/settings.json /your/project/.claude/settings.json
# Update the paths in settings.json to point to your dist/hooks/*.js
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
  | AgentInput        // Tool: Agent (or Task)
  | BashInput         // Tool: Bash
  | TaskOutputInput   // Tool: TaskOutput
  | FileEditInput     // Tool: Edit
  | FileReadInput     // Tool: Read
  | FileWriteInput    // Tool: Write
  | GlobInput         // Tool: Glob
  | GrepInput         // Tool: Grep
  | KillShellInput    // Tool: KillShell
  | ListMcpResourcesInput  // Tool: ListMcpResources
  | McpInput          // Tool: mcp__<server>__<tool>
  | NotebookEditInput // Tool: NotebookEdit
  | ReadMcpResourceInput   // Tool: ReadMcpResource
  | TodoWriteInput    // Tool: TodoWrite
  | WebFetchInput     // Tool: WebFetch
  | WebSearchInput    // Tool: WebSearch
  | AskUserQuestionInput   // Tool: AskUserQuestion
  // ... plus ExitPlanModeInput (internal)
```

Additional tool `LSP` (Language Server Protocol) exists but isn't in the SDK types.

### Tool Risk Categories

| Risk Level | Tools | Notes |
|------------|-------|-------|
| **Low** | `LSP`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `ListMcpResources`, `ReadMcpResource`, `TodoWrite`, `TaskOutput`, `AskUserQuestion` | Read-only or no filesystem impact |
| **Medium** | `Read`, `mcp__*` | Can access files; MCP tools vary by server |
| **High** | `Bash`, `Edit`, `Write`, `NotebookEdit`, `Agent`/`Task`, `KillShell` | Modify files, execute commands, spawn agents |

### Hook Matcher Configuration

In `settings.json`, the `matcher` field is a regex that determines which tools trigger your hook:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": ".*",           // Match ALL tools
      "hooks": [{ "type": "command", "command": "node /path/to/hook.js" }]
    }]
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

# Optional - set by Claude Code automatically
CLAUDE_PROJECT_DIR=/path/to/project
```

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

The tool-approve hook runs automatically on every bash command Claude tries to execute.

The off-topic-check hook runs when Claude stops and is waiting for user input. It detects when Claude:
- Asks questions that were already answered earlier in the conversation
- Asks questions unrelated to what the user requested
- Suggests actions the user never asked for

When detected, it injects a course-correction message to get Claude back on track.

### Programmatic Usage

```typescript
import { runCheckAgent } from "./agents/check.js";
import { runConfirmAgent } from "./agents/confirm.js";
import { runCommitAgent } from "./agents/commit.js";

const checkResult = await runCheckAgent("/path/to/project");
console.log(checkResult);

const confirmResult = await runConfirmAgent("/path/to/project");
if (confirmResult === "CONFIRMED") {
  await runCommitAgent("/path/to/project");
}
```

### Testing MCP Server Directly

You can test the MCP server using JSON-RPC messages via stdin:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"commit","arguments":{"working_dir":"/path/to/project"}}}\n' | node dist/mcp/server.js
```
