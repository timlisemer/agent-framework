---
description: Commit staged changes and push to remote (user)
allowed-tools: mcp__agent-framework__commit, mcp__agent-framework__push, AskUserQuestion
---

1. Check if you have worked in multiple different git repositories during this conversation. If you have worked in 2 or more repositories, ask the user using AskUserQuestion:
   - Question: "Which repositories do you want to commit and push?" with header "Repos" and options listing each repository path you worked in
   - Set multiSelect to true so the user can select multiple repos
   - If the user only selects one, proceed with that repo. If multiple, you will run the commit and push process for each selected repo sequentially.

2. Ask the user for preferences using AskUserQuestion with these two questions:
   - Question 1: "Which model tier for code review?" with header "Tier" and options:
     - "opus" with description "Most thorough analysis (default)"
     - "sonnet" with description "Balanced speed and quality"
     - "haiku" with description "Fastest, for small changes"
   - Question 2: "Any specific areas to focus on?" with header "Focus" and options:
     - "None" with description "Standard review"
     - "Security" with description "Extra focus on security concerns"
     - "Performance" with description "Extra focus on performance"
   Set multiSelect to false for both questions.

3. For each selected repository (or the current working directory if only one repo was worked in), perform steps 4-6:

4. Call mcp__agent-framework__commit with:
   - working_dir: The path to the repository
   - model_tier: The selected tier from question 1 (just the lowercase word: "opus", "sonnet", or "haiku")
   - extra_context: Build the context as follows:
     - If multiple repositories are being committed and pushed, prepend: "Note: This is part of a multi-repository commit and push. The user is committing changes to [N] repositories: [list the repo paths]. You are currently evaluating: [current repo path]."
     - Then append the user's focus preference if they selected something other than "None" for question 2 (or their custom text via "Other").

5. Check the commit result:
   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains "DECLINED" - report the reason and DO NOT push this repository
   - If it contains an error or failure - report the error and DO NOT push this repository
   - Otherwise - report the commit message and proceed

6. Call mcp__agent-framework__push with:
   - working_dir: The path to the repository

7. Report the push result to the user for each repository
