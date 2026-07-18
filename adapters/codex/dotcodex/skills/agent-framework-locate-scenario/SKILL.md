---
name: agent-framework-locate-scenario
description: Locate a captured scenario from quote substrings using the agent-framework locate_scenario MCP. Use when the user invokes $agent-framework-locate-scenario.
---

# Agent Framework Locate Scenario

1. Immediately call `mcp__agent_framework__locate_scenario` with the quote or quotes the user provided.

   - Use `quotes` as an array, even for a single quote.
   - Do not run Bash search commands.
   - Do not read transcript or session files first.
   - Do not use any other tools.

2. The MCP owns the scenario-location recipe:

   - It searches canonical Agent Framework run journals under `~/.agent-framework/runs/`.
   - It returns stable `run_id`, `runtime_root`, record cursor, event, and entity context.

3. Report the MCP result to the user:

   - If it failed, tell the user the MCP did not find a match and follow the manual fallback guidance it returned.
   - If it succeeded, notify the user that the scenario was located.
   - Report the returned next-step instructions exactly; this skill only calls the locate_scenario MCP.
