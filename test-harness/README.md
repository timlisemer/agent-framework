# Test Harness -- Transcript Replay

Full session replay through the real hook system. Reads a JSONL transcript, fires all hooks sequentially, and compares decisions against labeled expectations. Hooks make real LLM API calls -- each replay costs real money.

## Why It Exists

Hooks evolve over time. This harness replays real past sessions to catch regressions -- if a hook that previously made the right call now makes the wrong one, the test fails. Labels are ground truth derived from actual user reactions in the transcript.

## Usage

Two Claude Code subagents automate the workflow via MCP tools:

- **`@labeler`** (`mcp__agent-framework__test_harness_labeler`) -- finds unlabeled transcripts, generates initial labels, reviews with hindsight, finalizes label files.
- **`@tester`** (`mcp__agent-framework__test_harness_tester`) -- finds labeled transcripts, runs the harness, analyzes failures, fixes hook code, re-runs until passing.

Each MCP tool has a `help` action with complete documentation for its role.
