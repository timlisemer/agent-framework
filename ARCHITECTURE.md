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
  types.ts                          # Core branded types and provider exports

  agents/
    mcp/                            # MCP-exposed agents
      check.ts                      # Runs linter + make/just check + deterministic filename-reference diagnostics and supplemental editor diagnostics
      create-planfile.ts            # Writes named planfiles and runs validation
      confirm.ts                    # Code quality gate (SDK mode)
      commit.ts                     # Generates commit message + commits
      locate-scenario.ts            # Locates captured scenarios from quotes
      push.ts                       # Executes git push
      index.ts                      # Barrel export

    hooks/                          # Hook-triggered agents
      tool-appeal.ts                # Reviews denials with user context
      plan-validate.ts              # Shared plan contract / intent checks
      claude-md-validate.ts         # Validates CLAUDE.md edits
      index.ts                      # Barrel export

  rules/                            # Rule-based pre-tool-use pipeline
    types.ts                        # PreToolRule interface and RuleContext
    evaluator.ts                    # Rule evaluation engine (sequential + combined LLM)
    utils.ts                        # Shared constants (FILE_TOOLS, LOW_RISK_TOOLS, etc.)
    index.ts                        # ALL_RULES barrel export
    respond-first.ts                # Priority 5:   AI must respond before tools (deterministic)
    plan-mode-block.ts              # Priority 15:  Block writes in plan mode; fast-allow plan files
    background-agent-block.ts       # Priority 25:  Deny Agent(run_in_background=true) from main session
    prediction-question-judge.ts    # Priority 28:  Block stalling AskUserQuestion under frustration
    question-validate.ts            # Priority 30:  Validate AskUserQuestion
    force-check-required.ts         # Priority 32:  Lock to check-satisfying MCPs after workaround denial
    prediction-block.ts             # Priority 35:  Block predicted-bad tools (non-appealable)
    create-planfile-allow.ts        # Priority 36:  Deterministically allow authorized create_planfile calls
    drift-detect.ts                 # Priority 40:  Detect drift from intent
    error-acknowledge.ts            # Priority 50:  Require error acknowledgment
    trusted-path.ts                 # Priority 58:  Deny sensitive-path access
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

  providers/                        # LLM provider backends
    registry.ts                     # Provider registry and model mapping
    anthropic-api-skin.ts           # OpenRouter direct calls
    claude-agent-runtime.ts         # Claude subscription / Claude SDK runtime
    codex-agent-runtime.ts          # OpenAI subscription / Codex SDK runtime

  ai-backend/                       # Provider-neutral JSONL backend for UI sessions
    server.ts                       # stdin/stdout JSONL frame loop
    session-manager.ts              # Session lifecycle and snapshot/event orchestration
    provider.ts                     # Internal SDK runtime runner boundary for UI turns
    transcript-runtime.ts           # Provider transcript projection into visible messages/tools
    live-transcript-watcher.ts      # Transcript/tool-log polling for live timeline snapshots
    timeline-allocator.ts           # Stable sequence hydration for resume/live snapshots
    transcript-store.ts             # Session snapshot state, pending user echo, timeline replacement
    wire.ts                         # Backend wire parsing and serialization helpers

  ai-protocol/                      # Locally owned TypeScript JSONL protocol
    types.ts                        # Public request/response/event/snapshot types
    index.ts                        # Stable barrel export for protocol types

  scenario/                         # Scenario testing + capture pipeline
    types.ts                        # Scenario schema + validateScenario
    runner.ts                       # Scenario execution (single-hook + fan-out)
    replay.ts                       # Full-session transcript replay
    capture.ts                      # Append-only capture JSONL
    snapshot.ts                     # State snapshot JSONL
    epoch.ts                        # Epoch detection + rotation
    lifecycle.ts                    # Epoch-rotation side-effects
    materialize.ts                  # Adapter-aware Scenario reconstruction from capture pointer
    lib/                            # Shared harness, classifier, hook-runner

  adapter/
    types.ts                        # AdapterSpec interface (single source of truth)
    runtime.ts                      # Adapter resolution helpers

  mcp/
    server.ts                       # MCP server exposing tools

  utils/
    agent-runner.ts                 # Unified agent execution (direct + SDK)
    agent-configs.ts                # Centralized agent configurations
    provider-config.ts              # Provider resolution and per-mode routing
    provider-config.ts              # Provider resolution (OpenRouter, Claude subscription, OpenAI subscription)
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

