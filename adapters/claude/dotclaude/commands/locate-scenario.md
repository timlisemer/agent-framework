---
disable-model-invocation: true
description: Locate a captured scenario from quote substrings using the locate_scenario MCP
allowed-tools: mcp__agent-framework__locate_scenario
---

1. IMMEDIATELY call mcp__agent-framework__locate_scenario with the quote or quotes the user provided.

   - Use `quotes` as an array, even for a single quote.
   - Do NOT run Bash search commands.
   - Do NOT read transcript or session files first.
   - Do NOT use any other tools.

2. The MCP owns the scenario-location recipe:

   - It searches raw Claude transcripts under `~/.claude/projects/`.
   - It searches raw Codex transcripts under `~/.codex/sessions/`.
   - It searches agent-framework `tool-log.jsonl`, `captures.jsonl`, and `session-injections.jsonl`.
   - It resolves transcript hits through `transcript-path.txt` sidecars.
   - It cross-references tool and injection hits against `captures.jsonl` where possible.

3. Report the MCP result to the user:

   - If it failed, tell the user the MCP did not find a match and follow the manual fallback guidance it returned.
   - If it succeeded, notify the user that the scenario was located.
   - Report the returned next-step instructions exactly; this command only allows the locate_scenario MCP.
