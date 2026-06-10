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
import { buildToolAppealAgent } from "../../utils/agent-configs.js";
import { logFastPathApproval } from "../../utils/logger.js";
import { startsWithAny } from "../../utils/retry.js";
import { extractGateNote } from "../../utils/gate-reasoning-cache.js";
import type { SlashCommandContext } from "../../utils/transcript.js";
import type { AppealUserState } from "../../rules/types.js";
import { stripQuotedAndPastedContent } from "../../utils/quote-detection.js";

// The literal "ACTION" suffix appended by resolveCheckMessage
// (src/utils/check-target-context.ts:120) and used by the static `alternative`
// strings in src/utils/command-patterns.ts:45-93. Used to detect denials that
// steer the AI toward the sanctioned agent-framework check MCP tool.
const CHECK_REDIRECT_FINGERPRINT = /You must run (?:the agent-framework check MCP|agent-framework check MCP)/i;

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

function stripExplicitQuoteBlocks(text: string): string {
  return text.replace(/\bQUOTE\b[\s\S]*?\bQUOTE END\b/gi, " ");
}

function userNamedLiteral(literal: string, userMessage: string): boolean {
  if (!literal) return false;
  const cleaned = stripExplicitQuoteBlocks(stripQuotedAndPastedContent(userMessage));
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^\\w.-])${escaped}(?=$|[^\\w.-])`, "i");
  const match = re.exec(cleaned);
  if (!match) return false;
  const before = cleaned.slice(Math.max(0, match.index - 80), match.index).toLowerCase();
  return !/(?:do\s+not|don't|dont|never|no|not|without|avoid|stop|refuse|forbid|forbidden|shouldn't|should\s+not)(?:\s+\w+){0,6}\s*$/.test(before);
}

function parseBashCommandFromDescription(toolName: string, toolDescription: string): string | null {
  if (toolName !== "Bash") return null;
  const match = toolDescription.match(/\bcommand=("(?:\\.|[^"\\])*")/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return null;
  }
}

function shellPrefixUserNamed(command: string, userMessage: string): string | null {
  const cleaned = stripExplicitQuoteBlocks(userMessage);
  const tokens = command.trim().match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens.length < 2) return null;

  const [head, firstArg] = tokens;
  if (!firstArg.startsWith("-")) return null;

  const prefix = `${head} ${firstArg}`;
  return userNamedLiteral(prefix, cleaned) ? prefix : null;
}

export interface AppealToolIdentity {
  rawToolName?: string;
  canonicalToolName?: string;
  rawToolNameIsAppealAlias?: boolean;
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
  slashCommandContext?: SlashCommandContext,
  toolIdentity?: AppealToolIdentity
): Promise<{ overturned: boolean; gateNote?: string }> {
  const rawToolName = toolIdentity?.rawToolName;
  const canonicalToolName = toolIdentity?.canonicalToolName ?? toolName;
  const userMessage = userState.userMessageFull || userState.userMessageSnippet;

  const bashCommand = parseBashCommandFromDescription(toolName, toolDescription);
  if (bashCommand) {
    const namedPrefix = shellPrefixUserNamed(
      bashCommand,
      userMessage,
    );
    if (namedPrefix) {
      logFastPathApproval(
        "tool-appeal",
        hookName,
        toolName,
        workingDir,
        `User explicitly named Bash command prefix ${namedPrefix}`,
      );
      return {
        overturned: true,
        gateNote: `User explicitly named Bash command prefix ${namedPrefix}`,
      };
    }
  }

  const contextSection = additionalContext
    ? `\n=== CALLER CONTEXT ===\n${additionalContext}\n=== END CONTEXT ===\n`
    : "";
  const toolIdentitySection = rawToolName && rawToolName !== canonicalToolName
    ? `\n=== TOOL IDENTITY ===\nRAW TOOL: ${rawToolName}\nCANONICAL TOOL: ${canonicalToolName}\nNOTE: The raw adapter tool is what the user can see. This raw/canonical pair is ${toolIdentity?.rawToolNameIsAppealAlias === true ? "an adapter-declared alias for the same tool call; judge user approval by applying the normal explicit-authorization rules to either name." : "not an adapter-declared alias; judge the raw/canonical relationship through the normal explicit-authorization rules."}\n=== END TOOL IDENTITY ===\n`
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
    {
      const spec = (await import("../../adapter/spec.js")).activeSpec();
      const checkHint = spec.renderCheckMcpHint();
      denialClassSection = `\n=== DENIAL CLASS ===\ncheck-redirect: this denial steers from a raw build/test/typecheck/lint/runtime command toward the sanctioned ${checkHint}. The user's underlying intent is fulfilled by the alternative tool — not by the raw command.\n${tokenLine}=== END DENIAL CLASS ===\n`;
    }
  }

  const userStateSection = renderUserStateSection(userState);
  const lastUserMessageSection = renderLastUserMessageSection(
    userState.userMessageFull || userState.userMessageSnippet,
  );

  const maxRetries = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await runAgentWithRetryAndTelemetry(
        { ...buildToolAppealAgent(), workingDir },
        {
          prompt: "Review this appeal for a denied tool call.",
          context: `BLOCK REASON: ${originalReason}
TOOL CALL: ${toolDescription}
${toolIdentitySection}${slashCommandSection}${denialClassSection}${userStateSection}${lastUserMessageSection}${contextSection}
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
