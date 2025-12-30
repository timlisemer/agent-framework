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
    agent-query.ts                  # Claude Agent SDK wrapper
    logger.ts                       # Home Assistant logging
    ack-cache.ts                    # Error acknowledgment cache
```

## Two Execution Patterns

The framework uses two distinct patterns for LLM calls, chosen based on requirements:

### 1. SDK Streaming (MCP Agents)

**Used by:** `check`, `confirm`, `commit`

**Implementation:** `runAgentQuery()` in `utils/agent-query.ts`

**Why SDK streaming?**
- Need shell access via Bash tool
- Multi-turn execution (agent runs multiple commands in sequence)
- Streaming captures incremental output from long-running commands
- Agent SDK provides tool orchestration

```typescript
// Example: check agent
const result = await runAgentQuery(
  'check',
  'Run linter and make check...',
  {
    cwd: workingDir,
    model: getModelId("sonnet"),
    allowedTools: ["Bash"],
    systemPrompt: `...`
  }
);
```

### 2. Direct Anthropic API (Hook Agents)

**Used by:** `tool-approve`, `tool-appeal`, `error-acknowledge`, `plan-validate`, `intent-validate`

**Implementation:** `getAnthropicClient()` in `utils/anthropic-client.ts`

**Why direct API?**
- Run inside Claude's tool execution loop
- Must be fast (<100ms) - no noticeable delay
- No sub-agent spawning or tool orchestration needed
- Simple request/response pattern
- Lower overhead than Agent SDK

```typescript
// Example: tool-approve agent
const client = getAnthropicClient();
const response = await client.messages.create({
  model: getModelId('haiku'),
  max_tokens: 1000,
  messages: [{ role: 'user', content: `...` }]
});
```

## Model Tiers

Models are centrally configured in `src/types.ts`:

| Tier   | Usage                                                  |
| ------ | ------------------------------------------------------ |
| haiku  | Fast validation: tool-approve, tool-appeal, error-ack, intent-validate |
| sonnet | Detailed analysis: check, commit, plan-validate        |
| opus   | Complex decisions: confirm (git diff analysis)         |

## Agent Chains

MCP agents chain together for verification:

```
commit → confirm → check
  │         │         │
  │         │         └─ Runs linter + make check (sonnet)
  │         └─ Analyzes git diff (opus)
  └─ Generates commit message + executes commit (sonnet)
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
