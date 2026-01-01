/**
 * MCP-Exposed Agents
 *
 * These agents are exposed via the MCP server (src/mcp/server.ts).
 * They use direct Anthropic API calls (not SDK streaming) because:
 *
 * ## WHY DIRECT API?
 *
 * MCP agents were refactored from SDK streaming to direct API because:
 * - Commands are deterministic (linter, make check, git commands)
 * - No agent decision-making needed for tool selection
 * - Single API call is cheaper than multi-turn SDK conversations
 * - Prevents "overthinking" or unwanted tool calls
 * - Faster execution without agent loop overhead
 *
 * Shell commands are executed directly via execSync, then results
 * are summarized/analyzed with a single API call.
 *
 * ## AGENT CHAIN
 *
 * commit → confirm → check
 *   │         │         │
 *   │         │         └─ Runs linter + make check (sonnet)
 *   │         └─ Analyzes git diff (opus)
 *   └─ Generates commit message + executes commit (haiku)
 */

export { runCheckAgent } from './check.js';
export { runConfirmAgent } from './confirm.js';
export { runCommitAgent } from './commit.js';
export { runPushAgent } from './push.js';
export { runValidateIntentAgent } from './validate-intent.js';
