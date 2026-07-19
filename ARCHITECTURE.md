# Architecture

This document explains the architectural decisions in the agent-framework.

## Scenario Magna Lingua

`ScenarioRuntime.dispatch(command)` is the sole behavioral entry point for
Claude/Codex hooks, fixture execution, provider SDK callbacks, and gateway
commands. Boundary adapters normalize native data and encode native results;
they do not evaluate rules or write semantic sidecars. The runtime commits one
canonical record batch as a single framed JSONL array before publishing it and
reduces that same batch into the only authoritative snapshot. Recovery discards
an incomplete trailing frame in full, so a partial command never becomes
authoritative.

Durable runs use this adapter-neutral layout:

```text
~/.agent-framework/
  runs/<run-id>/
    manifest.json
    scenario.records.jsonl
    scenario.snapshot.json
    feedback.jsonl
    artifacts/<sha256>
  run-index.jsonl
```

The registry discovers hook, fixture, and provider runs from manifests and can
reconstruct a stale index. Storage policy (`durable` or `ephemeral`) is recorded
data; record, reducer, cursor, and recovery semantics do not vary by entry path.
Fixture expectations are authored test assertions, while manual feedback is
validated and appended independently.

Operational recovery is current-format correctness: journal repair, snapshot
repair, retries, resynchronization, effect claims, provider settlement bounds,
and native tool-ID reconciliation restore or fence the contract documented
here. A compatibility shim instead accepts a superseded name or wire format.
The Scenario core contains no old `ai-protocol` or `managedAstral` path; its
recovery machinery must not be removed merely because it resembles a fallback.

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
      check.ts                      # Runs linter + make/just check + deterministic filename-reference diagnostics, repository-wide style-drift warnings, and supplemental editor diagnostics
      create-planfile.ts            # Writes named planfiles and runs validation
      confirm.ts                    # Code quality gate (SDK mode)
      drift-window.ts               # MCP validation-feedback drift policy
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
    blacklist.ts                    # Priority 34:  Deterministic Bash policy; check redirects seed prediction
    prediction-block.ts             # Priority 35:  Block predicted-bad tools (non-appealable)
    create-planfile-allow.ts        # Priority 36:  Deterministically allow authorized create_planfile calls
    drift-detect.ts                 # Priority 40:  Detect drift from intent
    error-acknowledge.ts            # Priority 50:  Require error acknowledgment
    trusted-path.ts                 # Priority 58:  Deny sensitive-path access
    edit-intent.ts                  # Priority 60:  Block edits without intent
    prediction-context.ts           # Priority 68:  Prediction context for rule-gate LLM
    recent-messages.ts              # Priority 70:  Recent user messages context
    reasoning-history.ts            # Priority 72:  Gate reasoning history context
    edit-intent-context.ts          # Priority 74:  Edit intent context signal
    plan-mode-context.ts            # Priority 76:  Plan mode context signal
    tool-approve.ts                 # Priority 100: Final tool approval (deterministic + llmContext)
    sentiment.ts                    # Priority 10:  Classify user mood/intent (UserPromptSubmit)
    validate-intent.ts              # Priority 50:  Check if AI followed user intentions (PreToolUse)
    response-align-stop.ts          # Priority 50:  Validate stop responses (Stop)

  hooks/                            # Thin native boundary entrypoints
    pre-tool-use.ts                 # Parse, dispatch, encode only
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

  ai-backend/                       # Scenario gateway and provider host boundary
    server.ts                       # Scenario-only stdin/stdout frame loop
    gateway.ts                      # Run discovery, commands, cursor-safe subscriptions
    scenario-provider-manager.ts    # Canonical provider lifecycle; no UI/session projection
    provider.ts                     # SDK adapter emitting canonical runtime commands
    provider-settlement.ts          # Bounded provider cleanup and late-promise observation
    wire.ts                         # Gateway frame parsing and serialization

  scenario/                         # Reusable canonical protocol, runtime, and fixtures
    contract-cli.ts                 # Compiled cross-repository contract operations
    protocol/                       # Generated schemas and the shared command-envelope factory
    runtime/                        # Transactional command dispatch and effect execution
    store/                          # Journals, snapshots, manifests, artifacts, feedback
    fixtures/                       # Fixture runner, validator, and materializer

  entrypoints/                      # Application-owned host boundaries
    native-transcript.ts            # Adapter-normalized transcript records

  scripts/
    statusline.ts                   # Host statusline entry point
    statusline-projection.ts        # Statusline-specific canonical-record projection

  adapter/
    types.ts                        # AdapterSpec interface (single source of truth)
    runtime.ts                      # Adapter resolution helpers

  mcp/
    server.ts                       # MCP server exposing tools

  utils/
    agent-runner.ts                 # Unified agent execution (direct + SDK)
    agent-configs.ts                # Centralized agent configurations
    provider-config.ts              # Provider resolution (OpenRouter, Claude subscription, OpenAI subscription)
    response-parser.ts              # Text extraction + decision parsing
    retry.ts                        # Generic format validation retry
    transcript-presets.ts           # Standard transcript configurations
    transcript.ts                   # Transcript reading utilities
    logger.ts                       # Telemetry logging
    prediction-types.ts             # Sentiment-prediction shape + policy table
    prediction-parser.ts            # Marker-section parser for SENTIMENT_AGENT
    drift-detector.ts               # Pure TypeScript drift/anomaly heuristics
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
only a new adapter directory - the rule logic in `src/hooks/` is unchanged.

