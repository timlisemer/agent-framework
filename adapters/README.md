# Adapters

Adapters translate between the canonical hook handler interface and the
stdout/exit-code conventions of a specific AI coding tool (Claude Code, Codex,
etc.).

## Adapter Contract

Every adapter exports an object that implements `AdapterEncoder` from
`src/adapter/types.ts`. Handlers receive an encoder instance and call it to
produce the output; the adapter owns the stdout JSON shape and exit code.

See [`src/adapter/types.ts`](../src/adapter/types.ts) for the full interface.

## Available Adapters

| Directory       | Tool            | Status  |
|-----------------|-----------------|---------|
| `claude/`       | Claude Code     | Active  |
| `codex/`        | Codex CLI       | Active  |

## Adding a New Adapter

1. Create `adapters/<name>/` with an `index.ts` that exports an
   `AdapterEncoder` implementation.
2. Add hook entry points under `adapters/<name>/hooks/` that import the
   encoder and pass it to the canonical `mainXxx` handlers from `src/hooks/`.
3. Register the hook scripts in the tool's configuration file
   (e.g. `adapters/<name>/dotclaude/settings.json`).

### Codex Example

```typescript
// adapters/codex/index.ts
import type { AdapterEncoder } from "../../src/adapter/types.js";

export const codexEncoder: AdapterEncoder = {
  name: "codex",
  encodePreToolUseAllow: () => ({ exitCode: 0, stdout: "" }),
  encodePreToolUseDeny: (reason) => ({
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  }),
  // ...
};
```

## Shared Transcript Policy

Shared hook logic in `src/` reads a canonical transcript shape. Claude Code
already writes that shape directly (`message.role/content`, `isMeta`, and
split assistant messages). Codex rollout JSONL is normalized into the same
shape at the transcript utility boundary. Adapter encoders still own only host
stdout/exit-code conventions; policy and workflow authorization stay shared.

## Scenario Format

Scenarios for testing are under `scenarios/`. See
[`src/scenario/README.md`](../src/scenario/README.md) for the format spec.
