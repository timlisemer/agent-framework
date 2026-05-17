---
description: Spawn 5 plan agents (4 identical + 1 outside-the-box), consolidate, then 5 verification agents to refine
allowed-tools: Agent, ExitPlanMode, mcp__agent-framework__create_planfile, mcp__agent-framework__validate_plan
---

You are executing the /plan5 skill. The user's task description is:

$ARGUMENTS

Follow these steps exactly. Do NOT skip any step.

## CRITICAL: Subagents do NOT share your context

Subagents start with ZERO knowledge of this conversation. They cannot see:
- Prior messages between you and the user
- Files you have already read
- Analysis, theories, hypotheses, or decisions reached in this session
- Anything the user refers to by reference ("your theory", "the bug we discussed", "that file", "the issue from earlier")

If the user's task description is something like "validate your theory" or "fix the issue we found", YOU are the parent agent that knows what the theory or issue is -- the subagent does not. You MUST spell out the full context inside the subagent prompt: state the theory explicitly, describe the issue in full, paste the relevant code snippets and file paths, list the symptoms and the hypothesis, name the functions involved. Anywhere the prompt template below says `{paste $ARGUMENTS here}`, expand it into a self-contained briefing that a cold reader could act on. If you just forward a vague phrase, the subagent will invent its own interpretation and the run is wasted.

## Step 1: Launch 5 Plan agents in parallel

You MUST call the Agent tool exactly 5 times in your SINGLE NEXT RESPONSE. All 5 Agent tool calls go in ONE message -- do NOT send one agent, wait for it, then send the next. You must emit all 5 tool_use blocks together so they run concurrently. If you only launch 1 agent, you have failed this step.

Correct pattern (all 5 in one response):
- Agent call 1: subagent_type "Plan", description "Plan agent 1 of 4", model "sonnet", prompt = (see below)
- Agent call 2: subagent_type "Plan", description "Plan agent 2 of 4", model "sonnet", prompt = (same)
- Agent call 3: subagent_type "Plan", description "Plan agent 3 of 4", model "sonnet", prompt = (same)
- Agent call 4: subagent_type "Plan", description "Plan agent 4 of 4", model "sonnet", prompt = (same)
- Agent call 5: subagent_type "Plan", description "Plan agent 5 outside-the-box", model "opus", prompt = (same + special instruction)

Use model "sonnet" for the first 4 agents and model "opus" for the 5th outside-the-box agent, unless the user explicitly requested a different tier.

The first 4 agents get the IDENTICAL prompt:

```
Draft the plan directly in your response. Do not call validate_plan; the consolidated named planfile will be validated after it is written.

Read all relevant files in the codebase first, then design a detailed implementation plan.

The task: {paste $ARGUMENTS here}

For each change you propose:
1. State what you are changing (file path, line numbers, function name)
2. Show the concrete code change or describe it precisely
3. Explain why this change achieves the desired behavior without breaking existing logic

Do not add anything that doesn't directly implement the requested behavior.
Every proposed fix must address the root cause. NEVER propose treating symptoms: do not silence warnings, suppress errors, weaken assertions, or change test expectations to make failures disappear. If a test fails, fix the code under test -- not the test.
Do not plan for backwards compatibility. If something is replaced, remove the old code entirely -- no deprecated re-exports, shims, or legacy fallbacks.
```

The 5th agent gets the same prompt with this addition at the top:

```
SPECIAL INSTRUCTION: Think outside the box. Challenge assumptions, consider unconventional approaches, find edge cases others might miss, and propose creative solutions that go beyond the obvious implementation.
```

## Step 2: Consolidate Round 1

After all 5 agents return, analyze their responses:
- Identify where all agents AGREE (high confidence consensus)
- Note where agents DIVERGE (flag for the user)
- Incorporate creative insights from the outside-the-box agent where they improve the plan
- Pick the best concrete implementation from the consensus

Consolidate the planner output into final plan content using exactly these 14 required level-two headings in order:
`User Goal`, `Answered Assumptions`, `Goal In My Words`, `Approach`, `Data Flow`, `Files To Create`, `Files To Modify`, `Implementation Order`, `Assistant Verification`, `Manual User Verification`, `Approaches Decided Against`, `Possible Future Followups`, `Relevant Files`, `Files That Need Changes`.

