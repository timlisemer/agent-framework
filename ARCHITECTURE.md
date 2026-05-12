# Architecture

This document explains the architectural decisions in the agent-framework.

## Directory Structure

```
adapters/                           # Adapter layer (per-tool stdout/exit-code translation)
  claude/                           # Claude Code adapter
    dotclaude/                      # Files symlinked into ~/.claude/ (NixOS-managed)
      commands/                     # Slash commands (/check, /commit, etc.)
      settings.json                 # Hook configuration (uses $AGENT_FRAMEWORK_ROOT)
    hooks/                          # Adapter-specific hook entry points (dist/ targets)
  README.md                         # Adapter contract + how to add a new adapter

src/                                # TypeScript source
  types.ts                          # Core types and model IDs

  agents/
    mcp/                            # MCP-exposed agents
      check.ts                      # Runs linter + make/just check
      confirm.ts                    # Code quality gate (SDK mode)
      commit.ts                     # Generates commit message + commits
      push.ts                       # Executes git push
      index.ts                      # Barrel export

    hooks/                          # Hook-triggered agents
      tool-appeal.ts                # Reviews denials with user context
      plan-validate.ts              # Checks plan drift
      claude-md-validate.ts         # Validates CLAUDE.md edits
      index.ts                      # Barrel export

  rules/                            # Rule-based pre-tool-use pipeline
    types.ts                        # PreToolRule interface and RuleContext
    evaluator.ts                    # Rule evaluation engine (sequential + combined LLM)
    utils.ts                        # Shared constants (FILE_TOOLS, LOW_RISK_TOOLS, etc.)
    index.ts                        # ALL_RULES barrel export
    respond-first.ts                # Priority 5:   AI must respond before tools (deterministic)
    plan-mode-block.ts              # Priority 15:  Block writes in plan mode; fast-allow plan files
    subagent.ts                     # Priority 20:  Subagent tool approval
    background-agent-block.ts       # Priority 25:  Deny Agent(run_in_background=true) from main session
    prediction-question-judge.ts    # Priority 28:  Block stalling AskUserQuestion under frustration
    question-validate.ts            # Priority 30:  Validate AskUserQuestion
    force-check-required.ts         # Priority 32:  Lock to mcp__check after workaround denial
    prediction-block.ts             # Priority 35:  Block predicted-bad tools (appealable)
    low-risk.ts                     # Priority 38:  Auto-approve read-only tools
    drift-detect.ts                 # Priority 40:  Detect drift from intent
    error-acknowledge.ts            # Priority 50:  Require error acknowledgment
    trusted-path.ts                 # Priority 58:  Deny sensitive-path writes
    edit-intent.ts                  # Priority 60:  Block edits without intent
    style-drift.ts                  # Priority 65:  Detect style changes
    prediction-context.ts           # Priority 68:  Prediction context for rule-gate LLM
    recent-messages.ts              # Priority 70:  Recent user messages context
    reasoning-history.ts            # Priority 72:  Gate reasoning history context
    edit-intent-context.ts          # Priority 74:  Edit intent context signal
    plan-mode-context.ts            # Priority 76:  Plan mode context signal
    tool-approve.ts                 # Priority 100: Final tool approval (deterministic + llmContext)
    sentiment.ts                    # Priority 10:  Classify user mood/intent (UserPromptSubmit)
    validate-intent.ts              # Priority 50:  Check if AI followed user intentions (PreToolUse)
    response-align-stop.ts          # Priority 50:  Validate stop responses (Stop)

  hooks/                            # Canonical hook handlers (adapter-agnostic)
    pre-tool-use.ts                 # PreToolUse hook (orchestrator for rule pipeline)
    post-tool-use.ts                # PostToolUse hook
    stop-response-check.ts          # Stop hook
    session-start.ts                # SessionStart hook (lifecycle)
    user-prompt-submit.ts           # UserPromptSubmit hook
    post-tool-use-failure.ts        # PostToolUseFailure hook
    subagent-start.ts               # SubagentStart hook
    subagent-stop.ts                # SubagentStop hook

  scenario/                         # Scenario testing + capture pipeline
    types.ts                        # Scenario schema + validateScenario
    runner.ts                       # Scenario execution (single-hook + fan-out)
    replay.ts                       # Full-session transcript replay
    capture.ts                      # Append-only capture JSONL
    snapshot.ts                     # State snapshot JSONL
    epoch.ts                        # Epoch detection + rotation
    lifecycle.ts                    # Epoch-rotation side-effects
    materialize.ts                  # Reconstruct Scenario from capture pointer
    lib/                            # Shared harness, classifier, hook-runner

  adapter/
    types.ts                        # AdapterEncoder interface (single source of truth)
    runtime.ts                      # Adapter resolution helpers

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
    session-store.ts                # SessionState cache + JSONL tool log
    prediction-types.ts             # Sentiment-prediction shape + policy table
    prediction-parser.ts            # Marker-section parser for SENTIMENT_AGENT
    drift-detector.ts               # Pure TypeScript drift/anomaly heuristics
    gate-reasoning-cache.ts         # Gate reasoning persistent memory
    hook-bootstrap.ts               # Shared hook stdin/exit infrastructure
    git-utils.ts                    # Git operations (status, diff)
    command.ts                      # Safe command execution
    command-patterns.ts             # Blacklist pattern detection

dist/                               # Compiled JavaScript (build output)
  hooks/                            # Hook entry points (executed via $AGENT_FRAMEWORK_ROOT)
  mcp/server.js                     # MCP server entry point
  agents/                           # Compiled agents
  utils/                            # Compiled utilities
```

