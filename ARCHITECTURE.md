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
      check.ts                      # Runs linter + make/just check
      confirm.ts                    # Code quality gate (SDK mode)
      commit.ts                     # Generates commit message + commits
      push.ts                       # Executes git push
      validate-intent.ts            # Validates AI followed user intent
      index.ts                      # Barrel export

    hooks/                          # Hook-triggered agents
      tool-approve.ts               # Policy enforcement
      tool-appeal.ts                # Reviews denials with user context
      gate.ts                       # Gate agent (error + intent check)
      plan-validate.ts              # Checks plan drift
      intent-validate.ts            # Detects off-topic AI behavior
      style-drift.ts                # Detects unrequested style changes
      claude-md-validate.ts         # Validates CLAUDE.md edits
      response-align.ts             # Validates response aligns with request
      question-validate.ts          # Validates AskUserQuestion calls
      index.ts                      # Barrel export

  hooks/                            # Claude Code hook entry points
    pre-tool-use.ts                 # PreToolUse hook (main safety gate)
    post-tool-use.ts                # PostToolUse hook
    stop-response-check.ts          # Stop hook
    session-start.ts                # SessionStart hook (lifecycle)
    user-prompt-submit.ts           # UserPromptSubmit hook
    pre-compact.ts                  # PreCompact hook (snapshot before compaction)
    post-tool-use-failure.ts        # PostToolUseFailure hook

  mcp/
    server.ts                       # MCP server exposing tools

  utils/
    agent-runner.ts                 # Unified agent execution (direct + SDK)
    agent-configs.ts                # Centralized agent configurations
    anthropic-client.ts             # Singleton Anthropic client factory
    provider-config.ts              # Provider configuration (openrouter/subscription)
    response-parser.ts              # Text extraction + decision parsing
    retry.ts                        # Generic format validation retry
    transcript-presets.ts           # Standard transcript configurations
    transcript.ts                   # Transcript reading utilities
    logger.ts                       # Telemetry logging
    summary-cache.ts                # Summary document, JSONL tool log, session state
    summary-updater.ts              # Background LLM for summary updates
    correction-cache.ts             # Post-tool correction cache
    micro-prediction.ts             # Sync regex predictions from user messages
    drift-detector.ts               # Pure TypeScript drift/anomaly heuristics
    gate-reasoning-cache.ts         # Gate reasoning persistent memory
    hook-bootstrap.ts               # Shared hook stdin/exit infrastructure
    spawn-background.ts             # Background process spawner
    markdown-parser.ts              # Markdown section extraction
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

## Provider Configuration

The framework supports two LLM providers with different cost tracking behavior:

| Provider | Description | Cost Tracking |
|----------|-------------|---------------|
| `openrouter` | OpenRouter API | Via generation IDs, shown on LLM cost dashboard |
| `claude-subscription` | Claude Pro/Max subscription | Events tracked (tokens, latency) but excluded from LLM cost dashboard |

### Configuration Hierarchy

Provider resolution follows this priority order:

1. **Mode-specific env var**: `AGENT_FRAMEWORK_DIRECT_PROVIDER`, `AGENT_FRAMEWORK_SDK_PROVIDER`
2. **Config file mode override**: `.agent-framework.json` → `modes.direct`, `modes.sdk`
3. **Global env var**: `AGENT_FRAMEWORK_PROVIDER`
4. **Config file default**: `.agent-framework.json` → `default`
5. **Hardcoded default**: `openrouter`

### Config File Locations

- Project root: `.agent-framework.json`
- Global: `~/.config/agent-framework/config.json`

```json
{
  "default": "openrouter",
  "modes": {
    "sdk": "claude-subscription"
  }
}
```

### SDK Mode Constraint

**SDK mode with OpenRouter is not supported.** The Claude Agent SDK spawns a Claude Code subprocess that cannot use custom base URLs. SDK mode automatically uses `claude-subscription` (or throws an error if explicitly configured for openrouter).

### Provider Model IDs

Each provider uses different model identifiers:

| Tier | OpenRouter ID | Subscription ID |
|------|---------------|-----------------|
| haiku | `x-ai/grok-4.1-fast` | `claude-haiku-4-5` |
| sonnet | `google/gemini-3-flash-preview` | `claude-sonnet-4-5` |
| opus | `anthropic/claude-opus-4.5` | `claude-opus-4-5` |

### Telemetry Behavior

The `provider` field in telemetry events tells the telemetry server how to handle costs:

- **openrouter**: Fetch cost from OpenRouter API using `generationId`, include in LLM cost dashboard
- **claude-subscription**: Skip OpenRouter API call, exclude from LLM cost dashboard (event still fully tracked)

### Token Extraction by Mode

