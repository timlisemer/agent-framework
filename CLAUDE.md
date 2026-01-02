# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TypeScript framework for custom AI agents using the Anthropic API. Agents are exposed via MCP Server, PreToolUse Hook, and Stop Hook mechanisms.

## Architecture

### Agent Tiers (configured in `src/types.ts`)

Model IDs are centrally defined in `src/types.ts`. Update there to change models globally.

| Tier   | Usage                                                                                    |
| ------ | ---------------------------------------------------------------------------------------- |
| haiku  | Fast tasks: intent-validate, error-acknowledge, tool-approve, tool-appeal, commit, style-drift |
| sonnet | Detailed analysis: check, plan-validate, claude-md-validate                              |
| opus   | Complex decisions: confirm                                                               |

### Three Exposure Mechanisms

1. **MCP Server** (`src/mcp/server.ts`) - Exposes `check`, `confirm`, `commit`, `push`, `validate_intent` tools
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
claude/           # Claude Code integration (symlink targets)
  commands/       # Slash commands (check.md, commit.md, etc.)
  skills/         # Skills (pure Markdown, auto-applied by Claude)
  settings.json   # Hook configuration (uses $AGENT_FRAMEWORK_ROOT)
src/
  agents/
    mcp/          # MCP-exposed agents: check, confirm, commit, push, validate-intent
    hooks/        # Hook-triggered agents: tool-approve, tool-appeal, style-drift, etc.
  hooks/          # Claude Code hook entry points
  mcp/            # MCP server
  utils/          # Shared utilities
dist/             # Build output (hooks executed from here)
```

See `ARCHITECTURE.md` for detailed documentation on design decisions.

### Key Files

| File                             | Purpose                                     |
| -------------------------------- | ------------------------------------------- |
| `src/types.ts`                   | Model IDs (single source of truth)          |
| `src/hooks/pre-tool-use.ts`      | Main safety logic                           |
| `src/agents/mcp/`                | MCP agents (check, confirm, commit, push)   |
| `src/agents/hooks/`              | Hook agents (tool-approve, style-drift, etc.) |
| `src/utils/agent-configs.ts`     | Centralized agent configurations            |
| `src/utils/anthropic-client.ts`  | Singleton Anthropic client factory          |
| `claude/settings.json`           | Hook configuration for Claude Code          |

## Integration

```bash
# Set env var (add to shell profile)
export AGENT_FRAMEWORK_ROOT=/path/to/agent-framework

# Register MCP server
claude mcp add agent-framework node $AGENT_FRAMEWORK_ROOT/dist/mcp/server.js

# Symlink commands and skills
ln -s $AGENT_FRAMEWORK_ROOT/claude/commands ~/.claude/commands
ln -s $AGENT_FRAMEWORK_ROOT/claude/skills ~/.claude/skills

# Copy settings.json (hooks use $AGENT_FRAMEWORK_ROOT internally)
cp $AGENT_FRAMEWORK_ROOT/claude/settings.json ~/.claude/settings.json
```

## Testing MCP Server

Only do this when explicitly mentioned by the user

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check","arguments":{"working_dir":"."}}}\n' | node dist/mcp/server.js
```

## Environment Variables

- `ANTHROPIC_API_KEY` - Required
- `AGENT_FRAMEWORK_ROOT` - Required, path to agent-framework repo
- `CLAUDE_PROJECT_DIR` - Set automatically by Claude Code
- `WEBHOOK_ID_AGENT_LOGS` - Optional, enables Home Assistant logging

## Code Style

- **Quotes:** Use double quotes (`"`) for all strings and imports