## Adapters

The adapter layer translates between canonical hook handler outputs and the
stdout/exit-code conventions of a specific AI coding tool. Each adapter
implements `AdapterEncoder` from `src/adapter/types.ts`.

Today the Claude Code (`adapters/claude/`) and Codex CLI
(`adapters/codex/`) adapters exist. Adding support for another tool requires
only a new adapter directory — the rule logic in `src/hooks/` is unchanged.

See [`adapters/README.md`](adapters/README.md) for the adapter contract and
how to add a new adapter.

## Unified Agent Execution

All agents use the unified `runAgent()` function from `utils/agent-runner.ts`. This provides a single interface regardless of whether the agent uses direct API calls or the host agent's SDK.

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

**SDK mode with OpenRouter is not supported.** The SDK spawns a host-agent subprocess that cannot use custom base URLs. SDK mode automatically uses `claude-subscription` (or throws an error if explicitly configured for openrouter).

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
| haiku  | direct | rule-gate, tool-appeal, commit, style-drift, question-validate, sentiment, validate-intent, response-align-stop |
| sonnet | direct | check, plan-validate, claude-md-validate |
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

The `commit`, `confirm`, and `push` tools use MCP elicitation (`server.elicitInput()`) to ask users structured questions mid-tool-execution, replacing the previous pattern where slash commands instructed the agent to call `AskUserQuestion`.

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

The PreToolUse hook uses a rule-based pipeline. Each check is a `PreToolRule` object
evaluated sequentially by priority. Rules return `fastDeny`, `fastAllow`, `llmContext`,
or `null` (skip). Triggered `llmContext` rules are combined into one haiku LLM call.

