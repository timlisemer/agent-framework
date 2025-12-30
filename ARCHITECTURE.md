# Architecture

This document explains the architectural decisions in the agent-framework.

## Directory Structure

```
src/
  types.ts                          # Core types and model IDs

  agents/
    mcp/                            # MCP-exposed agents (SDK streaming)
      check.ts                      # Runs linter + make check
      confirm.ts                    # Binary code quality gate
      commit.ts                     # Generates commit message + commits
      push.ts                       # Executes git push
      index.ts                      # Barrel export

    hooks/                          # Hook-triggered agents (direct API)
      tool-approve.ts               # Policy enforcement
      tool-appeal.ts                # Reviews denials with user context
      error-acknowledge.ts          # Ensures AI acknowledges issues
      plan-validate.ts              # Checks plan drift
      intent-validate.ts            # Detects off-topic AI behavior
      index.ts                      # Barrel export

  hooks/                            # Claude Code hook entry points
    pre-tool-use.ts                 # PreToolUse hook (main safety gate)
    stop-off-topic-check.ts         # Stop hook

  mcp/
    server.ts                       # MCP server exposing tools

  utils/
    anthropic-client.ts             # Singleton Anthropic client factory
    response-parser.ts              # Text extraction + decision parsing
    retry.ts                        # Generic format validation retry
    transcript-presets.ts           # Standard transcript configurations
    transcript.ts                   # Transcript reading utilities
    logger.ts                       # Home Assistant logging
    ack-cache.ts                    # Error acknowledgment cache
```

## Execution Pattern: Direct Anthropic API

All agents use direct Anthropic API calls via `getAnthropicClient()` in `utils/anthropic-client.ts`.

### Why Direct API for All Agents?

**Hook Agents** (tool-approve, tool-appeal, error-acknowledge, plan-validate, intent-validate):
- Run inside Claude's tool execution loop
- Must be fast (<100ms) - no noticeable delay
- Simple request/response validation

**MCP Agents** (check, confirm, commit):
- Commands are deterministic (linter, make check, git commands)
- No agent decision-making needed for tool selection
- Single API call is cheaper than multi-turn SDK conversations
- Prevents "overthinking" or unwanted tool calls
- Faster execution without agent loop overhead

### MCP Agent Pattern

MCP agents execute shell commands directly with `execSync`, then use a single API call to analyze results:

```typescript
// Example: check agent
import { execSync } from 'child_process';
import { getAnthropicClient } from '../../utils/anthropic-client.js';

// Step 1: Run commands directly
const lintOutput = execSync('npx eslint . 2>&1', { cwd, encoding: 'utf-8' });
const checkOutput = execSync('make check 2>&1', { cwd, encoding: 'utf-8' });

// Step 2: Single API call to summarize
const client = getAnthropicClient();
const response = await client.messages.create({
  model: getModelId('sonnet'),
  max_tokens: 2000,
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', content: `Summarize:\n${lintOutput}\n${checkOutput}` }]
});
```

### Hook Agent Pattern

Hook agents use a single API call for validation:

```typescript
// Example: tool-approve agent
const client = getAnthropicClient();
const response = await client.messages.create({
  model: getModelId('haiku'),
  max_tokens: 1000,
  messages: [{ role: 'user', content: `Evaluate: ${toolDescription}` }]
});
```

### Historical Note

MCP agents previously used Claude Agent SDK streaming (`@anthropic-ai/claude-agent-sdk`) which provided tool orchestration. This was refactored to direct API because the agents' commands were deterministic and didn't benefit from multi-turn tool selection.

## Model Tiers

Models are centrally configured in `src/types.ts`:

| Tier   | Usage                                                  |
| ------ | ------------------------------------------------------ |
| haiku  | Fast tasks: tool-approve, tool-appeal, error-ack, intent-validate, commit |
| sonnet | Detailed analysis: check, plan-validate                |
| opus   | Complex decisions: confirm (git diff analysis)         |

## Agent Chains

MCP agents chain together for verification:

```
commit → confirm → check
  │         │         │
  │         │         └─ Runs linter + make check (sonnet)
  │         └─ Analyzes git diff (opus)
  └─ Generates commit message + executes commit (haiku)
```

## Hook Flow (PreToolUse)

The PreToolUse hook is the main safety gate (~400 lines):

```
Tool call received
├─> Auto-approve if low-risk (LSP, Grep, Glob, MCP tools)
├─> Error acknowledgment check
│   ├─> Quick pattern check (no LLM)
│   └─> If patterns found: Haiku decides (block or allow)
├─> Path classification (for file tools)
│   ├─> Plan validation (Sonnet) if writing to ~/.claude/plans/
│   └─> Trusted paths (project/~/.claude) + not sensitive → allow
├─> Tool approve (Haiku) → decision
│   └─> If denied:
│       └─> Appeal (Haiku) with transcript
│           ├─> OVERTURN → allow
│           └─> UPHOLD → deny with reason
└─> Workaround detection (escalate after 3 similar denials)
```

## Shared Utilities

### `anthropic-client.ts`
Singleton factory for Anthropic client. Eliminates duplication and ensures consistent configuration.

### `response-parser.ts`
- `extractTextFromResponse()` - finds text block in API response
- `parseDecision()` - parses APPROVE/DENY, OK/BLOCK decisions

### `retry.ts`
- `retryUntilValid()` - retries LLM call until format validation passes
- Standardized to 2 max retries

### `transcript-presets.ts`
Standard configurations for different use cases:
- `ERROR_CHECK_PRESET` - for error acknowledgment
- `APPEAL_PRESET` - for tool appeal decisions
- `OFF_TOPIC_PRESET` - for intent validation
- `PLAN_VALIDATE_PRESET` - for plan drift checks

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic |
| `ANTHROPIC_AUTH_TOKEN` | No | Alternative auth token |
| `ANTHROPIC_BASE_URL` | No | Custom API endpoint |
| `CLAUDE_PROJECT_DIR` | Auto | Set by Claude Code |
| `WEBHOOK_ID_AGENT_LOGS` | No | Home Assistant webhook ID |

## Temporary Files

| File | Purpose | Expiry |
|------|---------|--------|
| `/tmp/claude-hook-denials.json` | Workaround tracking | 1 minute |
| `/tmp/claude-error-acks.json` | Error acknowledgment cache | 5 minutes |
