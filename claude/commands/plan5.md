---
description: Spawn 5 plan agents (4 identical + 1 outside-the-box), consolidate, then 5 validation agents to refine
---

You are executing the /plan5 skill. The user's task description is:

$ARGUMENTS

Follow these steps exactly. Do NOT skip any step.

## Step 1: Launch 5 Plan agents in parallel

You MUST call the Agent tool exactly 5 times in your SINGLE NEXT RESPONSE. All 5 Agent tool calls go in ONE message -- do NOT send one agent, wait for it, then send the next. You must emit all 5 tool_use blocks together so they run concurrently. If you only launch 1 agent, you have failed this step.

Correct pattern (all 5 in one response):
- Agent call 1: subagent_type "Plan", description "Plan agent 1 of 4", prompt = (see below)
- Agent call 2: subagent_type "Plan", description "Plan agent 2 of 4", prompt = (same)
- Agent call 3: subagent_type "Plan", description "Plan agent 3 of 4", prompt = (same)
- Agent call 4: subagent_type "Plan", description "Plan agent 4 of 4", prompt = (same)
- Agent call 5: subagent_type "Plan", description "Plan agent 5 outside-the-box", prompt = (same + special instruction)

The first 4 agents get the IDENTICAL prompt:

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

Write the consolidated plan to the plan file. Include:
- A **Context** section explaining the problem
- Concrete changes with file paths, line numbers, and code
- An **Assistant Verification** section (run `mcp__agent-framework__check`)
- A **Manual User Verification** section if applicable

## Step 3: Launch 5 Validation agents in parallel

Same rule as Step 1: you MUST call the Agent tool exactly 5 times in your SINGLE NEXT RESPONSE. All 5 in ONE message, running concurrently. Each agent gets the IDENTICAL prompt:

```
Do NOT write a plan file. Report your validation findings directly to me.

You are validating an implementation plan. Read all relevant source files to verify the plan's assumptions against the actual codebase.

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
```

## Step 4: Consolidate Round 2

After all 5 validation agents return:
- Fix every issue that multiple validators flagged
- Evaluate single-validator issues on merit
- Update the plan file with corrections

## Step 5: Exit plan mode

Call ExitPlanMode to present the final plan for user approval.