```
Tool call received
├─> Rule pipeline (evaluateRules):
│   ├─> respond-first (5)     Fast deny if no text before tools (deterministic)
│   ├─> plan-mode-block (15)  Fast deny writes in plan mode; fast-allow plan files
│   ├─> subagent (20)         Subagent tool approval
│   ├─> background-agent-block (25) Fast deny Agent(run_in_background=true) from main session
│   ├─> prediction-question-judge (28) Block stalling AskUserQuestion under frustration
│   ├─> question-validate (30) Validate AskUserQuestion
│   ├─> force-check-required (32) Lock to mcp__check after workaround denial
│   ├─> prediction-block (35)  Block predicted-bad tools (appealable)
│   ├─> low-risk (38)          Fast allow read-only tools (sentiment-aware via prediction-block running first)
│   ├─> drift-detect (40)      Detect drift from user intent (appealable)
│   ├─> error-acknowledge (50) Require error acknowledgment (appealable, LLM)
│   ├─> trusted-path (58)      Fast deny sensitive paths
│   ├─> edit-intent (60)       Block edits without intent (appealable)
│   ├─> style-drift (65)       Detect style changes (appealable, LLM)
│   ├─> prediction-context (68) Prediction context for rule-gate LLM
│   ├─> recent-messages (70)   Recent user messages context
│   ├─> reasoning-history (72) Gate reasoning history context
│   ├─> edit-intent-context (74) Edit intent context signal
│   ├─> plan-mode-context (76) Plan mode context signal
│   └─> tool-approve (100)     Final tool approval (deterministic + llmContext, appealable)
│
│   Symmetric short-circuit guards (`evaluator.ts`): a later fastAllow OR
│   fastDeny is deferred whenever a higher-priority rule has emitted
│   llmContext. Deferred denies fire after the rule-gate LLM aggregator only
│   if the LLM approves; deferred allows are dropped if any deny is pending.
│   Without this symmetry, a low-priority deterministic deny (e.g.
│   prediction-block) could silently discard a high-priority rule's pending
│   LLM judgment.
│
├─> Rewind detection (after rules, before validators)
│
├─> plan-validate (Sonnet) if writing to the active adapter's plans root
├─> claude-md-validate (Sonnet) for CLAUDE.md edits
│
└─> Post-allow bookkeeping (tool count, ExitPlanMode cleanup)
```

Adding a new check: create `src/rules/my-rule.ts` implementing `PreToolRule`,
add to `ALL_RULES` in `src/rules/index.ts`, add display name to statusline.

### Pipeline: one evaluator, one LLM call

Every tool call runs every rule in `src/rules/index.ts`'s `ALL_RULES`. Rules either short-circuit with `fastAllow`/`fastDeny` (pure TypeScript, <10ms) or return `llmContext`. The evaluator aggregates every triggered rule's `llmContext` into a SINGLE rule-gate haiku call (`rules/evaluator.ts:99–135`). There is no sync-vs-lazy bifurcation — every rule participates on every call (except subagents, which use a dedicated lightweight path via `subagentRule` at priority 20 with `skipLlmOnClean: true`).

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

When the underlying call returns an `[SDK ERROR]` / `[DIRECT ERROR]` sentinel, the retry-tier loop is skipped and the agent's `fallbackOutput` is applied directly so callers receive a structured verdict (e.g. `DECLINED`) instead of the raw sentinel.

Validation rules are defined alongside system prompts in `agent-configs.ts`.

### `agent-configs.ts`
Centralized agent configurations with documentation:
- `CHECK_AGENT` - sonnet, direct
- `CONFIRM_AGENT` - opus, SDK
- `COMMIT_AGENT` - haiku, direct
- `VALIDATE_INTENT_AGENT` - haiku, direct (inlined into validateIntentRule side-effect pattern)
- `TOOL_APPROVE_PROMPT_SECTION` - prompt body for tool-approve rule
- `STYLE_DRIFT_PROMPT_SECTION` - prompt body for style-drift aggregator rule
- `RULE_GATE_AGENT` - haiku, direct (aggregated rule evaluation)
- `TOOL_APPEAL_AGENT` - haiku, direct
- `PLAN_VALIDATE_AGENT` - sonnet, direct
- `CLAUDE_MD_VALIDATE_AGENT` - sonnet, direct
- `QUESTION_VALIDATE_AGENT` - haiku, direct (inlined into questionValidateRule side-effect pattern)
- `SENTIMENT_AGENT` - haiku, direct (used by sentimentRule and predictionQuestionJudgeRule)

