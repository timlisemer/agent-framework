---
name: agent-framework-plan5
description: Spawn five Codex planning agents, including one xhigh-reasoning alternative thinker, then five verification agents and write a named planfile. Use when the user invokes $agent-framework-plan5.
---

# Agent Framework Plan5

Use the user's invoking prompt as the task description. Follow these steps exactly. Do not skip any step.

## Critical: Subagents Do Not Share Your Context

Subagents start with zero knowledge of this conversation. They cannot see:
- Prior messages between you and the user.
- Files you have already read.
- Analysis, theories, hypotheses, or decisions reached in this session.
- Anything the user refers to by reference, such as "your theory", "the bug we discussed", "that file", or "the issue from earlier".

If the user's task description is something like "validate your theory" or "fix the issue we found", you are the parent agent that knows what the theory or issue is; the subagent does not. You must expand that reference into a self-contained briefing before spawning agents: state the theory explicitly, describe the issue in full, include relevant file paths and snippets, list symptoms and hypotheses, and name the functions or modules involved. If you forward a vague phrase, the subagents will invent their own interpretations and the run is wasted.

## Step 1: Launch 5 Planning Agents In Parallel

Spawn exactly five `default` planning agents in one parallel batch.

Use `gpt-5.5` with `reasoning_effort: "medium"` for the first four agents unless the user explicitly requests a different model. Give them the identical self-contained prompt below:

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

Use `gpt-5.5` with `reasoning_effort: "xhigh"` for the fifth outside-the-box agent. Give it the same prompt with this addition at the top:

```text
SPECIAL INSTRUCTION: Think outside the box. Challenge assumptions, consider unconventional approaches, find edge cases others might miss, and propose creative solutions that go beyond the obvious implementation.
```

## Step 2: Consolidate Round 1

Wait for all five planning agents to finish. Analyze their responses:
- Identify where all agents agree.
- Note meaningful divergence.
- Incorporate creative insights from the outside-the-box agent where they improve the plan.
- Choose the best concrete implementation from the consensus.

Consolidate the planner output into final plan content using exactly these 14 required level-two headings in order:
`User Goal`, `Answered Assumptions`, `Goal In My Words`, `Approach`, `Data Flow`, `Files To Create`, `Files To Modify`, `Implementation Order`, `Assistant Verification`, `Manual User Verification`, `Approaches Decided Against`, `Possible Future Followups`, `Relevant Files`, `Files That Need Changes`.

Do not add non-contract `##` headings such as `## Context`, `## Verification`, `## Testing`, or `## Test Plan`. Include concrete changes with file paths, line numbers or anchors, and code details inside the required sections. `Assistant Verification` must call `mcp__agent_framework__check` with the repository `working_dir` after each larger code change as the repository-level replacement for direct shell check and test commands, including targeted shell test runs; put only user-only checks in `Manual User Verification`, or state that none are required.

Call `mcp__agent_framework__create_planfile` with `plan_name` set to a lowercase kebab-case name and `content` set to the consolidated plan content. The tool writes the correct planfile, validates it, and returns the planfile path plus PASS. Only proceed to verification agents after it returns PASS.

## Step 3: Launch 5 Verification Agents In Parallel

Spawn exactly five `default` verification agents in one parallel batch. Use `gpt-5.5` with `reasoning_effort: "medium"` for the first four verifiers and `gpt-5.5` with `reasoning_effort: "xhigh"` for the fifth alternative-approach verifier unless the user explicitly requests a different model.

Give the first four verifiers this identical prompt:

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

Give the fifth alternative-approach verifier this prompt:

```text
Do not write a planfile. Do not call validate_plan. Report your findings directly to me.

You are the alternative-approach verifier. Read all relevant source files and the current validated planfile carefully. Fully understand the plan and everything it does: what it changes, why, and the behavior it produces.

Then set the existing plan aside and propose a completely different approach if it would achieve the same goal better. Challenge the plan's core assumptions, architecture, and strategy. Do not incrementally critique the plan; design an alternative from scratch.

The original task: {paste the fully expanded user task here}

The current validated planfile is at: {paste the planfile path here}

Your report must include:
1. A brief summary proving you understood what the current plan does and why.
2. Your completely different alternative approach, with concrete file paths, line numbers or anchors, and code details.
3. A clear explanation of why your alternative is better, if it is better.
4. Honest trade-offs: what does your alternative give up compared to the current plan?

Every proposed change must address the root cause. Never propose treating symptoms: do not silence warnings, suppress errors, weaken assertions, or change test expectations instead of fixing the code under test.
Do not propose backwards-compatibility shims, deprecated re-exports, or legacy fallbacks. If something is replaced, remove the old code entirely.
```

## Step 4: Consolidate Round 2

Wait for all five verification agents. Fix every issue that multiple verifiers flagged. Evaluate single-verifier issues on merit and apply them when correct. Seriously weigh the fifth verifier's alternative approach against the current plan. If the alternative is genuinely better, replace the plan with it; if parts of it are better, incorporate those parts; otherwise keep the current plan and briefly note why under `Approaches Decided Against`.

If corrections were made, edit the existing planfile directly and call `mcp__agent_framework__validate_plan` for that planfile until it returns PASS.

## Step 5: Report Result

Report the final planfile path.
