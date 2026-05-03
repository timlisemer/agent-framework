---
name: agent-framework-plan5
description: Spawn five Codex planning agents, including one xhigh-reasoning alternative thinker, then five validation agents and present a final proposed plan. Use when the user invokes the agent-framework plan5 workflow or asks for the old /plan5 command equivalent.
---

# Agent Framework Plan5

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly five `default` planning agents in one parallel batch.
2. Use `gpt-5.5` with `reasoning_effort: "medium"` for the first four agents unless the user explicitly requests a different model. Give them the same prompt: inspect relevant files, report the plan directly, avoid code edits, avoid backwards-compatibility shims, and fix root causes rather than symptoms.
3. Use `gpt-5.5` with `reasoning_effort: "xhigh"` for the fifth agent. Give it the same prompt plus: challenge assumptions, consider unconventional approaches, and surface edge cases others may miss.
4. Wait for all five planning agents.
5. Consolidate agreement, flag meaningful divergence, incorporate useful alternative insights, and choose the best concrete implementation. Do not write a plan file unless the user explicitly requested one.
6. Spawn exactly five `default` validation agents in one parallel batch. Use `gpt-5.5` medium reasoning for the first four validators and `gpt-5.5` xhigh reasoning for the fifth alternative-approach validator.
7. Tell the first four validators to inspect the code and validate the consolidated plan for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
8. Tell the fifth validator to understand the plan, then propose a completely different approach if it would be better, with honest tradeoffs.
9. Wait for all validators. Apply valid corrections, and replace or adjust the plan if the alternative approach is genuinely better.
10. Present the final plan in a single `<proposed_plan>` block. Include summary, key changes, tests, and assumptions.

