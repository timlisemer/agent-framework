---
description: Commit staged changes and push to remote (user)
allowed-tools: mcp__agent-framework__commit, mcp__agent-framework__push, AskUserQuestion
---

1. Ask the user for preferences using AskUserQuestion with these two questions:
   - Question 1: "Which model tier for code review?" with header "Tier" and options:
     - "opus" with description "Most thorough analysis (default)"
     - "sonnet" with description "Balanced speed and quality"
     - "haiku" with description "Fastest, for small changes"
   - Question 2: "Any specific areas to focus on?" with header "Focus" and options:
     - "None" with description "Standard review"
     - "Security" with description "Extra focus on security concerns"
     - "Performance" with description "Extra focus on performance"
   Set multiSelect to false for both questions.

2. Call mcp__agent-framework__commit with:
   - model_tier: The selected tier from question 1 (just the lowercase word: "opus", "sonnet", or "haiku")
   - extra_context: If user selected something other than "None" for question 2, pass that as extra context. If they provided custom text via "Other", use that text.

3. Check the commit result:
   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains "DECLINED" - report the reason and DO NOT push
   - If it contains an error or failure - report the error and DO NOT push
   - Otherwise - report the commit message and proceed

4. Call mcp__agent-framework__push

5. Report the push result to the user