### MCP Timeouts

Agent-framework expects host MCP tool timeouts to be effectively disabled when
the host supports timeout configuration. The shared timeout policy lives in
`src/mcp/timeout.ts`, so per-tool budgets are adapter-independent: tools default
to 300 seconds of active work. Direct `check` calls use a 300-second command
timeout plus a 30-second summary grace window; while check subprocesses run,
the MCP active-work clock is paused and the subprocess command timeout owns
termination. `confirm`, `fullconfirm`, `commit`, `implement`, and
`validate_implementation` use 1500 seconds.
The active-work clock pauses while MCP elicitation is waiting on the user, and
nested MCP-agent calls reuse the outer timeout context instead of stacking a
second timer.

The checked-in Codex adapter config includes the host MCP timeout because Codex
stores that server entry in `adapters/codex/dotcodex/config.toml`. Claude Code
MCP server registration is user/project managed outside `adapters/claude/`, so
there is no Claude adapter MCP config file in this repository. Claude and Codex
still share the same runtime timeout enforcement once a tool call reaches
`src/mcp/server.ts`.

## Adapters

The adapter layer translates between canonical hook handler outputs and the
stdout/exit-code conventions of a specific AI coding tool. Each adapter
implements `AdapterSpec` from `src/adapter/types.ts`, including the encoder,
tool canonicalization, transcript parsing, workflow recognition,
workflow-instruction text lookup, tool-call summaries, and adapter-specific
false-denial/appeal-alias checks.

Today the Claude Code (`adapters/claude/`) and Codex CLI
(`adapters/codex/`) adapters exist. Adding support for another tool requires
only a new adapter directory — the rule logic in `src/hooks/` is unchanged.

See [`adapters/README.md`](adapters/README.md) for the adapter contract and
how to add a new adapter.

### Codex Hook Trust State

Codex separates hook definition from hook review. `adapters/codex/dotcodex/hooks.json`
defines the hook commands, while `adapters/codex/dotcodex/config.toml` stores
`[features].hooks = true` and generated `[hooks.state]` entries. Each
`trusted_hash` fingerprints one hook definition: event name, matcher, command,
timeout, async flag, and status message. If the hook definition changes, the
hash changes and Codex asks the user to review the hook again before it runs.

The generated block in `config.toml` is owned by
`scripts/update-codex-hook-state.mjs` and refreshed by `just build`. This keeps
the Codex review state in the agent-framework repo so downstream builders such
as mcp-toolbox only need to run the normal build command.

## Unified Agent Execution

All agents use the unified `runAgent()` function from `utils/agent-runner.ts`. This provides a single interface regardless of whether the agent uses direct API calls or the host agent's SDK.

### Execution Modes

| Mode   | Description                              | Used By                        |
|--------|------------------------------------------|--------------------------------|
| direct | Single API call, no tools, fast          | Hook agents, check, commit message generation, locate_scenario |
| sdk    | Multi-turn host-agent runtime with scoped tools | confirm, fullconfirm, implement, validate_implementation |

### Why Two Modes?

**Direct Mode** (default):
- Hook agents must be fast (<100ms)
- MCP agents with deterministic commands don't need tool selection
- Single API call is cheaper and more predictable

**SDK Mode** (for confirm/fullconfirm and implementation agents):
- Code quality decisions benefit from autonomous investigation
- Can read additional files to understand context
- Can search codebase for patterns
- Confirm, fullconfirm, and implementation validation use read-only tools.
- The implementation workflow uses an internal write-capable SDK agent whose fake home keeps the same adapter tool surface as managed Astral, including configured MCP tools, with only the Stop hook removed.
- Confirm and fullconfirm always run three SDK reviewers in parallel: one general reviewer, one deduplication/generalization specialist, and one code-quality/pattern specialist. A direct aggregator merges their blocking findings and non-blocking warnings into the final verdict.
- Implement runs one write-capable SDK agent, then parent-owned check, then one read-only SDK validator.

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

