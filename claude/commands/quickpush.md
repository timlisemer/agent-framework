---
disable-model-invocation: true
description: Quick commit and push - no questions asked (user)
allowed-tools: mcp__agent-framework__commit, mcp__agent-framework__push, mcp__agent-framework__list_repos
---

1. First, call mcp**agent-framework**list_repos to detect all repositories and submodules with uncommitted changes.

2. Parse the result to identify which repos have changes:

   - If NO repos have changes: inform the user and stop
   - Otherwise: proceed with ALL repos that have changes (no user selection)

3. Build an ORDERED list of repositories to process:

   - Submodules MUST be processed FIRST (so the main repo can include updated submodule pointers)
   - The main repo comes LAST, after all submodules are committed
   - You MUST process repositories in this exact order - submodules first, then main repo

4. For each repository in the ordered list (submodules first, then main repo), perform steps 5-7:

5. Call mcp**agent-framework**commit with:

   - working_dir: The absolute path to the repository
   - model_tier: "haiku"
   - (no extra_context)

6. Check the commit result:

   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains "DECLINED" - report the reason and DO NOT push this repository
   - If it contains an error or failure - report the error and DO NOT push this repository
   - Otherwise - report the commit message and proceed

7. Call mcp**agent-framework**push with:

   - working_dir: The absolute path to the repository

8. Report the push result to the user for each repository
