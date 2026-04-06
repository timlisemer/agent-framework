# Test Harness

Replay real Claude Code transcript segments through real hooks with real LLM calls.

## Quick Start

```bash
# List testable tool_use entries in a transcript
npx tsx test-harness/run.ts --list <transcript.jsonl>

# Test a pre-tool-use hook decision
npx tsx test-harness/run.ts \
  --hook pre-tool-use \
  --transcript <path.jsonl> \
  --line <N> \
  --expect allow \
  --label "Grep is low-risk"

# Test a stop-response-check hook decision
npx tsx test-harness/run.ts \
  --hook stop-response-check \
  --transcript <path.jsonl> \
  --line <N> \
  --expect pass

# Test with expected agent name (deterministic paths)
npx tsx test-harness/run.ts \
  --hook pre-tool-use \
  --transcript <path.jsonl> \
  --line <N> \
  --expect deny \
  --expect-agent plan-mode-block
```

## Exit Codes

- `0` — pass (decision matched expectation)
- `1` — fail (decision did not match)
- `2` — error (hook crashed, timeout, bad args)

## Results

Test results append to `test-harness/results/log.jsonl` (gitignored).