The framework supports three LLM providers with one shared resolver for both
direct and SDK execution:

| Provider | Direct runtime | SDK runtime | Cost Tracking |
|----------|----------------|-------------|---------------|
| `openrouter` | OpenRouter Anthropic API skin | Claude Agent SDK or Codex SDK | Direct calls use OpenRouter generation IDs |
| `claude-subscription` | Claude Agent SDK, one turn, no tools | Claude Agent SDK | Events tracked but excluded from cost dashboard |
| `openai-subscription` | Codex SDK, one turn, no tools | Codex SDK | Events tracked but excluded from cost dashboard |

### Configuration Hierarchy

Provider resolution follows this priority order:

1. **Mode-specific env var**: `AGENT_FRAMEWORK_DIRECT_PROVIDER`, `AGENT_FRAMEWORK_SDK_PROVIDER`
2. **Config file tier+mode override**: `.agent-framework.json` -> `tiers.haiku.direct`, etc.
3. **Config file mode override**: `.agent-framework.json` -> `modes.direct`, `modes.sdk`
4. **Global env var**: `AGENT_FRAMEWORK_PROVIDER`
5. **Config file default**: `.agent-framework.json` -> `default`
6. **Hardcoded default**: `openrouter`

### Config File Locations

- Project root: `.agent-framework.json`
- Global: `~/.config/agent-framework/config.json`

```json
{
  "default": "openrouter",
  "modes": {
    "direct": "openrouter",
    "sdk": "openai-subscription"
  },
  "providers": {
    "openrouter": {
      "sdkRuntime": "codex"
    }
  }
}
```

### Runtime Routing

- `openrouter` direct mode uses `@anthropic-ai/sdk` against OpenRouter's Anthropic API skin.
- `openrouter` SDK mode selects Claude Agent SDK or Codex SDK with `AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME`.
- `claude-subscription` always uses Claude Agent SDK, clears API/OpenRouter env vars, and persists provider sessions only for opt-in continuable SDK sessions.
- `openai-subscription` always uses Codex SDK. Public user-runtime sessions use the normal Codex home/config unless `sdkRuntimeHome: "managedAstral"` requests the managed Astral Codex home under `~/.agent-framework/astral-ai/codex` for session-choice listing and resume. Managed Astral refreshes replace framework-owned adapter config while preserving auth/local-secret files and durable history directories such as Codex `sessions/` and Claude `projects/`. Internal direct and read-only framework runs use per-run homes under `~/.agent-framework/internal/{direct,read-only}/{claude,codex}/<runId>` with no durable user-session history. Internal write runs use per-run homes under `~/.agent-framework/internal/write/{claude,codex}/<runId>` and persist useful state under `~/.agent-framework/internal/sessions/write/<runId>`. Opt-in continuable SDK sessions keep live Codex thread state until disposal.

### Provider Model IDs

Each provider uses different model identifiers:

| Tier | OpenRouter ID | Claude subscription ID | OpenAI subscription ID |
|------|---------------|------------------------|------------------------|
| haiku | `deepseek/deepseek-v4-flash` | `claude-haiku-4-5` | `gpt-5.6-luna` + `low` reasoning |
| sonnet | `deepseek/deepseek-v4-pro` | `claude-sonnet-4-5` | `gpt-5.6-sol` + `medium` reasoning |
| opus | `google/gemini-3.5-flash` | `claude-opus-4-5` | `gpt-5.6-sol` + `max` reasoning |

### Telemetry Behavior

The `provider` field in telemetry events tells the telemetry server how to handle costs:

