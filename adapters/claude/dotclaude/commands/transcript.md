---
disable-model-invocation: true
description: Print the absolute path to the current Claude Code session's transcript file (user)
allowed-tools: mcp__agent-framework__transcript
---

1. IMMEDIATELY call mcp__agent-framework__transcript with no parameters.
   - Do NOT run any Bash commands
   - Do NOT read files or gather context first
   - Do NOT use any other tools

2. Print the path string from the tool's response, verbatim.
