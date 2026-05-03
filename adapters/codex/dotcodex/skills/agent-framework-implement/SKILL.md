---
name: agent-framework-implement
description: Implement an approved plan with a Codex implementer agent, then validate the result with an implementation validator agent. Use when the user invokes the agent-framework implement workflow or asks for the old /implement command equivalent.
---

# Agent Framework Implement

Use the user's invoking prompt to identify the plan. If it contains a path, use that path. Otherwise use the most recent plan path explicitly mentioned in the conversation. If no plan path is available, tell the user and stop.

1. Spawn exactly one `implementer` agent with this prompt:

```text
Implement the following plan. Read the plan file first, then make all changes exactly as specified.

Plan file: {plan file path}

Implement every change in the plan. Do not skip anything. Do not add anything not in the plan. Run mcp__agent-framework__check when done.
```

2. Wait for the implementer to complete and capture its summary.
3. Spawn exactly one `implement-validator` agent with this prompt:

```text
Validate that the following plan was implemented correctly. Read the plan file, then verify every change against the actual codebase.

Plan file: {plan file path}

Check every change in the plan. Report PASS or FAIL for each item. Additional uncommitted code not in the plan is NOT a failure.
```

4. Wait for the validator to complete.
5. Report what the implementer changed, check status, whether validation passed, and any issues found.

