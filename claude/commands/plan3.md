---
description: Spawn 3 plan agents, consolidate, then 3 validation agents to refine
---

You are executing the /plan3 skill. The user's task description is:

$ARGUMENTS

Follow these steps exactly. Do NOT skip any step.

## CRITICAL: Subagents do NOT share your context

Subagents start with ZERO knowledge of this conversation. They cannot see:
- Prior messages between you and the user
- Files you have already read
- Analysis, theories, hypotheses, or decisions reached in this session
- Anything the user refers to by reference ("your theory", "the bug we discussed", "that file", "the issue from earlier")

If the user's task description is something like "validate your theory" or "fix the issue we found", YOU are the parent agent that knows what the theory or issue is -- the subagent does not. You MUST spell out the full context inside the subagent prompt: state the theory explicitly, describe the issue in full, paste the relevant code snippets and file paths, list the symptoms and the hypothesis, name the functions involved. Anywhere the prompt template below says `{paste $ARGUMENTS here}`, expand it into a self-contained briefing that a cold reader could act on. If you just forward a vague phrase, the subagent will invent its own interpretation and the run is wasted.

## Step 1: Launch 3 Plan agents in parallel

You MUST call the Agent tool exactly 3 times in your SINGLE NEXT RESPONSE. All 3 Agent tool calls go in ONE message -- do NOT send one agent, wait for it, then send the next. You must emit all 3 tool_use blocks together so they run concurrently. If you only launch 1 agent, you have failed this step.

Correct pattern (all 3 in one response):
- Agent call 1: subagent_type "Plan", description "Plan agent 1 of 3", prompt = (see below)
- Agent call 2: subagent_type "Plan", description "Plan agent 2 of 3", prompt = (same)
- Agent call 3: subagent_type "Plan", description "Plan agent 3 of 3", prompt = (same)

All 3 agents get the IDENTICAL prompt:

```
Do NOT write a plan file. Report your plan directly to me.

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

## Step 2: Consolidate Round 1

After all 3 agents return, analyze their responses:
- Identify where all agents AGREE (high confidence consensus)
- Note where agents DIVERGE (flag for the user)
- Pick the best concrete implementation from the consensus

Write the consolidated plan to the plan file. Include:
- A **Context** section explaining the problem
- Concrete changes with file paths, line numbers, and code
- An **Assistant Verification** section (run `mcp__agent-framework__check`)
- A **Manual User Verification** section if applicable

## Step 3: Launch 3 Validation agents in parallel

Same rule as Step 1: you MUST call the Agent tool exactly 3 times in your SINGLE NEXT RESPONSE. All 3 in ONE message, running concurrently. Each agent gets the IDENTICAL prompt:

```
Do NOT write a plan file. Report your validation findings directly to me.

You are validating an implementation plan. Read all relevant source files to verify the plan's assumptions against the actual codebase. Ask yourself whether the plan is even correct and truly ready to implement.

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

## Step 4: Consolidate Round 2

After all 3 validation agents return:
- Fix every issue that multiple validators flagged
- Evaluate single-validator issues on merit
- Update the plan file with corrections

## Step 5: Exit plan mode

Call ExitPlanMode to present the final plan for user approval.
