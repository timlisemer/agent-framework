# Agent Framework

A TypeScript framework for custom AI agents using the Claude Agent SDK. Agents are exposed via two mechanisms:

1. **MCP Server** - For `check`, `confirm`, `commit` agents (portable, works with any MCP client)
2. **PreToolUse Hook** - For `tool-approve` agent (intercepts Claude Code's bash commands)

## Agents

| Agent | Model | Mechanism | Purpose |
|-------|-------|-----------|---------|
| tool-approve | haiku | PreToolUse Hook | Approve/deny bash commands based on CLAUDE.md + common sense |
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
# Update the path in settings.json to point to your dist/hooks/pre-tool-use.js
```

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
