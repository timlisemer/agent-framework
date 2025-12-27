# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
make build      # Compile TypeScript (tsc)
make run        # Build and run MCP server
make check      # Type-check without emitting
make clean      # Remove dist/
```

## Architecture

This is a TypeScript framework for custom AI agents using the Claude Agent SDK. Agents are exposed via:
1. **MCP Server** (`src/mcp/server.ts`) - Registers `check`, `confirm`, `commit` as MCP tools
2. **PreToolUse Hook** (`src/hooks/pre-tool-use.ts`) - Intercepts bash commands for `tool-approve` agent

### Agents (`src/agents/`)

| Agent | Model | Purpose |
|-------|-------|---------|
| `tool-approve.ts` | Haiku | Approve/deny bash commands based on CLAUDE.md rules |
| `check.ts` | Sonnet | Run linter + `make check`, return structured summary |
| `confirm.ts` | Opus | Binary gate: returns exactly `CONFIRMED` or `DECLINED: <reason>` |
| `commit.ts` | Sonnet | Generate commit message and execute commit, return hash |

All agents use `query()` from `@anthropic-ai/claude-agent-sdk` with strict system prompts. Agents only have access to command output and git diffs, not source files directly.

### Model Configuration (`src/types.ts`)

Centralized model version management. Update `MODEL_IDS` here when switching Claude versions:
```typescript
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-5-20251101"
};
```

### Integration Files (`claude-integration/`)

- `mcp.json` - MCP server configuration for Claude Code
- `settings.json` - PreToolUse hook configuration
