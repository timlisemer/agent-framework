# Architecture

This document explains the architectural decisions in the agent-framework.

## Directory Structure

```
claude/                             # Claude Code integration (symlink targets)
  commands/                         # Slash commands (/check, /commit, etc.)
    check.md
    commit.md
    confirm.md
    push.md
  skills/                           # Skills (pure Markdown, auto-applied by Claude)
  settings.json                     # Hook configuration (uses $AGENT_FRAMEWORK_ROOT)

src/                                # TypeScript source
  types.ts                          # Core types and model IDs

  agents/
    mcp/                            # MCP-exposed agents
      check.ts                      # Runs linter + make check
      confirm.ts                    # Code quality gate (SDK mode)
      commit.ts                     # Generates commit message + commits
      push.ts                       # Executes git push
      validate-intent.ts            # Validates AI followed user intent
      index.ts                      # Barrel export

    hooks/                          # Hook-triggered agents
      tool-approve.ts               # Policy enforcement
      tool-appeal.ts                # Reviews denials with user context
      error-acknowledge.ts          # Ensures AI acknowledges issues
      plan-validate.ts              # Checks plan drift
      intent-validate.ts            # Detects off-topic AI behavior
      style-drift.ts                # Detects unrequested style changes
      claude-md-validate.ts         # Validates CLAUDE.md edits
      index.ts                      # Barrel export

  hooks/                            # Claude Code hook entry points
    pre-tool-use.ts                 # PreToolUse hook (main safety gate)
    post-tool-use.ts                # PostToolUse hook
    stop-off-topic-check.ts         # Stop hook

  mcp/
    server.ts                       # MCP server exposing tools

  utils/
    agent-runner.ts                 # Unified agent execution (direct + SDK)
    agent-configs.ts                # Centralized agent configurations
    anthropic-client.ts             # Singleton Anthropic client factory
    response-parser.ts              # Text extraction + decision parsing
    retry.ts                        # Generic format validation retry
    transcript-presets.ts           # Standard transcript configurations
    transcript.ts                   # Transcript reading utilities
    logger.ts                       # Telemetry logging
    ack-cache.ts                    # Error acknowledgment cache
    git-utils.ts                    # Git operations (status, diff)
    command.ts                      # Safe command execution
    command-patterns.ts             # Blacklist pattern detection

dist/                               # Compiled JavaScript (build output)
  hooks/                            # Hook entry points (executed via $AGENT_FRAMEWORK_ROOT)
  mcp/server.js                     # MCP server entry point
  agents/                           # Compiled agents
  utils/                            # Compiled utilities
```

## Unified Agent Execution

All agents use the unified `runAgent()` function from `utils/agent-runner.ts`. This provides a single interface regardless of whether the agent uses direct API calls or the Claude SDK.

### Execution Modes

| Mode   | Description                              | Used By                        |
|--------|------------------------------------------|--------------------------------|
| direct | Single API call, no tools, fast          | All hook agents, check, commit |
| sdk    | Multi-turn with Read/Glob/Grep tools     | confirm                        |

### Why Two Modes?

**Direct Mode** (default):
- Hook agents must be fast (<100ms)
- MCP agents with deterministic commands don't need tool selection
- Single API call is cheaper and more predictable

**SDK Mode** (for confirm agent):
- Code quality decisions benefit from autonomous investigation
- Can read additional files to understand context
- Can search codebase for patterns
- Restricted to read-only tools (Read, Glob, Grep)

### Agent Runner Pattern

```typescript
import { runAgent } from '../utils/agent-runner.js';
import { CHECK_AGENT } from '../utils/agent-configs.js';

// Direct mode - single API call
const result = await runAgent(
  { ...CHECK_AGENT, workingDir: '/path/to/project' },
  { prompt: 'Summarize:', context: lintOutput }
);

// SDK mode - multi-turn with tools (confirm agent)
const result = await runAgent(
  { ...CONFIRM_AGENT, workingDir: '/path/to/project' },
  { prompt: 'Evaluate:', context: gitDiff }
);
```

### Agent Configuration

All agent configs are defined in `utils/agent-configs.ts`:

```typescript
interface AgentConfig {
  name: string;           // For logging
  tier: ModelTier;        // haiku | sonnet | opus
  mode: 'direct' | 'sdk'; // Execution mode
  systemPrompt: string;   // Agent behavior
  maxTokens?: number;     // Response limit
  maxTurns?: number;      // SDK mode only
}
```

