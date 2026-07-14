/**
 * Slash commands that GATE specific MCP tools - those tools cannot run
 * without an explicit slash-command invocation. Single source of truth
 * for RESTRICTED_MCPS. Consumed (transitively) by:
 *  - isLowRiskTool (src/rules/utils.ts) - excludes from low-risk prediction treatment
 *  - tool-approve  (src/rules/tool-approve.ts) - hard-deny without auth
 *
 * All keys and values are CANONICAL names. Adapter wire spellings live
 * only inside adapters/. Generic code never sees wire names.
 */

import type { CanonicalMcp, CanonicalWorkflow } from "../adapter/types.js";
import { WRITE_REPAIR_TOOL_NAMES } from "./edit-tools.js";

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
  implement: ["implement"],
  validate: ["validate_implementation"],
};

export const SLASH_COMMAND_WORKFLOWS = Object.keys(SLASH_COMMAND_GATED_MCPS) as CanonicalWorkflow[];

/**
 * Per-command workflow tool sets. The non-strict tools each slash-command
 * workflow may use outside the ordered prediction queue.
 *
 * Values are canonical tool names: "mcp-<canonical>" for MCP tools,
 * PascalCase for built-in tools.
 */
export const SLASH_COMMAND_WORKFLOW_TOOLS: Record<string, readonly string[]> = {
  check:     ["mcp-check"],
  transcript: ["mcp-transcript"],
  "locate-scenario": ["mcp-locate_scenario"],
  plan1:     ["CloseAgent", "ExitPlanMode", "mcp-create_planfile", "mcp-validate_plan"],
  plan3:     ["CloseAgent", "ExitPlanMode", "mcp-create_planfile", "mcp-validate_plan"],
  plan5:     ["CloseAgent", "ExitPlanMode", "mcp-create_planfile", "mcp-validate_plan"],
};

const SLASH_COMMAND_GATED_MCP_TOOLS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(SLASH_COMMAND_GATED_MCPS).map(([workflow, mcps]) => [
    workflow,
    mcps.map((mcp) => `mcp-${mcp}`),
  ]),
);

/**
 * Combined view: every canonical tool name a slash command authorizes.
 * MCP tools use "mcp-<canonical>" form. Other tools use PascalCase.
 */
export type SlashCommandWorkflow = CanonicalWorkflow;

export const SLASH_COMMAND_ALLOWED_TOOLS: Record<string, readonly string[]> = {
  ...SLASH_COMMAND_WORKFLOW_TOOLS,
  ...SLASH_COMMAND_GATED_MCP_TOOLS,
  quickconfirm: [...SLASH_COMMAND_GATED_MCP_TOOLS.quickconfirm, ...WRITE_REPAIR_TOOL_NAMES],
  fullquickconfirm: [...SLASH_COMMAND_GATED_MCP_TOOLS.fullquickconfirm, ...WRITE_REPAIR_TOOL_NAMES],
};

/**
 * Canonical MCP names that require slash-command authorization.
 * Wire-name translation happens in adapters/.
 */
export const RESTRICTED_MCPS: ReadonlySet<CanonicalMcp> = new Set(
  Object.values(SLASH_COMMAND_GATED_MCPS).flat(),
);
