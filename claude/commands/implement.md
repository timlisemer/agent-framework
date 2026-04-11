---
description: Implement the current plan, then validate the implementation matches the plan
---

You are executing the /implement skill. The user's arguments are:

$ARGUMENTS

Follow these steps exactly.

## Step 1: Locate the plan file

Find the active plan file. Check in this order:
1. If $ARGUMENTS contains a file path, use that
2. Look for a plan file path mentioned in recent conversation context
3. Look for the most recent plan file in ~/.claude/plans/
4. If no plan file is found, tell the user and stop

Read the plan file to confirm it exists and has content.

## Step 2: Launch the Implementer agent

Launch exactly 1 Agent tool call with `subagent_type: "implementer"` and the following prompt:

Implement the following plan. Read the plan file first, then make all changes exactly as specified.

Plan file: {the plan file path}

Implement every change in the plan. Do not skip anything. Do not add anything not in the plan. Run mcp__agent-framework__check when done.

Wait for the implementer to complete. Report its summary to the user.

## Step 3: Launch the Implementation Validator agent

After the implementer completes, launch exactly 1 Agent tool call with `subagent_type: "implement-validator"` and the following prompt:

Validate that the following plan was implemented correctly. Read the plan file, then verify every change against the actual codebase.

Plan file: {the plan file path}

Check every change in the plan. Report PASS or FAIL for each item. Additional uncommitted code not in the plan is NOT a failure.

Wait for the validator to complete.

## Step 4: Report results

Summarize both results:
- What the implementer did (files changed, check status)
- Whether the validator found the implementation correct (PASS/FAIL)
- Any issues the validator flagged