Do not add non-contract `##` headings such as `## Context`, `## Verification`, `## Testing`, or `## Test Plan`. Include concrete changes with file paths, line numbers, and code inside the required sections. `Assistant Verification` must use only `mcp__agent-framework__check` with the repository `working_dir`; put only user-only checks in `Manual User Verification`, or state that none are required.

Call `mcp__agent-framework__create_planfile` with `plan_name` set to a lowercase kebab-case name and `content` set to the consolidated plan content. The tool writes the correct planfile, validates it, and returns the planfile path plus PASS or FAIL. If it returns FAIL, follow the tool feedback. Only proceed to verification agents after it returns PASS.

## Step 3: Launch 5 Verification agents in parallel

Same rule as Step 1: you MUST call the Agent tool exactly 5 times in your SINGLE NEXT RESPONSE. All 5 in ONE message, running concurrently.

Correct pattern (all 5 in one response):
- Agent call 1: subagent_type "Plan", description "Plan verification agent 1 of 4", model "sonnet", prompt = (see below)
- Agent call 2: subagent_type "Plan", description "Plan verification agent 2 of 4", model "sonnet", prompt = (same)
- Agent call 3: subagent_type "Plan", description "Plan verification agent 3 of 4", model "sonnet", prompt = (same)
- Agent call 4: subagent_type "Plan", description "Plan verification agent 4 of 4", model "sonnet", prompt = (same)
- Agent call 5: subagent_type "Plan", description "Plan verification agent 5 alternative-approach", model "opus", prompt = (see alternative prompt below)

Use model "sonnet" for the first 4 verification agents and model "opus" for the 5th alternative-approach agent, unless the user explicitly requested a different tier.

The first 4 verification agents get the IDENTICAL prompt:

```
Do NOT write a plan file. Report your verification findings directly to me.

You are verifying an implementation plan for technical correctness against the source code. Read all relevant source files to verify the plan's assumptions against the actual codebase. Ask yourself whether the plan is even correct and truly ready to implement.

The original task: {paste $ARGUMENTS here}

The current plan is at: {paste the plan file path here}

Check:
1. Does the plan's assumptions about file locations, types, and patterns match the actual code?
2. Are there missing changes the plan should include?
3. Are there edge cases or gotchas the plan misses?
4. Is there anything in the plan that would break existing functionality?
5. Is the plan specific enough to implement (file paths, line numbers, concrete code)?

Report ALL issues you find with specific file paths and line numbers.
Flag any proposed change that treats symptoms instead of root causes (e.g. silencing warnings, weakening assertions, changing test expectations instead of fixing the code under test).
Flag any proposed change that adds backwards-compatibility shims, deprecated re-exports, or legacy fallbacks instead of cleanly replacing old code.
```

The 5th verification agent gets this ALTERNATIVE prompt instead:

```
Do NOT write a plan file. Report your findings directly to me.

You are the alternative-approach verifier. Read all relevant source files and the current plan carefully. Fully understand the plan and everything it does -- what it changes, why, and the behavior it produces.

Then set the existing plan aside and propose a COMPLETELY DIFFERENT approach that achieves the same goal better. Challenge the plan's core assumptions, architecture, and strategy. Do not incrementally critique the plan -- design an alternative from scratch.

The original task: {paste $ARGUMENTS here}

The current plan is at: {paste the plan file path here}

Your report must include:
1. A brief summary proving you understood what the current plan does and why
2. Your completely different alternative approach, with concrete file paths, line numbers, and code
3. A clear explanation of why your alternative is better (simpler, more correct, more robust, smaller blast radius, fewer moving parts, better root-cause fix, etc.)
4. Honest trade-offs: what does your alternative give up compared to the current plan?

Every proposed change must address the root cause. NEVER propose treating symptoms: do not silence warnings, suppress errors, weaken assertions, or change test expectations to make failures disappear.
Do not propose backwards-compatibility shims, deprecated re-exports, or legacy fallbacks. If something is replaced, remove the old code entirely.
```

## Step 4: Consolidate Round 2

After all 5 verification agents return:
- Fix every issue that multiple verifiers flagged
- Evaluate single-verifier issues on merit
- Seriously weigh the 5th verifier's alternative approach against the current plan. If the alternative is genuinely better, replace the plan with it; if parts of it are better, incorporate those parts; otherwise keep the current plan and briefly note why.
- Update the plan file with corrections

## Step 5: Exit plan mode

Call ExitPlanMode to present the final plan for user approval.
