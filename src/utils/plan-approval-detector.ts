import * as fs from "fs";
import type { ToolPrediction } from "./prediction-types.js";

/**
 * Plan-approval detection.
 *
 * Plan approval (the user clicking "approve" in plan mode after an
 * ExitPlanMode tool_use) arrives in the transcript as a synthetic user-role
 * tool_result whose content begins with the literal marker
 * "User has approved your plan." — NOT as a fresh user-typed turn. As a
 * result, the UserPromptSubmit hook never fires for it, so SENTIMENT_AGENT
 * never re-runs and `currentPrediction.intent` stays anchored to the
 * pre-approval task. Downstream consumers (gate, prediction-block,
 * prediction-question-judge) then judge post-approval tool calls against
 * that stale anchor.
 *
 * This helper detects the unprocessed approval at PreToolUse entry so the
 * caller can synthesize a fresh prediction representing post-approval
 * intent ("implement the approved plan").
 *
 * @module plan-approval-detector
 */

export const PLAN_APPROVAL_MARKER = "User has approved your plan.";

export interface PlanApprovalEvent {
  toolUseId: string;
  approvalContent: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
  name?: string;
  id?: string;
}

interface TranscriptEntry {
  isMeta?: boolean;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
  };
}

/**
 * Coerce a tool_result block's `content` to a string. Tool_result content
 * shapes seen in transcripts:
 *   - plain string: "User has approved your plan. ..."
 *   - array: [{ type: "text", text: "User has approved your plan. ..." }]
 */
function coerceToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as ContentBlock;
        if (b.type === "text" && typeof b.text === "string") {
          return b.text;
        }
      }
    }
  }
  return "";
}

/**
 * Walk the transcript backward. Return an unprocessed plan-approval event iff:
 *   (a) we find a user-role tool_result block whose `content` (string-coerced)
 *       starts with PLAN_APPROVAL_MARKER AND whose `tool_use_id` resolves to a
 *       prior assistant `ExitPlanMode` tool_use, AND
 *   (b) we did NOT encounter any non-meta user TEXT entry between that
 *       approval and the end of file (a real user turn after the approval
 *       means UserPromptSubmit already fired and refreshed currentPrediction —
 *       nothing to do).
 *
 * Both halves of (a) must match — the literal marker AND the ExitPlanMode
 * tool name — to rule out false positives (assistant text quoting the string,
 * a tool_result for a different tool whose content begins with it, etc.).
 */
export async function findUnprocessedPlanApproval(
  transcriptPath: string,
): Promise<PlanApprovalEvent | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  const parsed: (TranscriptEntry | null)[] = lines.map((line) => {
    if (!line) return null;
    try {
      return JSON.parse(line) as TranscriptEntry;
    } catch {
      return null;
    }
  });

  // First pass forward: build tool_use_id → tool_name map from assistant
  // tool_use blocks.
  const toolUseIdToName = new Map<string, string>();
  for (const entry of parsed) {
    if (!entry || !entry.message) continue;
    if (entry.message.role !== "assistant") continue;
    const blocks = entry.message.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as ContentBlock;
      if (b.type === "tool_use" && b.id && b.name) {
        toolUseIdToName.set(b.id, b.name);
      }
    }
  }

  // Second pass backward: look for the most recent plan-approval tool_result.
  // Terminate scan and return null if we encounter a real user TEXT turn
  // (string content OR array containing a {type:"text"} block, non-meta).
  for (let i = parsed.length - 1; i >= 0; i--) {
    const entry = parsed[i];
    if (!entry || !entry.message) continue;
    if (entry.message.role !== "user") continue;

    const content = entry.message.content;
    const isMeta = entry.isMeta === true;

    // Real user-text turn detection (non-meta, non-empty text).
    if (!isMeta) {
      if (typeof content === "string" && content.length > 0) {
        return null;
      }
      if (Array.isArray(content)) {
        const hasText = content.some((b) => {
          if (!b || typeof b !== "object") return false;
          const bb = b as ContentBlock;
          return bb.type === "text" && typeof bb.text === "string" && bb.text.length > 0;
        });
        if (hasText) return null;
      }
    }

    // Approval detection: search this entry's content for a tool_result with
    // the literal marker AND tool_use_id mapping to "ExitPlanMode".
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as ContentBlock;
        if (b.type !== "tool_result") continue;
        const toolUseId = b.tool_use_id;
        if (!toolUseId) continue;
        const toolName = toolUseIdToName.get(toolUseId);
        if (toolName !== "ExitPlanMode") continue;
        const approvalContent = coerceToolResultContent(b.content);
        if (!approvalContent.startsWith(PLAN_APPROVAL_MARKER)) continue;
        return { toolUseId, approvalContent };
      }
    }
  }

  return null;
}

/**
 * Pure: build a fresh ToolPrediction representing post-plan-approval intent.
 * Mood/trust default to neutral/normal — no signal to read since the user
 * did not type anything. Conservative on field choices: do NOT pre-populate
 * explicitlyAllowedTools or pre-authorize edit intent; let downstream rules
 * evaluate each tool on its own merits with the new intent anchor.
 */
export function synthesizePostApprovalPrediction(
  approvalContent: string,
): ToolPrediction {
  const prefix = "[plan approved] ";
  const snippet = prefix + approvalContent.slice(0, 200 - prefix.length);
  return {
    mood: "neutral",
    trust: "normal",
    intent:
      "User approved the plan via plan-mode UI; the implementation phase has " +
      "begun. Subagent dispatch and tools required to execute the approved " +
      "plan are expected.",
    blockedIntent: "",
    explicitlyAllowedTools: [],
    explicitlyBlockedSubstrings: [],
    blockAllTools: false,
    hasExplicitOverride: false,
    contextSwitch: "yes",
    questionIsStalling: "n/a",
    userMessageFull: prefix + approvalContent,
    userMessageSnippet: snippet,
    timestamp: Date.now(),
  };
}
