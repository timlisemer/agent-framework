---
disable-model-invocation: true
description: Run linter, type checks, deterministic filename-reference diagnostics, repository-wide style-drift warnings, and supplemental editor diagnostics; return summarized results (user)
allowed-tools: mcp__agent-framework__check
---

1. IMMEDIATELY call mcp__agent-framework__check.

   - Pass `working_dir` with the current repository working directory.
   - The check includes deterministic deleted/renamed filename-reference errors, docs/config missing-file reference warnings, and repository-wide style-drift warnings.

   - Do NOT run any Bash commands (make check, just check, npm run build, cargo check, tsc, etc.)
   - Do NOT read files or gather context first
   - Do NOT use any other tools

2. Check the result:

   - If Status is PASS: report that all checks passed
   - If Status is FAIL: report the error count and list the specific errors

3. Report the results to the user
