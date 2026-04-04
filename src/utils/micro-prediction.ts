/**
 * Micro-Prediction - Synchronous regex predictions from user messages.
 *
 * Called synchronously in UserPromptSubmit before any tool call arrives.
 * Produces fast (<3ms) TypeScript-only predictions without LLM calls.
 *
 * @module micro-prediction
 */

import type { ToolPrediction, BlockedTool, AllowedTool } from "./prediction-cache.js";
import { stripQuotedAndPastedContent } from "./quote-detection.js";

/**
 * Generate synchronous micro-predictions from a user message using regex heuristics.
 * Returns a ToolPrediction with source "micro" containing blockedTools and allowedTools.
 */
export function generateMicroPredictions(
  userMessage: string,
  editIntent: boolean | null,
  planMode: boolean,
): ToolPrediction {
  const blockedTools: BlockedTool[] = [];
  const allowedTools: AllowedTool[] = [];
  let expectedIntent = "";
  let blockedIntent = "";
  const strippedMessage = stripQuotedAndPastedContent(userMessage);

  // Plan mode -> block Edit/Write/NotebookEdit
  if (planMode) {
    expectedIntent = "planning and exploration tools";
    blockedIntent = "no file modification or execution tools";
    blockedTools.push({
      toolName: "Edit|Write|NotebookEdit",
      reason: "plan mode active - no file modifications",
    });
  } else if (editIntent === false) {
    // editIntent=false -> block Edit/Write/NotebookEdit
    expectedIntent = "read-only exploration tools";
    blockedIntent = "no write/edit tools";
    blockedTools.push({
      toolName: "Edit|Write|NotebookEdit",
      reason: "edit intent is false - read-only exploration",
    });
  } else if (editIntent === true) {
    expectedIntent = "file editing tools for implementation";
  }

  // "don't run/execute" -> block Bash
  if (/\b(don'?t|do not)\s+(run|execute)\b/i.test(strippedMessage)) {
    blockedTools.push({ toolName: "Bash", reason: "user said no execution" });
    blockedIntent += (blockedIntent ? "; " : "") + "no execution";
  }

  // "don't push/deploy" -> block git push
  if (/\b(don'?t|do not)\s+(push|deploy)\b/i.test(strippedMessage)) {
    blockedTools.push({ toolName: "Bash", targetPattern: "git push*", reason: "user said no pushing" });
    blockedIntent += (blockedIntent ? "; " : "") + "no pushing/deploying";
  }

  // "use X agents only" pattern
  const agentOnlyMatch = strippedMessage.match(/\buse\s+(\w+)\s+agents?\b/i);
  if (agentOnlyMatch) {
    const agentType = agentOnlyMatch[1];
    expectedIntent = `${agentType} agent delegation only`;
    blockedIntent = `everything except Agent tool with ${agentType} subagent`;
    blockedTools.push({
      toolName: ".*",
      reason: `user requested ${agentType} agents only`,
      exceptions: ["Agent"],
    });
  }

  // "explain/review/understand/explore" -> block Edit/Write (read-only intent)
  if (/\b(explain|review|understand|explore)\b/i.test(strippedMessage) && editIntent !== true) {
    const alreadyBlocksEdits = blockedTools.some((b) => /Edit|Write/.test(b.toolName));
    if (!alreadyBlocksEdits) {
      blockedTools.push({
        toolName: "Edit|Write|NotebookEdit",
        reason: "read-only intent detected (explain/review/understand/explore)",
      });
      blockedIntent += (blockedIntent ? "; " : "") + "read-only intent";
    }
  }

  // "fix/implement/add" + file path -> allowedTools for that file scope
  const actionFileMatch = strippedMessage.match(/\b(fix|implement|add)\b.*?([\w./\\-]+\.\w{1,6})/i);
  if (actionFileMatch) {
    const filePath = actionFileMatch[2];
    allowedTools.push({
      toolName: "Edit|Write",
      targetPattern: `*${filePath}`,
      reason: `user requested action on ${filePath}`,
    });
  }

  return {
    expectedIntent,
    blockedIntent,
    blockedTools,
    allowedTools,
    source: "micro",
    userMessageSnippet: userMessage.slice(0, 200),
    timestamp: Date.now(),
    active: true,
  };
}