## Model Tiers

Models are centrally configured in `src/types.ts`:

| Tier   | Mode   | Usage                                                  |
|--------|--------|--------------------------------------------------------|
| haiku  | direct | Fast tasks: tool-approve, tool-appeal, error-ack, intent-validate, commit |
| sonnet | direct | Detailed analysis: check, plan-validate                |
| opus   | sdk    | Complex decisions: confirm (code quality gate)         |

## Agent Chains

MCP agents chain together for verification:

```
commit → confirm → check
  │         │         │
  │         │         └─ Runs linter + make check (sonnet, direct)
  │         └─ Analyzes git diff + investigates code (opus, SDK)
  └─ Generates commit message + executes commit (haiku, direct)
```

## SDK Agent Restrictions

The confirm agent (only SDK mode user) is restricted to read-only tools:

- **Read**: View file contents
- **Glob**: Find files by pattern
- **Grep**: Search file contents

**NOT available:**
- **Bash**: Git data passed via prompt instead
- **Write/Edit**: No modifications allowed

This ensures the SDK agent can investigate but not modify anything.

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

## Performance Optimization: Lazy Validation

### Problem

The PreToolUse hook was causing ~3 second delays for trusted file operations due to:
- Rewind detection reading entire transcript (~400-1200ms)
- Multiple transcript reads for error-ack, style-drift (~300-600ms each)
- Synchronous LLM validation calls (~500-1000ms each)

### Solution: Hybrid Validation Strategy

The hook uses **two validation modes** based on context:

**Strict Mode** triggers:
1. First tool after user message (intent alignment most critical here)
2. After any denial (one-shot, resets after next tool)
3. After tool errors (one-shot, resets after next tool)
4. Large edits (>20 lines changed)
5. Session start (first 3 tools)
6. Plan mode (unless subagent)
7. Special files (CLAUDE.md, plan files)
8. Untrusted or sensitive paths

All validations run synchronously (~2-4 seconds per tool call).

**Lazy Mode** (when none of the above triggers apply):
- Fast TypeScript checks run first (~10ms)
- If TS says "safe": allow immediately, spawn background validator
- Background validator runs all LLM checks asynchronously
- Failures caught on next tool call
- ~10ms per tool call (instant response)

**Subagent Behavior**: All Task-spawned subagents get lazy validation - they are typically read-only exploration agents that don't need strict validation even when the parent is in plan mode.

### Decision Flow

```
Tool Call
    │
    ├─ Check pending validation cache (catch previous failures)
    │
    ├─ LOW_RISK_TOOLS (Grep, Glob, etc.)
    │       └─> Instant allow (~1ms)
    │
    ├─ FILE_TOOLS (Read, Write, Edit)
    │       │
    │       ├─ Fast TS Checks (~10ms)
    │       │   ├─ isTrustedPath()
    │       │   ├─ isSensitivePath()
    │       │   └─ isPlanModeActive()
    │       │
    │       ├─ TS "SAFE" + Regular Mode
    │       │       └─> Allow + Async Validator (~10ms)
    │       │
    │       ├─ TS "SAFE" + Plan Mode
    │       │       └─> Strict validation (~2-4s)
    │       │
    │       └─ Special files (plan/CLAUDE.md) or untrusted
    │               └─> Strict validation (~2-4s)
    │
    └─ HIGH_RISK_TOOLS (Bash, Agent, etc.)
            └─> Strict validation (~1-2s)
```

### Lazy Validation Flow

```
Tool N (trusted, regular mode)
    │
    ├─ Check pending validation cache → no failures
    ├─ Fast TS checks → "SAFE"
    ├─ Allow immediately (tool executes)
    └─ Spawn async-validator.ts (background process)
            │
            └─ Runs: intent, error-ack, style-drift
            └─ Writes result to pending validation cache

Tool N+1 (any)
    │
    ├─ Check pending validation cache
    │       └─ If FAILED: deny with reason
    │       └─ If PASSED: continue normally
    └─ ...
```

### Key Files

| File | Purpose |
|------|---------|
| `src/utils/pending-validation-cache.ts` | Stores async validation results between tool calls |
| `src/utils/async-validator.ts` | Background process for async LLM validation |
| `src/utils/plan-mode-detector.ts` | Detects if plan mode is active |

### Temporary Files

