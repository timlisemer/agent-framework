# Planning Contract

## Codex Auto Compaction

Auto compaction must stay off for planning sessions. Use the documented Codex
configuration key `model_auto_compact_token_limit`, described by the Codex
configuration reference as the token threshold that triggers automatic
conversation compaction; do not invent another setting name.

Every final plan must be decision-complete, concrete, and detailed enough that two independent implementers make the same edits without asking follow-up questions.

Do not present a final plan while required information is missing. If an assumption cannot be answered from the user message, repository files, documentation, or available tools, ask the user before presenting the final plan.

Use Markdown headings, numbered lists, bullet lists, and fenced code blocks. Do not use markdown tables.

## Required Final Plan Structure

Final plans must start with `Plan Name: <lowercase-kebab-name>`, then use this section order:

1. `## User Goal`
2. `## Answered Assumptions`
3. `## Goal In My Words`
4. `## Approach`
5. `## Data Flow`
6. `## Files To Create`
7. `## Files To Modify`
8. `## Implementation Order`
9. `## Assistant Verification`
10. `## Manual User Verification`
11. `## Approaches Decided Against`
12. `## Possible Future Followups`
13. `## Relevant Files`
14. `## Files That Need Changes`

If a section is not applicable, include the heading and state why it is not applicable. Do not omit required headings.

Final plans must end with `Planfile Path: <path>` followed by `Plan Name: <same-name>`.

## User Goal

Start by quoting the user's goal verbatim.

When the user provided multiple relevant messages, quote the parts that define the requested outcome and any corrections or constraints that materially affect the plan.

Example:

```md
## User Goal

> "Add a setting that disables background sync."

> "Do not add a migration unless it is required."
```

## Answered Assumptions

List every assumption or question that existed while planning and the answer that resolved it.

Each item must include:

1. The assumption or question.
2. The answer.
3. The source of the answer.

Accepted answer sources:

- User text.
- Repository inspection.
- Official documentation or other resources inspected during planning.
- A direct user answer obtained before presenting the final plan.

Do not include unresolved assumptions. Do not write phrases like "assuming", "probably", "should be", "likely", or "if needed" for required behavior.

Good:

```md
1. The Codex MCP check tool name uses underscores.
   Answer: `adapters/codex/recognize-mcp.ts` recognizes `mcp__agent_framework__check`, and `adapters/codex/dotcodex/skills/agent-framework-check/SKILL.md` uses that spelling.
```

Bad:

```md
1. The check MCP is probably `mcp__agent_framework__check`.
```

If a required assumption cannot be resolved, do not present the final plan. Ask the user first.

## Goal In My Words

Restate the goal in the agent's own words.

This section must preserve the user's intent, constraints, and scope. Do not add unrelated work.

## Approach

Describe the chosen implementation approach.

This must be one chosen path, not a menu of choices. Do not present live branches such as `Option A:`, `Approach 1:`, or `Alternative 1:`.

It is allowed to describe rejected approaches later in `## Approaches Decided Against`, but those must be plain rejected-approach bullets, not live options.

## Data Flow

Include an ASCII data-flow diagram when the change is non-trivial, multi-file, multi-component, stateful, hook-based, or crosses module boundaries.

The diagram must show the important inputs, transformations, state, and outputs.

Example:

```text
UserPromptSubmit
  permission_mode + transcript_path
        |
        v
plan-mode detector
        |
        v
session sidecar state
        |
        v
inactive -> active?
        |
        +-- yes: inject planning contract context
        +-- no: normal success
```

For a simple single-file text-only change, write:

```md
Not required because this is a single-file documentation-only change with no data flow.
```

## Files To Create

List each new file with a concrete description of its contents.

For each new file, include enough structure that the implementer knows what to write.

Good:

```md
1. `src/utils/plan-mode-entry-state.ts`
   Create a helper that exports `detectPlanModeEntryAndBuildInjection`. The helper reads previous plan-mode state from `sessionPlanModeStateFile(sessionDir)`, computes current state from `permissionMode` or transcript fallback, writes the new state, and returns an injection message only on inactive-to-active transitions.
```

Bad:

```md
1. `src/utils/plan-mode-entry-state.ts`
   Add helper.
```

## Files To Modify

List each existing file with precise changes.

For code files, include:

- The path.
- The approximate location or anchor.
- The function, type, or exported symbol affected.
- The concrete behavior change.
- Quoted code or pseudocode when prose alone leaves room for interpretation.

Good:

