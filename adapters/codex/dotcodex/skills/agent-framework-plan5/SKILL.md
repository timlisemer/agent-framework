---
name: agent-framework-plan5
description: Spawn five Codex planning agents, including one xhigh-reasoning alternative thinker, then five verification agents and write a named planfile. Use when the user invokes $agent-framework-plan5.
---

# Agent Framework Plan5

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly five `default` planning agents in one parallel batch.
2. Use `gpt-5.5` with `reasoning_effort: "medium"` for the first four agents unless the user explicitly requests a different model. Give them the same prompt: inspect relevant files, avoid code edits, avoid backwards-compatibility shims, fix root causes rather than symptoms, and include enough concrete file paths, anchors, and quoted snippets that implementation has no room for interpretation.
3. Use `gpt-5.5` with `reasoning_effort: "xhigh"` for the fifth agent. Give it the same prompt plus: challenge assumptions, consider unconventional approaches, and surface edge cases others may miss.
4. Wait for all five planning agents.
5. Consolidate agreement, flag meaningful divergence, incorporate useful alternative insights, and choose the best concrete implementation.
6. Write the consolidated plan to a named planfile using lowercase kebab-case. The plan must begin with `Plan Name: <name>` and end with `Planfile Path: <path>` followed by `Plan Name: <same-name>`.
7. Call `mcp__agent_framework__validate_plan` with `plan_file` set to that path. If it returns FAIL, revise the planfile and call it again until it returns PASS.
8. Spawn exactly five `default` verification agents in one parallel batch. Use `gpt-5.5` medium reasoning for the first four verifiers and `gpt-5.5` xhigh reasoning for the fifth alternative-approach verifier.
9. Tell the first four verifiers to inspect the code and verify the validated planfile against the source files for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
10. Tell the fifth verifier to inspect the code, understand the plan, then propose a completely different approach if it would be better, with honest tradeoffs. If its materially different proposal is rejected, summarize that rejection under `Approaches Decided Against` using a plain bullet.
11. Wait for all verifiers. Apply valid corrections, and replace or adjust the plan if the alternative approach is genuinely better. Re-run `mcp__agent_framework__validate_plan` with `plan_file` if corrections were made.
12. Report the final planfile path.