See [`adapters/README.md`](adapters/README.md) for the adapter contract and
how to add a new adapter.

### Codex Hook Trust State

Codex separates hook definition from hook review. The typed
`adapters/codex/hook-config.ts` configuration defines the hook commands and
shared lifecycle matcher. `just build` generates
`adapters/codex/dotcodex/hooks.json` from that source of truth, while
`adapters/codex/dotcodex/config.toml` stores `[features].hooks = true` and
generated `[hooks.state]` entries. Each
`trusted_hash` fingerprints one hook definition: event name, matcher, command,
timeout, async flag, and status message. If the hook definition changes, the
hash changes and Codex asks the user to review the hook again before it runs.

The generated `hooks.json` file and block in `config.toml` are owned by
`scripts/update-codex-hook-state.mjs` and refreshed by `just build`. This keeps
the Codex hook configuration and review state in the agent-framework repo so
downstream builders such as mcp-toolbox only need to run the normal build
command.

## Unified Agent Execution

All agents use the unified `runAgent()` function from `src/utils/agent-runner.ts`. This provides a single interface regardless of whether the agent uses direct API calls or the host agent's SDK.

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
- The implementation workflow uses an internal write-capable SDK agent whose isolated home keeps the configured adapter tool surface and MCP tools, with only the Stop hook removed.
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

All agent configs are defined in `src/utils/agent-configs.ts`:

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
- `openai-subscription` always uses Codex SDK. Public user-runtime sessions use the normal Codex home/config or a generic managed profile recorded in the run manifest. Managed refreshes preserve auth/local-secret files and durable history directories such as Codex `sessions/` and Claude `projects/`. Internal direct and read-only framework runs use per-run homes under `~/.agent-framework/internal/{direct,read-only}/{claude,codex}/<runId>` with no durable user-session history. Internal write runs use per-run homes under `~/.agent-framework/internal/write/{claude,codex}/<runId>` and persist useful state under `~/.agent-framework/internal/sessions/write/<runId>`. Opt-in continuable SDK sessions keep live Codex thread state until disposal.

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
| haiku  | direct | rule-gate, tool-appeal, commit, question-validate, sentiment, validate-intent, response-align-stop |
| sonnet | direct | check, plan-validate, claude-md-validate |
| sonnet | sdk    | implement and implement-validator agents used by MCP-owned implementation workflows |
| opus   | sdk    | confirm and fullconfirm reviewers (general, deduplication, and code-quality/pattern investigation) |

## Agent Chains

MCP agents chain together for verification:

