/**
 * Summary Updater Parsing - Pure functions for parsing LLM output markers.
 *
 * Extracted from summary-updater.ts for testability. These functions parse
 * the ---INTENT---/---APPROVALS--- and ---ACTIONS---/---MISALIGNMENTS---
 * delimiters from LLM output and clean trailing artifacts.
 *
 * @module summary-updater-parsing
 */

/**
 * Clean LLM output: remove trailing --- markers that corrupt markdown.
 * The LLM often adds a trailing --- after its content which gets written
 * into the summary file and creates horizontal rules between sections.
 */
export function cleanMarkerContent(text: string): string {
  return text.trim().replace(/\n---\s*$/, "").trim();
}

interface IntentParseResult {
  intent?: string;
  approvals?: string;
}

/**
 * Parse LLM output for intent and approvals sections.
 *
 * Expected format:
 * ---INTENT---
 * <intent content>
 * ---APPROVALS---
 * <approvals content>
 *
 * Fallback: if no ---INTENT--- marker found and output is non-empty,
 * treats entire output as intent (LLM omitted markers).
 */
export function parseIntentOutput(output: string): IntentParseResult {
  if (!output.trim()) return {};

  const intentMatch = output.match(/---INTENT---\s*([\s\S]*?)(?:---APPROVALS---|$)/);
  const approvalsMatch = output.match(/---APPROVALS---\s*([\s\S]*?)$/);

  const intent = intentMatch?.[1]?.trim()
    ? cleanMarkerContent(intentMatch[1])
    : undefined;

  const approvals = approvalsMatch?.[1]?.trim()
    ? cleanMarkerContent(approvalsMatch[1])
    : undefined;

  // Fallback: LLM omitted markers entirely - treat whole output as intent
  if (!intent && !output.includes("---INTENT---") && output.trim()) {
    return { intent: cleanMarkerContent(output) };
  }

  return { intent, approvals };
}

interface ActionsParseResult {
  actions?: string;
  misalignments?: string;
}

/**
 * Parse LLM output for actions and misalignments sections.
 *
 * Expected format:
 * ---ACTIONS---
 * <actions content>
 * ---MISALIGNMENTS---
 * <misalignments content>
 *
 * Fallback: if no ---ACTIONS--- marker found and output is non-empty,
 * treats entire output as actions (LLM omitted markers).
 */
export function parseActionsOutput(output: string): ActionsParseResult {
  if (!output.trim()) return {};

  const actionsMatch = output.match(/---ACTIONS---\s*([\s\S]*?)(?:---MISALIGNMENTS---|$)/);
  const misalignMatch = output.match(/---MISALIGNMENTS---\s*([\s\S]*?)$/);

  const actions = actionsMatch?.[1]?.trim()
    ? cleanMarkerContent(actionsMatch[1])
    : undefined;

  const misalignments = misalignMatch?.[1]?.trim()
    ? cleanMarkerContent(misalignMatch[1])
    : undefined;

  // Fallback: LLM omitted markers entirely - treat whole output as actions
  if (!actions && !output.includes("---ACTIONS---") && output.trim()) {
    return { actions: cleanMarkerContent(output) };
  }

  return { actions, misalignments };
}
