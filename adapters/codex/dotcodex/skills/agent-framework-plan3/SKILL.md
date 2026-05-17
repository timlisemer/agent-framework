---
name: agent-framework-plan3
description: Spawn three Codex planning agents in parallel, consolidate, then spawn three verification agents and write a named planfile. Use when the user invokes $agent-framework-plan3.
---

# Agent Framework Plan3

Use the user's invoking prompt as the task description. Follow these steps exactly. Do not skip any step.

## Critical: Subagents Do Not Share Your Context

Subagents start with zero knowledge of this conversation. They cannot see:
- Prior messages between you and the user.
- Files you have already read.
- Analysis, theories, hypotheses, or decisions reached in this session.
- Anything the user refers to by reference, such as "your theory", "the bug we discussed", "that file", or "the issue from earlier".

If the user's task description is something like "validate your theory" or "fix the issue we found", you are the parent agent that knows what the theory or issue is; the subagent does not. You must expand that reference into a self-contained briefing before spawning agents: state the theory explicitly, describe the issue in full, include relevant file paths and snippets, list symptoms and hypotheses, and name the functions or modules involved. If you forward a vague phrase, the subagents will invent their own interpretations and the run is wasted.

## Step 1: Launch 3 Planning Agents In Parallel

Spawn exactly three `default` planning agents in one parallel batch. Use `gpt-5.5` with `reasoning_effort: "medium"` unless the user explicitly requests a different model. Give all three the identical self-contained prompt below:

```text
Draft the plan directly in your response. Do not write a planfile. Do not call validate_plan; the consolidated named planfile will be validated after it is written by the parent agent.

Read all relevant files in the codebase first, then design a detailed implementation plan.

The task: {paste the fully expanded user task here}

For each change you propose:
1. State what you are changing, including file path, line numbers or anchors, and function/module name.
2. Show the concrete code change or describe it precisely.
3. Explain why this change achieves the desired behavior without breaking existing logic.

Do not add anything that does not directly implement the requested behavior.
Every proposed fix must address the root cause. Never propose treating symptoms: do not silence warnings, suppress errors, weaken assertions, or change test expectations to make failures disappear. If a test fails, fix the code under test, not the test.
Do not plan for backwards compatibility. If something is replaced, remove the old code entirely; no deprecated re-exports, shims, or legacy fallbacks.
```

## Step 2: Consolidate Round 1

Wait for all three planning agents to finish. Analyze their responses:
- Identify where all agents agree.
- Note meaningful divergence.
- Choose the best concrete implementation from the consensus.
- Summarize meaningful rejected planner divergence under `Approaches Decided Against` using plain bullets, not labels like `Option A:` or `Alternative 1:`.

Consolidate the planner output into final plan content using exactly these 14 required level-two headings in order:
`User Goal`, `Answered Assumptions`, `Goal In My Words`, `Approach`, `Data Flow`, `Files To Create`, `Files To Modify`, `Implementation Order`, `Assistant Verification`, `Manual User Verification`, `Approaches Decided Against`, `Possible Future Followups`, `Relevant Files`, `Files That Need Changes`.

Do not add non-contract `##` headings such as `## Context`, `## Verification`, `## Testing`, or `## Test Plan`. Include concrete changes with file paths, line numbers or anchors, and code details inside the required sections. `Assistant Verification` must use only `mcp__agent_framework__check` with the repository `working_dir`; put only user-only checks in `Manual User Verification`, or state that none are required.

Call `mcp__agent_framework__create_planfile` with `plan_name` set to a lowercase kebab-case name and `content` set to the consolidated plan content. The tool writes the correct planfile, validates it, and returns the planfile path plus PASS or FAIL. If it returns FAIL, follow the tool feedback. Only proceed to verification agents after it returns PASS.

## Step 3: Launch 3 Verification Agents In Parallel

Spawn exactly three `default` verification agents in one parallel batch with the same model and reasoning effort. Give all three the identical prompt below:

```text
Do not write a planfile. Do not call validate_plan. Report your verification findings directly to me.

You are verifying an implementation plan for technical correctness against the source code. Read all relevant source files to verify the plan's assumptions against the actual codebase. Ask yourself whether the plan is correct and ready to implement.

The original task: {paste the fully expanded user task here}

The current validated planfile is at: {paste the planfile path here}

Check:
1. Does the plan's assumptions about file locations, types, and patterns match the actual code?
2. Are there missing changes the plan should include?
3. Are there edge cases or gotchas the plan misses?
4. Is there anything in the plan that would break existing functionality?
5. Is the plan specific enough to implement, including file paths, anchors, and concrete code details?

Report all issues you find with specific file paths and line numbers or anchors.
Flag any proposed change that treats symptoms instead of root causes.
Flag any proposed change that adds backwards-compatibility shims, deprecated re-exports, or legacy fallbacks instead of cleanly replacing old code.
```

## Step 4: Consolidate Round 2

Wait for all three verification agents. Fix every issue that multiple verifiers flagged. Evaluate single-verifier issues on merit and apply them when correct. If corrections were made, call `mcp__agent_framework__create_planfile` again with the same `plan_name` and the corrected plan content; follow the tool feedback until it returns PASS.

## Step 5: Report Result

Report the final planfile path.
