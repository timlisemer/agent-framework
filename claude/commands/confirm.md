---
description: Analyze uncommitted changes and confirm code quality (user)
allowed-tools: mcp__agent-framework__confirm, AskUserQuestion
---

1. Ask the user for preferences using AskUserQuestion with these two questions (do NOT output any text before this):
   - Question 1: "Which model tier for code review? (for [REPO_NAME])" with header "Tier" and options:
     - "opus" with description "Most thorough analysis (default)"
     - "sonnet" with description "Balanced speed and quality"
     - "haiku" with description "Fastest, for small changes"
   - Question 2: "Any specific areas to focus on? (for [REPO_NAME])" with header "Focus" and options:
     - "None" with description "Standard review"
     - "Security" with description "Extra focus on security concerns"
     - "Performance" with description "Extra focus on performance"
   Set multiSelect to false for both questions. Replace [REPO_NAME] with the current working directory's name (e.g., "agent-framework").

2. Call mcp__agent-framework__confirm with:
   - model_tier: The selected tier from question 1 (just the lowercase word: "opus", "sonnet", or "haiku")
   - extra_context: If user selected something other than "None" for question 2, pass that as extra context. If they provided custom text via "Other", use that text.

3. Report the results to the user:
   - If it contains "CONFIRMED" - report the summary and confirmation
   - If it contains "DECLINED" - report the summary and reason for decline
