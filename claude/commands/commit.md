---
description: Generate and execute a git commit using the agent framework
allowed-tools: mcp__agent-framework__commit, AskUserQuestion
---

1. Check if you have worked in multiple different git repositories during this conversation. If you have worked in 2 or more repositories, ask the user using AskUserQuestion:
   - Question: "Which repositories do you want to commit?" with header "Repos" and options listing each repository path you worked in
   - Set multiSelect to true so the user can select multiple repos
   - If the user only selects one, proceed with that repo. If multiple, you will run the commit process for each selected repo sequentially.

2. For each selected repository (or the current working directory if only one repo was worked in), perform steps 3-5. Do NOT output any text like "Repository 1:" before asking questions - the question text itself already contains the repo name:

3. Ask the user for preferences using AskUserQuestion with these two questions (do NOT output any text before this):
   - Question 1: "Which model tier for code review? (for [REPO_NAME])" with header "Tier" and options:
     - "opus" with description "Most thorough analysis (default)"
     - "sonnet" with description "Balanced speed and quality"
     - "haiku" with description "Fastest, for small changes"
   - Question 2: "Any specific areas to focus on? (for [REPO_NAME])" with header "Focus" and options:
     - "None" with description "Standard review"
     - "Security" with description "Extra focus on security concerns"
     - "Performance" with description "Extra focus on performance"
   Set multiSelect to false for both questions. Replace [REPO_NAME] with the repository directory name (e.g., "agent-framework").

4. Call mcp__agent-framework__commit with:
   - working_dir: The path to the repository
   - model_tier: The selected tier from step 3 (just the lowercase word: "opus", "sonnet", or "haiku")
   - extra_context: Build the context as follows:
     - If multiple repositories are being committed, prepend: "Note: This is part of a multi-repository commit. The user is committing changes to [N] repositories: [list the repo paths]. You are currently evaluating: [current repo path]."
     - Then append the user's focus preference if they selected something other than "None" in step 3 (or their custom text via "Other").

5. Report the result to the user for each repository:
   - If it starts with "SKIPPED:" - report that nothing was committed
   - If it contains "DECLINED" - report the reason for decline
   - If it contains an error - report the error
   - Otherwise - report the commit message and hash