| Token Field | Direct Mode | SDK Mode |
|-------------|-------------|----------|
| `promptTokens` | From API response | From `SDKResultMessage.usage` |
| `completionTokens` | From API response | From `SDKResultMessage.usage` |
| `cachedTokens` | From `usage.cache_read_input_tokens` | From `modelUsage[model].cacheReadInputTokens` |
| `reasoningTokens` | From OpenRouter response | Not available (OpenRouter-specific) |

## Model Tiers

Models are centrally configured in `src/types.ts`:

| Tier   | Mode   | Agents                                                                       |
|--------|--------|------------------------------------------------------------------------------|
| haiku  | direct | tool-approve, tool-appeal, error-ack, intent-validate, commit, style-drift, question-validate |
| sonnet | direct | check, plan-validate, claude-md-validate, response-align, validate-intent    |
| opus   | sdk    | confirm (code quality gate with investigation)                               |

## Agent Chains

MCP agents chain together for verification:

```
commit → confirm → check
  │         │         │
  │         │         └─ Runs linter + make/just check (sonnet, direct)
  │         └─ Analyzes git diff + investigates code (opus, SDK)
  └─ Generates commit message + executes commit (haiku, direct)
```

## MCP Elicitation

The `commit`, `confirm`, and `push` tools use MCP elicitation (`server.elicitInput()`) to ask users structured questions mid-tool-execution, replacing the previous pattern where slash commands instructed Claude Code to call `AskUserQuestion`.

### Flow (commit/confirm)

```
Tool called → getRepoInfo()
  → Multiple repos? → elicitInput: repo selection form
  → For each repo → elicitInput: tier + focus preferences form
  → Run agent chain per repo
  → Return combined results
```

### Confirm Uncertainty Elicitation (last resort)

When the confirm agent DECLINEs with `UNCERTAIN:` markers, the tool callback elicits user clarification and re-runs:

```
confirm returns DECLINED + UNCERTAIN markers
  → Parse markers → elicitInput: clarification form
  → User provides input → re-run confirm with extra_context
  → Return new result (or original DECLINED if user cancels)
```

### Skip Elicitation

All three tools accept `skip_elicitation: true` to bypass interactive questions and use defaults. Used by `/quickpush` for zero-interaction commits.

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
├─> Error acknowledgment check (Haiku)
│   ├─> Quick pattern check (no LLM)
│   └─> If patterns found: Haiku decides (block or allow)
├─> Response alignment check (Sonnet)
│   └─> Validates first response aligns with user request
├─> Path classification (for file tools)
│   ├─> Plan validation (Sonnet) if writing to ~/.claude/plans/
│   ├─> CLAUDE.md validation (Sonnet) for CLAUDE.md edits
│   └─> Trusted paths (project/~/.claude) + not sensitive → allow
├─> Question validation (Haiku) for AskUserQuestion
│   └─> Blocks questions about unseen content or redundant questions
├─> Style drift check (Haiku) for Edit tool
│   └─> Blocks unrequested style-only changes
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
| `src/utils/correction-cache.ts` | Stores post-tool corrections for prediction violations |
| `src/utils/micro-prediction.ts` | Sync regex predictions from user messages |
| `src/utils/drift-detector.ts` | Pure TypeScript drift/anomaly detection heuristics |
| `src/utils/plan-mode-detector.ts` | Detects if plan mode is active |

### Temporary Files

| File | Purpose | Expiry |
|------|---------|--------|
| `correction-cache.json` | Post-tool correction entries | 5 minutes |
| `/tmp/claude-strict-mode.json` | Strict mode state (tool count, denial/error flags) | Session-scoped |

## Shared Utilities

### `agent-runner.ts`
Unified agent execution for both direct API and SDK modes.
- `runAgent()` - main entry point, dispatches to appropriate mode
- `runDirectAgent()` - single API call execution
- `runSdkAgent()` - multi-turn SDK execution with tools
- Format validation via `formatValidation` config field

#### Format Validation

Agents can define `formatValidation` in their config to ensure LLM output matches expected format:
- **Direct mode**: Retries with format reminder, falls back if still invalid
- **SDK mode**: Returns fallback immediately (cannot retry multi-turn)

Validation rules are defined alongside system prompts in `agent-configs.ts`.

