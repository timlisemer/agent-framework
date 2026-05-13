---
name: agent-framework-plan5
description: Spawn five Codex planning agents, including one xhigh-reasoning alternative thinker, then five verification agents and present a final proposed plan. Use when the user invokes $agent-framework-plan5.
---

# Agent Framework Plan5

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly five `default` planning agents in one parallel batch.
2. Use `gpt-5.5` with `reasoning_effort: "medium"` for the first four agents unless the user explicitly requests a different model. Give them the same prompt: inspect relevant files, avoid code edits, avoid backwards-compatibility shims, fix root causes rather than symptoms, and include enough concrete file paths, anchors, and quoted snippets that implementation has no room for interpretation. Tell each to call `mcp__agent_framework__validate_plan` with its full inline plan before reporting the plan directly; if the tool returns FAIL, revise the plan and call it again until it returns PASS, then report the validated plan directly.
3. Use `gpt-5.5` with `reasoning_effort: "xhigh"` for the fifth agent. Give it the same prompt plus: challenge assumptions, consider unconventional approaches, and surface edge cases others may miss.
4. Wait for all five planning agents.
5. Consolidate agreement, flag meaningful divergence, incorporate useful alternative insights, and choose the best concrete implementation. Do not write a plan file unless the user explicitly requested one. Call `mcp__agent_framework__validate_plan` with the full inline consolidated plan; if it returns FAIL, revise the consolidated plan and call it again until it returns PASS.
6. Spawn exactly five `default` verification agents in one parallel batch. Use `gpt-5.5` medium reasoning for the first four verifiers and `gpt-5.5` xhigh reasoning for the fifth alternative-approach verifier.
7. Tell the first four verifiers to inspect the code and verify the consolidated plan against the source files for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
8. Tell the fifth verifier to inspect the code, understand the plan, then propose a completely different approach if it would be better, with honest tradeoffs. If its materially different proposal is rejected, summarize that rejection under `Approaches Decided Against` using a plain bullet.
9. Wait for all verifiers. Apply valid corrections, and replace or adjust the plan if the alternative approach is genuinely better.
10. Present the final plan in a single `<proposed_plan>` block.
