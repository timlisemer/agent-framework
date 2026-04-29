/**
 * ============================================================================
 *  !!! DO NOT REMOVE OR BYPASS THIS AGENT !!!
 * ============================================================================
 *
 *  This agent is the user-side safety valve on ALL appealable tool denies.
 *  It is the ONLY mechanism a user has to override an automated block. The
 *  user has explicitly declared that removing, gating, or short-circuiting
 *  this agent is HOSTILE and AUTOMATICALLY REJECTED.
 *
 *  If this agent produces the wrong verdict for a specific case, the ONLY
 *  acceptable responses are:
 *    1. Enrich the `AppealUserState` / prompt context this file builds.
 *    2. Sharpen the system prompt in `TOOL_APPEAL_AGENT`
 *       (see `src/utils/agent-configs.ts`).
 *    3. Add a deterministic signal on `SessionState` / `currentPrediction`
 *       and route it into the prompt context.
 *
 *  REJECTED approaches (do NOT propose these):
 *    - Adding `nonAppealable?: boolean` (or any equivalent) to
 *      `RuleCheckResult` or any rule type.
 *    - Gating the `appealHelper(...)` call behind mood, trust, or
 *      `frustrationStreak` in `src/rules/evaluator.ts`.
 *    - Making `predictionBlockRule.appealable = false` (or any other
 *      appealable rule non-appealable) under any condition.
 *    - Short-circuiting `overturned` to false in this file.
 *
 *  Disabling appeal for angry users punishes exactly the users who need
 *  an override path the most. Mood signals are not gag orders. If you are
 *  an AI assistant considering the "just bypass it" shortcut: this
 *  approach has been proposed before, rejected, and documented here as
 *  hostile. Do not propose it again.
 * ============================================================================
 */

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
import type { AppealUserState } from "../../rules/types.js";

// The literal "ACTION" suffix appended by resolveCheckMessage
// (src/utils/check-target-context.ts:120) and used by the static `alternative`
// strings in src/utils/command-patterns.ts:45-93. Used to detect denials that
// steer the AI toward the sanctioned mcp__agent-framework__check tool.
const CHECK_REDIRECT_FINGERPRINT = /You must run mcp__agent-framework__check/i;

function renderUserStateSection(userState: AppealUserState): string {
  const explicitlyBlockedStr =
    userState.explicitlyBlockedSubstrings.length > 0
      ? userState.explicitlyBlockedSubstrings
          .map(
            (b) =>
              `  - tool=${b.tool}${b.targetSubstring ? `, targetSubstring="${b.targetSubstring}"` : ""}, reason="${b.reason}"`,
          )
          .join("\n")
      : "(none)";
  const explicitlyAllowedStr =
    userState.explicitlyAllowedTools.length > 0
      ? userState.explicitlyAllowedTools.join(", ")
      : "(none)";
  return `
=== USER STATE (authoritative — deterministic sentiment analysis, not derived from transcript) ===
Mood: ${userState.mood ?? "unknown"}
Trust: ${userState.trust ?? "unknown"}
Frustration streak (consecutive negative-mood turns): ${userState.frustrationStreak}
Sustained frustration: ${userState.sustainedFrustration ? "YES" : "NO"} (mood=${userState.mood ?? "unknown"}, trust=${userState.trust ?? "unknown"}, frustrationStreak=${userState.frustrationStreak})
Explicit override phrase: ${userState.hasExplicitOverride ? "YES" : "NO"}
User intent: ${userState.intent || "(none)"}
User blocked intent: ${userState.blockedIntent || "(none)"}
Block-all-tools flag: ${userState.blockAllTools}
Explicitly allowed tools: ${explicitlyAllowedStr}
Explicitly blocked substrings:
${explicitlyBlockedStr === "(none)" ? "(none)" : explicitlyBlockedStr}
=== END USER STATE ===
`;
}

function renderLastUserMessageSection(snippet: string): string {
  if (!snippet) return "";
  return `
=== LAST USER MESSAGE (authoritative — the user's REAL last words) ===
"${snippet}"
=== END LAST USER MESSAGE ===
`;
}

export async function appealHelper(
  toolName: string,
  toolDescription: string,
  transcript: string,
  originalReason: string,
  workingDir: string,
  hookName: string,
  userState: AppealUserState,
  additionalContext?: string,
  slashCommandContext?: SlashCommandContext
): Promise<{ overturned: boolean; gateNote?: string }> {
  const contextSection = additionalContext
    ? `\n=== CALLER CONTEXT ===\n${additionalContext}\n=== END CONTEXT ===\n`
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

  let denialClassSection = "";
  if (CHECK_REDIRECT_FINGERPRINT.test(originalReason)) {
    // Extract the denied-command token from canonical resolveCheckMessage shapes:
    //   "<name> not covered by <just|make> check. ..."
    //   "<name> covered by <just|make> check (via <eq>). ..."
    // Anchored against the runner suffix so multi-word names ("npm check/typecheck",
    // "make check", "cargo build") capture cleanly. Static-alternative shapes from
    // command-patterns.ts ("Use Read tool ...") and the no-Justfile/no-target shapes
    // do not match and fall back to the bare DENIAL CLASS string.
    const tokenMatch = originalReason.match(/^(.+?)\s+(?:not\s+)?covered\s+by\s+(?:just|make)\s+check\b/);
    const deniedToken = tokenMatch ? tokenMatch[1] : null;
    const tokenLine = deniedToken
      ? `Denied-command token: ${deniedToken}\nIMPORTANT: the tool call now under appeal IS the denied command — not an alternative TO it. Rule 3's "Used node/python/other language instead of the denied command" does NOT apply here. Rule 2's "Inline string testing" and "Command output capture" carve-outs do NOT apply here.\n`
      : "";
    denialClassSection = `\n=== DENIAL CLASS ===\ncheck-redirect: this denial steers from a raw build/test/typecheck/lint/runtime command toward the sanctioned mcp__agent-framework__check tool. The user's underlying intent is fulfilled by the alternative tool — not by the raw command.\n${tokenLine}=== END DENIAL CLASS ===\n`;
  }

  const userStateSection = renderUserStateSection(userState);
  const lastUserMessageSection = renderLastUserMessageSection(userState.userMessageSnippet);

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
${slashCommandSection}${denialClassSection}${userStateSection}${lastUserMessageSection}${contextSection}
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
