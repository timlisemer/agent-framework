# Adapters

Adapters translate between the canonical hook handler interface and the
stdout/exit-code conventions of a specific AI coding tool (Claude Code, Codex,
etc.).

## Adapter Contract

Every adapter exports an object that implements `AdapterSpec` from
`src/adapter/types.ts`. The spec includes an `AdapterEncoder` for stdout and
exit-code shaping, plus adapter-owned tool canonicalization, transcript
normalization, workflow recognition, workflow-instruction text lookup,
tool-call LLM summaries, and adapter-specific false-denial/appeal-alias
checks.

See [`src/adapter/types.ts`](../src/adapter/types.ts) for the full interface.

Adapters also own transcript normalization. Native hook boundaries call the
active adapter's `parseTranscript` and dispatch the resulting observation into
the canonical runtime. New adapters must keep all raw transcript shape
knowledge inside their adapter parser.

Adapters also expose `workflowInstructionText` for canonical slash/skill
workflows. Each adapter normalizes host wire spellings in that instruction
text before returning it. Shared UserPromptSubmit code then derives ordered
required workflow tools and non-blocking tools from canonical text, keeping
policy enforcement in `src/`. Put common adapter-wire lookup helpers in
`adapters/shared/`; keep workflow authorization and prediction behavior in
`src/`.

Workflow queue prediction intentionally prefers the bundled repo instruction
definitions before host config copies, so enforcement follows reviewed source;
the host config path is a fallback for installed or out-of-tree runtimes.

Real `~/.claude` and `~/.codex` homes remain managed outside runtime code.
Managed runtime homes under `~/.agent-framework/managed/default/{claude,codex}` mirror
the bundled adapter dotfolders while preserving auth/local-secret files.
Internal framework homes live under
`~/.agent-framework/internal/{direct,read-only,write}` and are selected by
runtime profile.

## Available Adapters

| Directory       | Tool            | Status  |
|-----------------|-----------------|---------|
| `claude/`       | Claude Code     | Active  |
| `codex/`        | Codex CLI       | Active  |

Shared adapter-wire helpers that are intentionally reused by multiple
adapters live under `adapters/shared/`. Keep policy, workflow authorization,
and adapter-independent behavior in `src/`.

## Adding a New Adapter

1. Create `adapters/<name>/` with an `index.ts` that exports an
   `AdapterSpec` implementation.
2. Add hook entry points under `adapters/<name>/hooks/` that import the
   encoder and pass it to the canonical `mainXxx` handlers from `src/hooks/`.
3. Register the hook scripts in the tool's configuration file
   (e.g. `adapters/<name>/dotclaude/settings.json`).

### Codex Example

```typescript
// adapters/codex/index.ts
import type { AdapterSpec } from "../../src/adapter/types.js";

export const codexSpec: AdapterSpec = {
  name: "codex",
  encoder: codexEncoder,
  canonicalizeToolCall,
  summarizeToolCallForLlm,
  // ...
};
```

## Shared Transcript Policy

Shared hook logic in `src/` reads a canonical transcript shape. Claude Code
already writes that shape directly (`message.role/content`, `isMeta`, and
split assistant messages). Codex rollout JSONL is normalized into the same
shape at the transcript utility boundary. Adapters own host stdout/exit-code
conventions and raw host shape translation; policy and workflow authorization
stay shared.

## Scenario Format

Scenarios for testing are under `scenarios/`. See
[`src/scenario/README.md`](../src/scenario/README.md) for the format spec.
