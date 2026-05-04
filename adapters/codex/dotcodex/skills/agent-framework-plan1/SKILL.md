---
name: agent-framework-plan1
description: Spawn one Codex planning agent, consolidate its plan, then spawn one validation agent and present a final proposed plan. Use when the user invokes $agent-framework-plan1.
---

# Agent Framework Plan1

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly one `default` agent to create an implementation plan. Use `gpt-5.5` with `reasoning_effort: "medium"` unless the user explicitly requests a different model. Tell it to inspect relevant files, report the plan directly, avoid code edits, avoid backwards-compatibility shims, and fix root causes rather than symptoms.
2. Wait for the planning agent to finish.
3. Consolidate its result into a draft plan in your own context. Do not write a plan file unless the user explicitly requested one.
4. Spawn exactly one `default` validation agent with the same model and reasoning effort. Tell it to inspect the current code and validate the draft plan for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
5. Wait for the validation agent to finish and apply valid corrections.
6. Present the final plan in a single `<proposed_plan>` block. Include summary, key changes, tests, and assumptions.