- **openrouter direct**: Fetch cost from OpenRouter API using `generationId`, include in LLM cost dashboard
- **openrouter SDK**: Exclude from OpenRouter generation-cost lookup
- **claude-subscription/openai-subscription**: Skip OpenRouter API call, exclude from cost dashboard (event still fully tracked)

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
| sonnet | sdk    | implement and implement-validator agents used by MCP-owned implementation workflows |
| opus   | sdk    | confirm and fullconfirm reviewers (general, deduplication, and code-quality/pattern investigation) |

## Agent Chains

MCP agents chain together for verification:

```
commit → normalize moved files → confirm → check
  │              │               │         │
  │              │               │         └─ Runs linter + make/just check + deterministic filename-reference diagnostics + supplemental editor diagnostics (sonnet, direct)
  │              │               └─ Analyzes git diff with three SDK reviewers + direct aggregator
  │              └─ Stages detected moved+recreated path pairs before confirm so Git reports renames
  └─ Generates commit message + executes commit (haiku, direct)

fullconfirm → check
  │           │
  │           └─ Runs linter + make/just check + deterministic filename-reference diagnostics + supplemental editor diagnostics (sonnet, direct)
  └─ Reviews git-visible repository scope with three SDK reviewers + direct aggregator

implement → internal write implementer → check → implementation validator
  │                                    │      │
  │                                    │      └─ Read-only SDK validation against the plan (`src/agents/mcp/implementation-workflow.ts`)
  │                                    └─ Parent-owned check (`src/agents/mcp/check.ts`)
  └─ MCP entrypoint in `src/agents/mcp/implement.ts`; direct adapter agents are compatibility wrappers
```

## MCP Elicitation

The `commit`, `confirm`, `fullconfirm`, and `push` tools use MCP elicitation (`server.elicitInput()`) to ask users structured questions mid-tool-execution, replacing the previous pattern where slash commands instructed the agent to call `AskUserQuestion`.

### Flow (commit/confirm/fullconfirm)

```
Tool called → getRepoInfo()
  → Multiple repos? → elicitInput: all repos vs individual repos
  → All repos:
      → commit: normalize moved+recreated path pairs in each selected repo before confirm
      → Run one combined confirm/check scope across dirty repos, or fullconfirm/check scope across selected repositories
      → commit: reuse that confirm result while committing each dirty repo
  → Individual repos:
      → elicitInput: repo selection form
      → For each repo → elicitInput: tier + focus preferences form
      → Run agent chain per selected repo
  → Return results
```

### Confirm Uncertainty Elicitation (last resort)

When the confirm or fullconfirm agent DECLINEs with `UNCERTAIN:` markers, the tool callback elicits user clarification and re-runs:

```
confirm/fullconfirm returns DECLINED + UNCERTAIN markers
  → Parse markers → elicitInput: clarification form
  → User provides input → re-run the same confirm/fullconfirm tool with extra_context
  → Return new result (or original DECLINED if user cancels)
```

### Skip Elicitation

All four tools accept `skip_elicitation: true` to bypass interactive questions and use defaults. For `confirm`, `fullconfirm`, and `commit`, this selects the all-repos scope and defaults the confirm tier to `opus` when no tier is provided. Used by `/quickpush` and `/fullquickconfirm` for zero-interaction workflows.

## SDK Agent Restrictions

Confirm and fullconfirm SDK reviewers use the shared read-only policy:

- **Read**: View file contents
- **Bash**: Run guarded read-only inspection commands

Write/edit tools are not available to confirm reviewers. Git status and diff
data are still passed in the prompt so review agents do not need write access.

The implementation workflow uses two separate SDK policies:

- **Implementer**: write-capable internal runtime that uses the same adapter
  config surface as managed Astral, including configured MCP tools, plugins,
  project trust, and file editing tools. The internal write home remains the
  existing per-run fake home, and only the Stop hook is removed.
- **Validator**: read-only internal runtime with `Read` and guarded `Bash`

This lets implementation agents modify code while confirm and validation agents
can investigate without editing files.

## Hook Flow (PreToolUse)

