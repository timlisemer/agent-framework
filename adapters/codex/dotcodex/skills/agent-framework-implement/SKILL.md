---
name: agent-framework-implement
description: Implement an approved plan with a Codex implementer agent, then validate the result with an implementation validator agent. Use when the user invokes $agent-framework-implement.
---

# Agent Framework Implement

Use the user's invoking prompt to identify the plan file. Resolve it in this order:

1. If the invoking prompt contains a file path, use that path.
2. Otherwise use the file-backed `current-plan.json` sidecar for this session.
3. Otherwise use the most recent plan file path explicitly mentioned in the conversation.
4. If no plan file is available, tell the user and stop.

1. Spawn exactly one `implementer` agent with this prompt:

```text
Implement the following plan. Read the plan file first, then make all changes exactly as specified.

Plan file: {plan file path}

Implement every change in the plan. Do not skip anything. Do not add anything not in the plan. Run mcp__agent_framework__check with working_dir set to the current repository path when done.
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