### `anthropic-client.ts`
Singleton factory for Anthropic client. Used by direct mode agents.

### `response-parser.ts`
- `extractTextFromResponse()` - finds text block in API response

### `retry.ts`
- `retryUntilValid()` - retries LLM call until format validation passes
- Standardized to 2 max retries

### `transcript-presets.ts`
Standard configurations for different use cases:
- `APPEAL_PRESET` - for tool appeal decisions
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
| `CLAUDE_PROJECT_DIR` | Auto | Set by the host agent |
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
| `src/rules/validate-intent.ts` | 1 | via `runAgent` in rule check | `direct` |
| `evaluator.ts` (rule-gate) | 1 | `APPROVE`, `DENY` | `direct` |
| `tool-appeal.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `src/rules/response-align-stop.ts` | 2 | via `runAgent` in rule check | `direct` |
| `plan-validate.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `claude-md-validate.ts` | 1 | `APPROVE`, `DENY` | `direct` |
| `src/rules/style-drift.ts` | 0 (aggregator, no own call) | - | - |
| `src/rules/question-validate.ts` | 1 | via `runAgent` in rule check | `direct` |
| `push.ts` | 0 | - | - |

## Session State Persistence

Each session persists three files under `~/.agent-framework/sessions/{project}/{hash}/`:

1. **`state.json`** — SessionState (prediction, edit-intent, force-check lockout, frustration streak, window size, tool count).
2. **`gate-reasoning.json`** — priority-evicted denial memory with NOTE/WARNING/appeal outcomes.
3. **`tool-log.jsonl`** — append-only audit trail consumed by drift-detect, error-acknowledge, pre-tool-use, gate-reasoning, and the test-harness.

Compaction recovery relies on the host agent's native transcript compaction — no app-layer summary re-inject.

### Hook Lifecycle

Hooks execute in this order during a session:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `SessionStart` | Session begins or resumes | Initialize session state |
| `UserPromptSubmit` | User sends a message | Refresh SENTIMENT_AGENT prediction, derive edit-intent |
| `PreToolUse` | Before each tool call | Safety gate, policy enforcement |
| `PostToolUse` | After each tool call | Log tool result |
| `PostToolUseFailure` | After a tool call fails | Log failure, track error patterns |
| `Stop` | AI attempts to stop responding | Validate response completeness |

### Subagent Isolation

Task-spawned subagents (detected via transcript path patterns) use a dedicated lightweight path through `subagentRule` at priority 20 with `skipLlmOnClean: true`.

### Removed Components

The following components were removed:
- `async-validator.ts` — never existed as a source file; the concept was replaced by prediction-driven synchronous rules.
- `async-gate-validator.ts` — Replaced by the single rule-gate aggregator LLM call.
- `pending-validation-cache.ts` — Replaced by synchronous rule pipeline.
- `intent-validate.ts` — Dead code, removed (gate agent covers per-tool intent validation).
- `ack-cache.ts` — Replaced by `gate-reasoning.json` priority-evicted denial memory.
- `strict-mode-tracker.ts` — Replaced by `tool-log.jsonl` and SessionState.
- `summary-updater.ts` / `summary-cache.ts` summary document surface — Replaced by prediction-driven checks and `gate-reasoning.json`.
- `spawn-background.ts` — No background forks remain; SENTIMENT_AGENT runs synchronously with a hard timeout.
- `pre-compact.ts` — No app-layer compaction recovery; the host agent's native compaction handles it.
- `correction-cache.ts` — Dead after summary-updater removal.
- `checkGate` dead export from `src/agents/hooks/gate.ts` — evaluator's rule-gate path replaces it.
- `useSyncPipeline` / `coldStart` fields — sync/lazy pipeline bifurcation deleted; every rule runs on every call.
- `trusted-path` rule — trimmed to `sensitive-path-block` fastDeny only.