The PreToolUse hook uses a rule-based pipeline. Each check is a `PreToolRule` object
evaluated sequentially by priority. Rules return `fastDeny`, `fastAllow`, `llmContext`,
or `null` (skip). Triggered `llmContext` rules are combined into one haiku LLM call.

```
Tool call received
├─> Rule pipeline (evaluateRules):
│   ├─> respond-first (5)     Fast deny if no text before tools (deterministic)
│   ├─> plan-mode-block (15)  Fast deny writes in plan mode; fast-allow plan files
│   ├─> background-agent-block (25) Fast deny Agent(run_in_background=true)
│   ├─> prediction-question-judge (28) Block stalling AskUserQuestion under frustration
│   ├─> question-validate (30) Validate AskUserQuestion
│   ├─> force-check-required (32) Lock to check-satisfying MCPs after workaround denial
│   ├─> prediction-block (35)  Block predicted-bad tools (deterministic, non-appealable)
│   ├─> create-planfile-allow (36) Deterministically allow authorized create_planfile calls
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
│   Workflow-only slash/skill invocations are handled on UserPromptSubmit by
│   reading canonicalized workflow instruction text and deriving an ordered
│   `explicitlyRequiredTools` queue plus `nonBlockingTools`. The prediction
│   policy requires the next queued tool before arbitrary progress; matching
│   non-blocking tools are allowed without consuming the queue. Default
│   non-blocking support tools are derived from the shared low-risk tool list,
│   excluding queue-consuming waits.
│
├─> Rewind detection (after rules, before validators)
│
├─> claude-md-validate (Sonnet) for CLAUDE.md edits
│
└─> Post-allow bookkeeping (tool count, ExitPlanMode cleanup)
```

Planfile text edit calls are not validated on every write. The file-backed
planfile remains the source of truth. Plan1/plan3/plan5
consolidation creates the plan through the `create_planfile` MCP tool, which
uses the shared planfile path helper, writes the named planfile, normalizes the
`Plan Name` header and `Planfile Path` footer, then invokes the same
`validate_plan` contract path for the written content. `validate_plan` remains
available for explicit revalidation and is the tool named in failure
remediation when the agent must iterate on an existing planfile. The Codex
Stop-hook acceptance boundary for a whole-message `<proposed_plan>` parses the
inline presentation through the adapter, checks it against the plan contract
and the matching planfile, uses session validation status keyed by plan path
plus content hash, and updates `current-plan.json` when the exact presented
plan is accepted. If the first inline Codex plan has no valid `Plan Name` and
there are no accepted session planfiles yet, the Stop hook derives a session
planfile name, creates the file through the shared creator path, validates it,
and blocks with the created path plus validation feedback so the agent can
iterate on the concrete planfile.

Adding a new check: create `src/rules/my-rule.ts` implementing `PreToolRule`,
add to `ALL_RULES` in `src/rules/index.ts`, add display name to statusline.

### Pipeline: one evaluator, one LLM call

Every tool call runs every rule in `src/rules/index.ts`'s `ALL_RULES`. Rules either short-circuit with `fastAllow`/`fastDeny` (pure TypeScript, <10ms) or return `llmContext`. The evaluator aggregates every triggered rule's `llmContext` into a SINGLE rule-gate haiku call (`rules/evaluator.ts:99–135`). There is no sync-vs-lazy bifurcation: every rule participates on every call.

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