```
commit → normalize moved files → confirm → check
  │              │               │         │
  │              │               │         └─ Runs linter + make/just check + deterministic filename-reference diagnostics + repository-wide style-drift warnings + supplemental editor diagnostics (sonnet, direct)
  │              │               └─ Analyzes git diff with three SDK reviewers + direct aggregator
  │              └─ Stages detected moved+recreated path pairs before confirm so Git reports renames
  └─ Generates commit message + executes commit (haiku, direct)

fullconfirm → check
  │           │
  │           └─ Runs linter + make/just check + deterministic filename-reference diagnostics + repository-wide style-drift warnings + supplemental editor diagnostics (sonnet, direct)
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
  configured adapter surface, including MCP tools, plugins,
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
│   ├─> blacklist (34)          Deny unsafe/check-routed Bash; seed check prediction on redirects
│   ├─> prediction-block (35)  Block predicted-bad tools (deterministic, non-appealable)
│   ├─> create-planfile-allow (36) Deterministically allow authorized create_planfile calls
│   ├─> drift-detect (40)      Detect drift from user intent (appealable)
│   ├─> error-acknowledge (50) Require error acknowledgment (appealable, LLM)
│   ├─> trusted-path (58)      Fast deny sensitive paths
│   ├─> edit-intent (60)       Block edits without intent (appealable)
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
and the matching planfile, and commits the active descriptor and validation
result through canonical state changes when the exact presented plan is
accepted. If the first inline Codex plan has no valid `Plan Name` and
there are no accepted session planfiles yet, the Stop hook derives a session
planfile name, creates the file through the shared creator path, validates it,
and blocks with the created path plus validation feedback so the agent can
iterate on the concrete planfile.

Adding a new check: create `src/rules/my-rule.ts` implementing `PreToolRule`,
add to `ALL_RULES` in `src/rules/index.ts`, add display name to statusline.

### Pipeline: one evaluator, one LLM call

Every tool call runs every rule in `src/rules/index.ts`'s `ALL_RULES`. Rules either short-circuit with `fastAllow`/`fastDeny` (pure TypeScript, <10ms) or return `llmContext`. The evaluator aggregates every triggered rule's `llmContext` into a SINGLE rule-gate haiku call (`src/rules/evaluator.ts:99-135`). There is no sync-vs-lazy bifurcation: every rule participates on every call.

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

Repository-wide style drift is checked deterministically by the check MCP, not
the PreToolUse rule pipeline. Git-visible text files are scanned through the
bounded no-follow inventory reader; findings and any unreadable, non-regular,
or safety-limit omissions are appended as warnings.
Intentional fixtures may use the comment markers
`agent-framework-style-drift-ignore-next-line` or
`agent-framework-style-drift-ignore-file`.

### `agent-configs.ts`
Centralized agent configurations with documentation:
- `CHECK_AGENT` - sonnet, direct
- `CONFIRM_AGENT` - opus, SDK
- `COMMIT_AGENT` - haiku, direct
- `VALIDATE_INTENT_AGENT` - haiku, direct (inlined into validateIntentRule side-effect pattern)
- `TOOL_APPROVE_PROMPT_SECTION` - prompt body for tool-approve rule
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
| `src/rules/question-validate.ts` | 1 | via `runAgent` in rule check | `direct` |
| `push.ts` | 0 | - | - |

## Run State Persistence

Live semantic state exists only in canonical run directories under
`~/.agent-framework/runs/<run-id>/`. `session.workflow` is the single typed
state slice for workflow prediction, frustration, edit intent, drift, and tool
queue fields; those concepts are not mirrored into shadow slices. Gate
reasoning, plan mode, injections, provider metadata, store health, and errors
remain canonical snapshot or journal state. Rules receive a read-only
snapshot-derived context. When a host exposes history only through a native
transcript, the boundary parses one stabilized observation, dispatches
`nativeTranscriptObserved`, and commits its application-owned rule projection
as `host.context` with the host command. Rule effects consume that committed
context and a canonical transcript reconstructed from the same snapshot; they
never re-read the adapter-native file. Internal SDK scratch/runtime homes remain
deployment details, not scenario state.

Host-session workspaces under `~/.agent-framework/sessions/` remain
nonsemantic locators for native transcripts, adapter planfiles, and MCP
coordination. They do not compete with canonical run identity. Managed Codex
homes receive the canonical provider run ID explicitly so configured hooks
join that run; provider events and hook commands retain their own source data
inside the same journal.

Named Markdown planfiles under `plans/<name>.md` are external artifacts. The
active file-backed plan descriptor and validation outcome are canonical state
slices and journal records; no behavioral JSON sidecars authorize plan exit.

Canonical runs are converted into executable fixtures by
`src/scenario/fixtures/materialize.ts`, usually through the `scenario_tester`
MCP action `materialize_scenario`. The materializer reads the canonical journal
and snapshot for the selected `run_id` and writes fixture JSON under
`~/.agent-framework/test-runs/scenarios/`.

Hook decisions can be located from user-provided quote substrings via
the `locate_scenario` MCP before materialization. That tool runs fixed literal
searches over canonical journals plus digest-verified artifacts, maps artifact
matches back to their linking journal records, and uses a haiku-level direct
LLM call only to summarize successful findings.

`create_planfile` resolves `plans/<name>.md` under the current session via the
shared resolver and returns the planfile path together with the validation
PASS/FAIL result. Fixture materialization is journal-based and does not create
or resolve replay transcript session directories.

Compaction recovery relies on the host agent's native transcript compaction; no
app-layer summary is re-injected. A shortened, cleared, or rewound native
observation retires entries missing from the new active projection. Retirement
is journaled, so historical content remains auditable, while snapshot-derived
rule input contains only the latest native history. When a terminal tool first
arrives through PreToolUse/PostToolUse and later appears in the native
transcript, the importer claims that existing canonical tool ID without
duplicating its lifecycle. Native-to-canonical aliases are persisted in the
active transcript state, so a subsequent observation retires the canonical
tool exactly once; ambiguous name-and-input matches are rejected.

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
