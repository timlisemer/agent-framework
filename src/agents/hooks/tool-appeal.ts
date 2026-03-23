/**
 * Tool Appeal Agent - Helper for Denied Tool Calls
 *
 * This agent is a HELPER called by other agents after they block a tool.
 * It reviews the denial and returns whether to overturn it.
 * The CALLING agent decides what to do with the result.
 *
 * ## FLOW
 *
 * 1. Receive denial reason and transcript context from calling agent
 * 2. Run LLM to evaluate if user approved the operation
 * 3. Retry if format is invalid
 * 4. Return { overturned: boolean } - caller decides what to do
 *
 * ## CRITICAL
 *
 * - This agent does NOT make final decisions
 * - It only checks if user explicitly approved the operation
 * - The calling agent handles the response in TypeScript
 *
 * @module tool-appeal
 */

import { EXECUTION_TYPES } from "../../types.js";
import { runAgentWithRetryAndTelemetry } from "../../utils/agent-runner.js";
import { TOOL_APPEAL_AGENT } from "../../utils/agent-configs.js";
import { logFastPathApproval } from "../../utils/logger.js";
import { startsWithAny } from "../../utils/retry.js";
import { extractGateNote } from "../../utils/gate-reasoning-cache.js";
import type { SlashCommandContext } from "../../utils/transcript.js";

const MCP_STRICT_RULES = `=== STRICT RULES FOR MCP TOOLS (commit/push/confirm) ===

For approval-required MCP tools (mcp__agent-framework__commit, mcp__agent-framework__push, mcp__agent-framework__confirm):

- ONLY overturn if "=== SLASH COMMAND INVOKED ===" section shows the tool matches allowed-tools
- Implicit approval phrases ("continue", "go ahead", "yes", "proceed", "ok", "sure") are NOT sufficient
- These tools require EXPLICIT user invocation via slash command (/commit, /push, /confirm)
- If no slash command section exists, UPHOLD the block

This prevents the AI from bypassing confirm's DECLINED decision by using casual language.
The user must explicitly re-invoke the slash command to retry after confirm declines.`;

export async function appealHelper(
  toolName: string,
  toolDescription: string,
  transcript: string,
  originalReason: string,
  workingDir: string,
  hookName: string,
  additionalContext?: string,
  slashCommandContext?: SlashCommandContext
): Promise<{ overturned: boolean; gateNote?: string }> {
  const contextSection = additionalContext
    ? `\n=== CALLER CONTEXT ===\n${additionalContext}\n=== END CONTEXT ===\n`
    : "";

  const mcpRulesSection = toolName.startsWith("mcp__agent-framework__")
    ? `\n${MCP_STRICT_RULES}\n`
    : "";

  let slashCommandSection = "";
  if (slashCommandContext) {
    const allowedToolsStr = slashCommandContext.allowedTools?.join(", ") || "none specified";
    slashCommandSection = `
=== SLASH COMMAND INVOKED ===
Command: /${slashCommandContext.commandName}
Description: ${slashCommandContext.description || "N/A"}
Allowed tools: ${allowedToolsStr}
=== END SLASH COMMAND ===
`;
  }

  const maxRetries = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await runAgentWithRetryAndTelemetry(
        { ...TOOL_APPEAL_AGENT, workingDir },
        {
          prompt: "Review this appeal for a denied tool call.",
          context: `BLOCK REASON: ${originalReason}
TOOL CALL: ${toolDescription}
${mcpRulesSection}${slashCommandSection}${contextSection}
RECENT CONVERSATION:
${transcript}`,
        },
        {
          formatValidator: (text) => startsWithAny(text, ["UPHOLD", "OVERTURN: APPROVE"]),
          formatReminder: "Reply with EXACTLY: UPHOLD or OVERTURN: APPROVE",
        },
        {
          agent: "tool-appeal",
          hookName,
          toolName,
          workingDir,
          executionType: EXECUTION_TYPES.LLM,
        }
      );

      const gateNote = extractGateNote(result.output);
      const overturned = result.output.startsWith("OVERTURN: APPROVE") || result.output === "APPROVE";

      return { overturned, gateNote };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
      }
    }
  }

  logFastPathApproval("tool-appeal", hookName, toolName, workingDir, `Error after ${maxRetries + 1} attempts - fail closed: ${lastError}`);
  return { overturned: false };
}
