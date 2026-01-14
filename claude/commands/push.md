---
disable-model-invocation: true
description: Commit staged changes and push to remote (user)
allowed-tools: mcp__agent-framework__commit, mcp__agent-framework__push, mcp__agent-framework__list_repos, AskUserQuestion
---

1. First, call mcp**agent-framework**list_repos to detect all repositories and submodules with uncommitted changes.

2. Parse the result to identify which repos have changes:

   - If ONLY the main repo has changes: proceed with just the main repo
   - If ONLY submodule(s) have changes: proceed with just those submodules
   - If BOTH main repo AND submodule(s) have changes: ask the user which repos to commit and push using AskUserQuestion with multiSelect=true, listing each repo by name
   - If NO repos have changes: inform the user and stop

3. Build an ORDERED list of repositories to process:

   - Submodules MUST be processed FIRST (so the main repo can include updated submodule pointers)
   - The main repo comes LAST, after all submodules are committed
   - You MUST process repositories in this exact order - submodules first, then main repo

4. For each repository in the ordered list (submodules first, then main repo), perform steps 5-9. Do NOT output any text like "Repository 1:" before asking questions - the question text itself already contains the repo name:

5. Ask the user for preferences using AskUserQuestion with these two questions (do NOT output any text before this):

   - Question 1: "Which model tier for code review? (for [REPO_NAME])" with header "Tier" and options:
     - "opus" with description "Most thorough analysis (default)"
     - "sonnet" with description "Balanced speed and quality"
     - "haiku" with description "Fastest, for small changes"
   - Question 2: "Any specific areas to focus on? (for [REPO_NAME])" with header "Focus" and options:
     - "None" with description "Standard review"
     - "Security" with description "Extra focus on security concerns"
     - "Performance" with description "Extra focus on performance"
       Set multiSelect to false for both questions. Replace [REPO_NAME] with the repository directory name.

6. Call mcp**agent-framework**commit with:

   - working_dir: The absolute path to the repository
   - model_tier: The selected tier from step 5 (just the lowercase word: "opus", "sonnet", or "haiku")
   - extra_context: Build the context as follows:
     - If multiple repositories are being committed and pushed, prepend: "Note: This is part of a multi-repository commit and push. The user is committing changes to [N] repositories: [list the repo names]. You are currently evaluating: [current repo name]."
     - Then append the user's focus preference if they selected something other than "None" in step 5 (or their custom text via "Other").

7. Check the commit result:

   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains "DECLINED" - report the reason and DO NOT push this repository
   - If it contains an error or failure - report the error and DO NOT push this repository
   - Otherwise - report the commit message and proceed

8. Call mcp**agent-framework**push with:

   - working_dir: The absolute path to the repository

9. Report the push result to the user for each repository
