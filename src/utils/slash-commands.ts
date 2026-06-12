/**
 * Slash commands that GATE specific MCP tools — those tools cannot run
 * without an explicit slash-command invocation. Single source of truth
 * for RESTRICTED_MCPS. Consumed (transitively) by:
 *  - isLowRiskTool (src/rules/utils.ts) — excludes from low-risk auto-approve
 *  - tool-approve  (src/rules/tool-approve.ts) — hard-deny without auth
 *
 * All keys and values are CANONICAL names. Adapter wire spellings live
 * only inside adapters/. Generic code never sees wire names.
 */

import type { CanonicalMcp, CanonicalWorkflow } from "../adapter/types.js";

/**
 * MCP tools gated by slash-command authorization.
 * Keys: canonical workflow name. Values: canonical MCP names required.
 */
export const SLASH_COMMAND_GATED_MCPS: Record<string, readonly CanonicalMcp[]> = {
  commit:    ["commit"],
  push:      ["push", "commit"],
  quickpush: ["push", "commit"],
  confirm:   ["confirm"],
  quickconfirm: ["confirm"],
  fullconfirm: ["fullconfirm"],
  fullquickconfirm: ["fullconfirm"],
};

/**
 * Per-command workflow tool sets. The tools each slash-command workflow
 * legitimately uses — including non-MCP tools (Agent, ExitPlanMode).
 *
 * Values are canonical tool names: "mcp-<canonical>" for MCP tools,
 * PascalCase for built-in tools.
 */
export const SLASH_COMMAND_WORKFLOW_TOOLS: Record<string, readonly string[]> = {
  check:     ["mcp-check"],
  transcript: ["mcp-transcript"],
  "locate-scenario": ["mcp-locate_scenario"],
  plan1:     ["Agent", "ExitPlanMode", "mcp-create_planfile", "mcp-validate_plan"],
  plan3:     ["Agent", "ExitPlanMode", "mcp-create_planfile", "mcp-validate_plan"],
  plan5:     ["Agent", "ExitPlanMode", "mcp-create_planfile", "mcp-validate_plan"],
  implement: ["Agent"],
};

/**
 * Combined view: every canonical tool name a slash command authorizes.
 * MCP tools use "mcp-<canonical>" form. Other tools use PascalCase.
 */
export type SlashCommandWorkflow = CanonicalWorkflow;

const WRITE_REPAIR_TOOLS = ["Edit", "MultiEdit", "Write"] as const;

export const SLASH_COMMAND_ALLOWED_TOOLS: Record<string, readonly string[]> = {
  ...SLASH_COMMAND_WORKFLOW_TOOLS,
  commit: ["mcp-commit"],
  push: ["mcp-push", "mcp-commit"],
  quickpush: ["mcp-push", "mcp-commit"],
  confirm: ["mcp-confirm"],
  quickconfirm: ["mcp-confirm", ...WRITE_REPAIR_TOOLS],
  fullconfirm: ["mcp-fullconfirm"],
  fullquickconfirm: ["mcp-fullconfirm", ...WRITE_REPAIR_TOOLS],
};

/**
 * Canonical MCP names that require slash-command authorization.
 * Wire-name translation happens in adapters/.
 */
export const RESTRICTED_MCPS: ReadonlySet<CanonicalMcp> = new Set(["commit", "push", "confirm", "fullconfirm"]);
