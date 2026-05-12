---
name: agent-framework-plan3
description: Spawn three Codex planning agents in parallel, consolidate, then spawn three validation agents and present a final proposed plan. Use when the user invokes $agent-framework-plan3.
---

# Agent Framework Plan3

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

Use the agent-framework `PLANS.md` contract injected into this session. Do not require or read a target-repo `PLANS.md`; target repos are not expected to provide one. The final `<proposed_plan>` must follow the injected `PLANS.md` exactly.

1. Spawn exactly three `default` planning agents in one parallel batch. Use `gpt-5.5` with `reasoning_effort: "medium"` unless the user explicitly requests a different model. Give all three the same self-contained prompt: inspect relevant files, follow the injected `PLANS.md` contract, report the plan directly, avoid code edits, avoid backwards-compatibility shims, fix root causes rather than symptoms, and include enough concrete file paths, anchors, and quoted snippets that implementation has no room for interpretation.
2. Wait for all three planning agents.
3. Consolidate agreement, flag meaningful divergence, and choose the best concrete implementation. Summarize meaningful rejected planner divergence under `Approaches Decided Against` using plain bullets, not labels like `Option A:` or `Alternative 1:`. Do not write a plan file unless the user explicitly requested one.
4. Spawn exactly three `default` validation agents in one parallel batch with the same model and reasoning effort. Tell each to inspect the code and validate the consolidated plan against both the source files and the injected `PLANS.md` contract for incorrect assumptions, missing changes, edge cases, regressions, insufficient implementation detail, and contract violations.
5. Wait for all three validators. Fix issues reported by multiple validators and apply single-validator issues when correct on the merits.
6. Present the final plan in a single `<proposed_plan>` block following the injected `PLANS.md` contract exactly.