### `agent-configs.ts`
Centralized agent configurations with documentation:
- `CHECK_AGENT` - sonnet, direct
- `CONFIRM_AGENT` - opus, SDK
- `COMMIT_AGENT` - haiku, direct
- `VALIDATE_INTENT_AGENT` - sonnet, direct (MCP tool)
- `TOOL_APPROVE_AGENT` - haiku, direct
- `TOOL_APPEAL_AGENT` - haiku, direct
- `ERROR_ACK_AGENT` - haiku, direct
- `PLAN_VALIDATE_AGENT` - sonnet, direct
- `CLAUDE_MD_VALIDATE_AGENT` - sonnet, direct
- `INTENT_VALIDATE_AGENT` - haiku, direct
- `STYLE_DRIFT_AGENT` - haiku, direct
- `RESPONSE_ALIGN_AGENT` - sonnet, direct
- `QUESTION_VALIDATE_AGENT` - haiku, direct

### `anthropic-client.ts`
Singleton factory for Anthropic client. Used by direct mode agents.

### `response-parser.ts`
- `extractTextFromResponse()` - finds text block in API response

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
- `getRepoInfo()` - detects main repo + submodules with change status

### `elicitation.ts`
- `elicitRepoSelection()` - multi-repo selection form via MCP elicitation
- `elicitPreferences()` - tier + focus preferences form
- `sortReposSubmodulesFirst()` - enforce submodule-first processing order
- `parseUncertainties()` - extract UNCERTAIN markers from DECLINED confirm output
- `elicitUncertaintyClarification()` - ask user to clarify uncertainties

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
| `AGENT_FRAMEWORK_PROVIDER` | No | Global provider (openrouter/claude-subscription) |
| `AGENT_FRAMEWORK_DIRECT_PROVIDER` | No | Provider for direct mode agents |
| `AGENT_FRAMEWORK_SDK_PROVIDER` | No | Provider for SDK mode agents |
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
| `async-gate` | Async gate validator background mode |

### Agent Telemetry Coverage

| File | Calls | Decision Values | Mode |
|------|-------|-----------------|------|
| `check.ts` | 1 | `CONFIRM` | `direct` |
| `confirm.ts` | 1 | `CONFIRM` | `direct` |
| `commit.ts` | 3 | `CONFIRM`, `ERROR` | `direct` |
| `validate-intent.ts` | 1 | `CONFIRM` | `direct` |
| `gate.ts` | 1 | `APPROVE`, `DENY` | `direct` or `async-gate` |
| `tool-approve.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `tool-appeal.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `response-align.ts` | 5 | `APPROVE`, `DENY` | `direct` |
| `intent-validate.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `plan-validate.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `claude-md-validate.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `style-drift.ts` | 2 | `APPROVE`, `DENY` | `direct` |
| `question-validate.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `push.ts` | 0 | - | - |

## Session Summary System

### Execution Modes

The framework operates in two modes:
- **Plan mode**: Active when a plan file exists in `~/.claude/plans/`. Stricter validation, all checks run synchronously.
- **Non-plan mode**: Normal operation. Trusted file operations use fast-path validation.

### Summary Document Structure

Each session maintains a summary document (JSONL-backed) with 5 sections:

1. **Active Plan** - Current plan context and step tracking
2. **Flagged Misalignments** - Issues detected by gate/response-align agents (replaces ack-cache)
3. **Tool Log** - JSONL append-only log of tool calls and results (replaces strict-mode-tracker)
4. **Session State** - Key-value state surviving compaction (denial counts, mode flags)
5. **Conversation Digest** - Compressed conversation context for post-compaction recovery

### Hook Lifecycle

Hooks execute in this order during a session:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `SessionStart` | Session begins or resumes post-compaction | Initialize summary, recover state |
| `UserPromptSubmit` | User sends a message | Record user message, update digest |
| `PreToolUse` | Before each tool call | Safety gate, policy enforcement |
| `PostToolUse` | After each tool call | Log tool result, update summary |
| `PostToolUseFailure` | After a tool call fails | Log failure, track error patterns |
| `PreCompact` | Before context compaction | Persist summary to survive compaction |
| `Stop` | AI attempts to stop responding | Validate response completeness |

### Compaction Survival

When Claude Code compacts context, the summary document persists on disk. The `SessionStart` hook detects post-compaction resumption and injects the summary back into context, preserving:
- Active plan state and progress
- Flagged misalignment history
- Session state (denial counts, flags)
- Conversation digest for continuity

### Subagent Isolation

Task-spawned subagents (detected via transcript path patterns) receive lazy validation. They operate in isolated contexts and do not share the parent session's summary document.

### Removed Components

The following components were removed in favor of the summary system:
- `async-validator.ts` - Replaced by prediction-driven checks + correction-cache
- `async-gate-validator.ts` - Replaced by micro-prediction + drift-detector + correction-cache
- `pending-validation-cache.ts` - Replaced by correction-cache
- `error-acknowledge.ts` - Absorbed into the gate agent
- `ack-cache.ts` - Replaced by Flagged Misalignments in summary
- `strict-mode-tracker.ts` - Replaced by tool log + session state in summary