| File | Purpose | Expiry |
|------|---------|--------|
| `/tmp/claude-pending-validation.json` | Async validation results | 5 minutes |
| `/tmp/claude-strict-mode.json` | Strict mode state (tool count, denial/error flags) | Session-scoped |

## Shared Utilities

### `agent-runner.ts`
Unified agent execution for both direct API and SDK modes.
- `runAgent()` - main entry point, dispatches to appropriate mode
- `runDirectAgent()` - single API call execution
- `runSdkAgent()` - multi-turn SDK execution with tools

### `agent-configs.ts`
Centralized agent configurations with documentation:
- `CHECK_AGENT` - sonnet, direct
- `CONFIRM_AGENT` - opus, SDK
- `COMMIT_AGENT` - haiku, direct
- `TOOL_APPROVE_AGENT` - haiku, direct
- `TOOL_APPEAL_AGENT` - haiku, direct
- `ERROR_ACK_AGENT` - haiku, direct
- `PLAN_VALIDATE_AGENT` - sonnet, direct
- `CLAUDE_MD_VALIDATE_AGENT` - sonnet, direct
- `INTENT_VALIDATE_AGENT` - haiku, direct
- `STYLE_DRIFT_AGENT` - haiku, direct
- `VALIDATE_INTENT_AGENT` - haiku, direct (MCP tool)

### `anthropic-client.ts`
Singleton factory for Anthropic client. Used by direct mode agents.

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

### `git-utils.ts`
- `getUncommittedChanges()` - returns status, diff, and diffStat

### `command.ts`
- `runCommand()` - safe command execution with output capture

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic |
| `ANTHROPIC_AUTH_TOKEN` | No | Alternative auth token |
| `ANTHROPIC_BASE_URL` | No | Custom API endpoint |
| `CLAUDE_PROJECT_DIR` | Auto | Set by Claude Code |
| `AGENT_FRAMEWORK_ROOT` | Yes (hooks) | Path to agent-framework directory |
| `TELEMETRY_HOST_ID` | No | Telemetry host identifier |
| `TELEMETRY_ENDPOINT` | No | Telemetry service URL |
| `AGENT_FRAMEWORK_API_KEY` | No | Telemetry API key |

## Temporary Files

| File | Purpose | Expiry |
|------|---------|--------|
| `/tmp/claude-hook-denials.json` | Workaround tracking | 1 minute |
| `/tmp/claude-error-acks.json` | Error acknowledgment cache | 5 minutes |

## Telemetry

Telemetry is sent to a remote endpoint for monitoring agent decisions.

### Kill Switch
Set `TELEMETRY_ENABLED = false` in `src/telemetry/client.ts` to disable all telemetry.

### Telemetry API

**Decision** (required) - one of:
| Decision | Category | When to Use |
|----------|----------|-------------|
| `APPROVE` | Authorization | Agent approved tool execution |
| `DENY` | Authorization | Agent blocked tool execution |
| `CONFIRM` | Quality | Check/confirm agent validated code |
| `SUCCESS` | Outcome | Operation completed without errors |
| `ERROR` | Outcome | Provider error occurred (API failures, etc.) |

**Mode** (required) - execution mode:
| Mode | Description |
|------|-------------|
| `direct` | Direct execution mode |
| `lazy` | Lazy evaluation mode |

### Agent Telemetry Coverage

| File | Calls | Decision Values | Mode |
|------|-------|-----------------|------|
| `check.ts` | 1 | `CONFIRM` | `direct` |
| `confirm.ts` | 1 | `CONFIRM` | `direct` |
| `commit.ts` | 3 | `CONFIRM`, `ERROR` | `direct` |
| `error-acknowledge.ts` | 3 | `APPROVE`, `DENY` | `direct` |
| `tool-approve.ts` | 3 | `APPROVE`, `DENY` | `direct` or `lazy` |
| `tool-appeal.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `response-align.ts` | 5 | `APPROVE`, `DENY` | `direct` |
| `intent-validate.ts` | 2 | `APPROVE`, `DENY` | `direct` |
| `plan-validate.ts` | 2 | `APPROVE`, `DENY` | `direct` |
| `claude-md-validate.ts` | 2 | `APPROVE`, `DENY` | `direct` |
| `style-drift.ts` | 2 | `APPROVE`, `DENY` | `direct` |
| `push.ts` | 0 | — | — |