### `providers/`
Provider execution backends. `anthropic-api-skin.ts` handles OpenRouter direct
calls, `claude-agent-runtime.ts` handles Claude subscription and Claude-backed
OpenRouter SDK calls, and `codex-agent-runtime.ts` handles OpenAI subscription
and Codex-backed OpenRouter SDK calls.

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
| `OPENROUTER_API_KEY` | OpenRouter | OpenRouter API key |
| `ANTHROPIC_API_KEY` | Anthropic/OpenRouter direct | Anthropic API key, or explicitly empty for OpenRouter Claude routing |
| `ANTHROPIC_AUTH_TOKEN` | OpenRouter Claude routing | OpenRouter key used as Anthropic auth token |
| `ANTHROPIC_BASE_URL` | OpenRouter Claude routing | `https://openrouter.ai/api` |
| `AGENT_FRAMEWORK_PROJECT_DIR` | Auto | Shared host project directory; takes precedence over `CLAUDE_PROJECT_DIR` when set |
| `CLAUDE_PROJECT_DIR` | Auto | Host project directory fallback when `AGENT_FRAMEWORK_PROJECT_DIR` is unset |
| `AGENT_FRAMEWORK_ROOT` | Yes (hooks) | Path to agent-framework directory |
| `AGENT_FRAMEWORK_PROVIDER` | No | Global provider (`openrouter`, `claude-subscription`, `openai-subscription`) |
| `AGENT_FRAMEWORK_DIRECT_PROVIDER` | No | Provider for direct mode agents |
| `AGENT_FRAMEWORK_SDK_PROVIDER` | No | Provider for SDK mode agents |
| `AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME` | No | OpenRouter SDK runtime (`claude` or `codex`) |
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
| `locate-scenario.ts` | 1 on successful matches | `CONFIRM` | `direct` |
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

Each live session persists core state files under
`~/.agent-framework/sessions/{project}/{timestamp}_{hash}/`. The shared
agent-framework session resolver maps hook transcript paths to these directories
and writes `transcript-path.txt`; MCP tools without a transcript path use the
latest sidecar for the active project as the current session.

Internal framework SDK runs do not enter this user-session namespace. Direct
and read-only internal profiles use volatile state under
`~/.agent-framework/internal/volatile/<run-id>` and clean it when the run ends.
Write-capable internal implementation runs persist under
`~/.agent-framework/internal/sessions/write/<run-id>`. Unavoidable scratch
space is rooted under `/tmp/agent-framework`.

1. **`state.json`** — SessionState (prediction, edit-intent, force-check lockout, frustration streak, window size, tool count).
2. **`gate-reasoning.json`** — priority-evicted denial memory with NOTE/WARNING/appeal outcomes.
3. **`tool-log.jsonl`** — append-only audit trail consumed by drift-detect, error-acknowledge, pre-tool-use, gate-reasoning, the test-harness, and AI backend UI/resume metadata hydration.

Legacy `timeline-state.json` files are ignored by active AI backend resume.
Visible rows are rebuilt from the provider transcript and tool log each time.

Plan-mode and reproducibility sidecars live in the same session directory:
`plans/<name>.md` stores named session planfiles, `current-plan.json` stores
the active file-backed plan descriptor, and `plan-validation-status.json`
records exact-content plan validation pass/fail status keyed by resolved
planfile path plus content hash.

Captured hook decisions are converted back into executable scenarios by
`src/scenario/materialize.ts`, usually through the `scenario_tester` MCP action
`materialize_scenario`. The materializer reads the session's
`transcript-path.txt`, infers the transcript adapter from paths such as
`/.claude/` or `/.codex/`, parses through that adapter, and writes durable
scenario JSON under `~/.agent-framework/test-runs/scenarios/`. Rewind anchors
use raw transcript-line UUIDs, so adapter-normalized message IDs are not
required to preserve the capture boundary.

Captured hook decisions can be located from user-provided quote substrings via
the `locate_scenario` MCP before materialization. That tool runs fixed literal
searches over raw Claude/Codex transcripts and session logs, cross-references
tool and injection hits against `captures.jsonl`, and uses a haiku-level direct
LLM call only to summarize successful findings. If no predefined search finds a
candidate, it returns the manual fallback guidance instead of materializing.

`create_planfile` resolves `plans/<name>.md` under the current session via the
shared resolver and returns the planfile path together with the validation
PASS/FAIL result. Scenario and replay transcripts under
`~/.agent-framework/test-runs/` use their containing cache directory as the
session directory so test artifacts stay isolated.

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

### Background Agent Policy

`background-agent-block` denies `Agent` calls with `run_in_background=true` as a non-appealable foreground-only Agent policy.

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
