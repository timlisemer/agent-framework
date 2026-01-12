---
description: Analyze uncommitted changes and confirm code quality (user)
allowed-tools: mcp__agent-framework__confirm, mcp__agent-framework__list_repos, AskUserQuestion
---

1. First, call mcp__agent-framework__list_repos to detect all repositories and submodules with uncommitted changes.

2. Parse the result to identify which repos have changes:
   - If ONLY the main repo has changes: proceed with just the main repo
   - If ONLY submodule(s) have changes: proceed with just those submodules
   - If BOTH main repo AND submodule(s) have changes: ask the user which repos to confirm using AskUserQuestion with multiSelect=true
   - If NO repos have changes: inform the user and stop

3. Build an ORDERED list of repositories to process:
   - Submodules MUST be processed FIRST (so the main repo can include updated submodule pointers)
   - The main repo comes LAST, after all submodules are confirmed
   - You MUST process repositories in this exact order - submodules first, then main repo

4. For each repository in the ordered list (submodules first, then main repo), perform steps 5-7:

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

6. Call mcp__agent-framework__confirm with:
   - working_dir: The absolute path to the repository
   - model_tier: The selected tier from step 5 (just the lowercase word: "opus", "sonnet", or "haiku")
   - extra_context: If user selected something other than "None" for question 2, pass that as extra context. If they provided custom text via "Other", use that text.

7. Report the results to the user:
   - If it contains "CONFIRMED" - report the summary and confirmation
   - If it contains "DECLINED" - report the summary and reason for decline
