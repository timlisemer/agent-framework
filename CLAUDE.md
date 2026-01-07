# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project Overview

TypeScript framework for custom AI agents using the Anthropic API. Agents are exposed via MCP Server, PreToolUse Hook, and Stop Hook mechanisms.

See [README.md](README.md) for installation and usage.
See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details and design decisions.

## Key Files

| File                             | Purpose                                     |
| -------------------------------- | ------------------------------------------- |
| `src/types.ts`                   | Model IDs (single source of truth)          |
| `src/hooks/pre-tool-use.ts`      | Main safety logic (~400 lines)              |
| `src/agents/mcp/`                | MCP agents (check, confirm, commit, push)   |
| `src/agents/hooks/`              | Hook agents (tool-approve, tool-appeal, etc.) |
| `src/utils/agent-configs.ts`     | Centralized agent configurations            |
| `src/utils/anthropic-client.ts`  | Singleton Anthropic client factory          |
| `claude/settings.json`           | Hook configuration for Claude Code          |

## Testing MCP Server

Only do this when explicitly mentioned by the user:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check","arguments":{"working_dir":"."}}}\n' | node dist/mcp/server.js
```

## Code Style

- **Quotes:** Use double quotes (`"`) for all strings and imports
