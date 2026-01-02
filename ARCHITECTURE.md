# Architecture

This document explains the architectural decisions in the agent-framework.

## Directory Structure

```
claude/                             # Claude Code integration (symlink targets)
  commands/                         # Skill documentation
    check.md
    commit.md
    confirm.md
    push.md
  skills/                           # Future skill definitions
  mcp.json                          # MCP server registration config
  settings.json                     # Hook configuration

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
    logger.ts                       # Home Assistant logging
    ack-cache.ts                    # Error acknowledgment cache
    git-utils.ts                    # Git operations (status, diff)
    command.ts                      # Safe command execution
    command-patterns.ts             # Blacklist pattern detection

dist/                               # Compiled JavaScript (build output)
  hooks/                            # Hook entry points (symlink ~/.claude/hooks here)
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
| `WEBHOOK_ID_AGENT_LOGS` | No | Home Assistant webhook ID |

## Temporary Files

| File | Purpose | Expiry |
|------|---------|--------|
| `/tmp/claude-hook-denials.json` | Workaround tracking | 1 minute |
| `/tmp/claude-error-acks.json` | Error acknowledgment cache | 5 minutes |