````md
1. `src/hooks/user-prompt-submit.ts`
   After `planMode` is computed and before the final `encoder.encodeOk("UserPromptSubmit")`, call:

   ```ts
   const injection = await detectPlanModeEntryAndBuildInjection({
     source: "UserPromptSubmit",
     sessionDir,
     transcriptPath: input.transcript_path,
     projectDir,
     permissionMode: input.permission_mode,
   });

   if (injection.message && encoder.encodeContext) {
     const out = encoder.encodeContext("UserPromptSubmit", injection.message);
     await exitAfterFlush(out.exitCode, out.stdout);
     return;
   }
   ```
````

Bad:

```md
1. `src/hooks/user-prompt-submit.ts`
   Update it to inject the planning contract.
```

## Implementation Order

Write numbered implementation steps in the order they should be done.

Each step must be concrete. If a step modifies code, name the file and behavior. If a step adds tests, name the test file and scenario.

Do not include time estimates.

Do not use schedule buckets like "morning", "day 1", or "week 2".

## Assistant Verification

Assistant Verification is for AI-run verification only.

For this project, Assistant Verification must call the Codex agent-framework check MCP after each larger code change:

```text
mcp__agent_framework__check
```

Always include `working_dir` set to the repository path.

Treat the check MCP as the repository-level replacement for direct shell check, lint, test, build, typecheck, format, and package-manager commands. Do not instruct the assistant to run those shell commands directly, including targeted shell test commands before the MCP.

Good:

```md
## Assistant Verification

Run `mcp__agent_framework__check` with `working_dir` set to `/path/to/repo` after each larger code change.
```

Bad:

```md
## Assistant Verification

Run `npm test`.
Run `npm run lint`.
Run `just check`.
```

Do not use generic headings like `## Verification`, `## Testing`, or `## Test Plan`.

## Manual User Verification

Manual User Verification is only for checks the user must perform outside AI-accessible verification.

Use this section for browser checks, deployed-environment checks, remote access checks, ssh checks, curl checks against a deployed service, or other user-only validation.

Do not put project check, lint, test, build, typecheck, format, or package-manager commands here.

If no manual verification is required, write:

```md
## Manual User Verification

No manual user verification is required.
```

## Approaches Decided Against

Summarize rejected approaches in a few concise bullets.

Use plain rejected-approach bullets. Do not write labels such as `Option A:`, `Approach 1:`, or `Alternative 1:` because final plans must not present live solution branches.

Good:

```md
- Injecting on every plan-mode prompt was rejected because it would repeatedly add the same contract and create noise.
- SessionStart-only injection was rejected because session lifecycle is not plan-mode lifecycle.
```

Bad:

```md
- Option A: Inject on every prompt.
- Alternative 1: Use SessionStart only.
```

## Possible Future Followups

List possible later work only after the current plan is complete.

Required work must not be deferred to this section unless the user explicitly requested or accepted that deferral.

Every followup must make clear that it is not required for the current task.

Good:

```md
- Non-native adapters write named session planfiles under the agent-framework session `plans/` directory.
```

Bad:

```md
- Add tests later.
```

## Relevant Files

List all files relevant to understanding the plan, including source-of-truth files that may not be edited.

Each item must include one sentence explaining why the file is relevant.

Use a numbered list.

## Files That Need Changes

List every file that must be created or modified.

Each item must include one sentence explaining what changes in that file.

Use a numbered list.

## Specificity Requirements

The main implementation body must be detailed enough that there is no room for interpretation or sudden surprises.

For every non-trivial change, include:

1. File path.
2. Approximate line number, nearby anchor, or function name.
3. Exact symbol, section, or behavior being changed.
4. Concrete code shape, quoted code, or pseudocode.
5. Expected before/after behavior.
6. Any constraints that must not be violated.

Use quoted code snippets when:

- Adding a new exported function, type, interface, or constant.
- Changing a function call site.
- Adding a required markdown section or exact instruction text.
- Adding a new hook output shape.
- Adding a new test fixture or test case where exact values matter.
- Adding comments, because comments must be prewritten exactly.

Do not quote entire files unless necessary. Quote enough code that the implementer cannot reasonably choose a different behavior.

## Forbidden Plan Content

Do not include:

- Time estimates.
- Timeline buckets.
- Live solution branches.
- Open assumptions.
- Invented behavioral numbers, counts, thresholds, or timeouts.
- Vague implementation verbs without concrete detail.
- Generic verification headings.
- Manual project check/lint/test/build/format commands.
- Instructions to document user-facing behavior in `CLAUDE.md`.

## Required Style

Plans should be direct, specific, and implementation-ready.

Prefer numbered lists and fenced code blocks.

Do not use markdown tables.

Do not end by asking whether to proceed.
