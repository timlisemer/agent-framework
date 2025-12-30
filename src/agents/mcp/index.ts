/**
 * MCP-Exposed Agents
 *
 * These agents are exposed via the MCP server (src/mcp/server.ts).
 * They use the Claude Agent SDK with streaming for shell access.
 *
 * ## WHY SDK STREAMING?
 *
 * MCP agents need:
 * - Shell access via Bash tool - the Agent SDK provides tool orchestration
 * - Streaming output - captures incremental results from long-running commands
 * - Multi-turn execution - agent can run multiple commands in sequence
 *
 * The Agent SDK wrapper in `utils/agent-query.ts` handles all this complexity.
 *
 * ## AGENT CHAIN
 *
 * commit → confirm → check
 *   │         │         │
 *   │         │         └─ Runs linter + make check (sonnet)
 *   │         └─ Analyzes git diff (opus)
 *   └─ Generates commit message + executes commit (sonnet)
 */

export { runCheckAgent } from './check.js';
export { runConfirmAgent } from './confirm.js';
export { runCommitAgent } from './commit.js';
export { runPushAgent } from './push.js';
