/**
 * MCP-Exposed Agents
 *
 * These agents are exposed via the MCP server (src/mcp/server.ts).
 * Most use direct Anthropic API calls; workflow agents may orchestrate SDK
 * subprocess agents when the workflow needs code investigation or edits.
 *
 * ## WHY DIRECT API?
 *
 * MCP agents were refactored from SDK streaming to direct API because:
 * - Commands are deterministic (linter, make/just check, filename-reference diagnostics, supplemental diagnostics, git commands)
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
 *   │         │         └─ Runs linter + make/just check + deterministic filename-reference diagnostics + supplemental diagnostics (sonnet)
 *   │         └─ Analyzes git diff (opus)
 *   └─ Generates commit message + executes commit (haiku)
 *
 * implement → internal write SDK agent → check → read-only implementation validator
 */

export { runCheckAgent } from "./check.js";
export { runValidatePlanAgent } from "./validate-plan.js";
export { runCreatePlanfileAgent } from "./create-planfile.js";
export { runImplementAgent, runValidateImplementationAgent } from "./implement.js";
export { runConfirmAgent, runFullConfirmAgent } from "./confirm.js";
export { runCommitAgent } from "./commit.js";
export { runPushAgent } from "./push.js";
export { runLocateScenarioMcp } from "./locate-scenario.js";
export { handleScenarioLabeler } from "./scenario-labeler.js";
export { handleScenarioTester } from "./scenario-tester.js";
