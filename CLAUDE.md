# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TypeScript framework for custom AI agents using the Claude Agent SDK. Agents are exposed via MCP Server, PreToolUse Hook, and Stop Hook mechanisms.

## Architecture

### Agent Tiers (configured in `src/types.ts`)

Model IDs are centrally defined in `src/types.ts`. Update there to change models globally.

| Tier   | Usage                                                                          |
| ------ | ------------------------------------------------------------------------------ |
| haiku  | Fast validation: intent-validate, error-acknowledge, tool-approve, tool-appeal |
| sonnet | Detailed analysis: check, plan-validate, commit                                |
| opus   | Complex decisions: confirm                                                     |

### Three Exposure Mechanisms

1. **MCP Server** (`src/mcp/server.ts`) - Exposes `check`, `confirm`, `commit` tools
2. **PreToolUse Hook** (`src/hooks/pre-tool-use.ts`) - Multi-layer safety gate (~400 lines, most complex file)
3. **Stop Hook** (`src/hooks/stop-off-topic-check.ts`) - Detects off-topic AI behavior

### Agent Chaining

```
check ─────────────────────────► (runs independently)
confirm ──► runCheckAgent() ───► (check must pass first)
commit ───► runConfirmAgent() ─► runCheckAgent() ─► (full chain)
```

### PreToolUse Hook Flow

```
Tool Call → Auto-approve low-risk → error-acknowledge check → Path-based classification
→ tool-approve → (if denied) tool-appeal → Workaround detection (3+ similar denials)
```

### Tool Risk Categories

- **Low-risk (auto-approved)**: LSP, Grep, Glob, WebSearch, WebFetch, TodoWrite, mcp\_\_\* tools
- **Path-based**: Read, Write, Edit, NotebookEdit (approved if inside project or ~/.claude/, denied if sensitive)
- **High-risk**: Bash, Agent/Task, KillShell

### Directory Structure

```
src/
  agents/
    mcp/          # MCP-exposed agents (SDK streaming): check, confirm, commit, push
    hooks/        # Hook-triggered agents (direct API): tool-approve, tool-appeal, etc.
  hooks/          # Claude Code hook entry points
  mcp/            # MCP server
  utils/          # Shared utilities
```

See `ARCHITECTURE.md` for detailed documentation on design decisions.

### Key Files

| File                             | Purpose                            |
| -------------------------------- | ---------------------------------- |
| `src/types.ts`                   | Model IDs (single source of truth) |
| `src/hooks/pre-tool-use.ts`      | Main safety logic                  |
| `src/agents/mcp/`                | MCP agents (check, confirm, commit)|
| `src/agents/hooks/`              | Hook agents (tool-approve, etc.)   |
| `src/utils/anthropic-client.ts`  | Singleton Anthropic client factory |
| `src/utils/agent-query.ts`       | Claude Agent SDK wrapper           |

## Integration

```bash
# Register MCP server
claude mcp add agent-framework node $(pwd)/dist/mcp/server.js

# Copy hook config to project
cp claude-integration/settings.json /your/project/.claude/settings.json
# Update paths in settings.json to point to dist/hooks/*.js
```

## Testing MCP Server

Only do this when explicitly mentioned by the user

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check","arguments":{"working_dir":"."}}}\n' | node dist/mcp/server.js
```

## Environment Variables

- `ANTHROPIC_API_KEY` - Required
- `CLAUDE_PROJECT_DIR` - Set automatically by Claude Code
- `WEBHOOK_ID_AGENT_LOGS` - Optional, enables Home Assistant logging
