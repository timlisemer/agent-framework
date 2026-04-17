#!/usr/bin/env node
/**
 * Summary Updater - Background LLM for summary section updates
 *
 * Standalone script spawned by hooks to update summary sections.
 * Uses CLI args: --mode intent|actions --transcript <path> [--prompt <base64>]
 *
 * @module summary-updater
 */

import "./load-env.js";
import { initializeTelemetry, flushTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { runAgent } from "./agent-runner.js";
import { SUMMARY_INTENT_AGENT, SUMMARY_ACTIONS_AGENT, EDIT_INTENT_AGENT } from "./agent-configs.js";
import {
  getSummaryPath,
  getSessionDir,
  readSection,
  updateSection,
  readToolLogTail,
  getSessionState,
  createEmptySummary,
} from "./summary-cache.js";
import { isSubagent } from "./subagent-detector.js";
import { parseIntentOutput, parseActionsOutput } from "./summary-updater-parsing.js";
import { parseEditIntentOutput } from "./edit-intent.js";
import { getPlanModeContext, isPlanModeActive } from "./plan-mode-detector.js";
import { clearGateReasoning } from "./gate-reasoning-cache.js";
import { stripQuotedAndPastedContent } from "./quote-detection.js";
import { cleanupPidFile } from "./spawn-background.js";

interface UpdaterArgs {
  mode: "intent" | "actions";
  transcript: string;
  prompt?: string;  // base64 encoded user prompt (for intent mode)
  sessionId?: string;  // stable session identifier from BaseHookInput
}

function parseArgs(args: string[]): UpdaterArgs {
  const result: Partial<UpdaterArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--mode" && next) { result.mode = next as "intent" | "actions"; i++; }
    else if (arg === "--transcript" && next) { result.transcript = next; i++; }
    else if (arg === "--prompt" && next) { result.prompt = next; i++; }
    else if (arg === "--session-id" && next) { result.sessionId = next; i++; }
  }
  if (!result.mode || !result.transcript) {
    console.error("Usage: summary-updater --mode intent|actions --transcript <path> [--prompt <base64>] [--session-id <id>]");
    process.exit(1);
  }
  return result as UpdaterArgs;
}

/**
 * Detect whether the new intent is a significant departure from the old one.
 * Uses word overlap ratio — if less than 40% of old words appear in new text,
 * the intent has pivoted substantially.
 */
function isSignificantIntentChange(oldIntent: string, newIntent: string): boolean {
  const normalize = (text: string) =>
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const oldWords = normalize(oldIntent);
  const newWords = new Set(normalize(newIntent));
  if (oldWords.length === 0) return false;
  const overlap = oldWords.filter((w) => newWords.has(w)).length;
  return (overlap / oldWords.length) < 0.4;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { mode, transcript } = args;

  if (isSubagent(transcript)) return;

  const planModeCtx = getPlanModeContext(isPlanModeActive(transcript));

  const sessionDir = getSessionDir(transcript);
  const dedupKey = `summary-updater-${mode}`;

  // Hard timeout: self-terminate to prevent zombie processes
  const hardTimeout = setTimeout(() => {
    console.error(`[summary-updater] Hard timeout reached (mode=${mode}), exiting`);
    cleanupPidFile(sessionDir, dedupKey);
    flushTelemetry();
    process.exit(0);
  }, 60_000);
  hardTimeout.unref();
  const summaryPath = getSummaryPath(transcript);
  const stateManager = getSessionState(sessionDir);

  if (mode === "intent") {
    // Decode user prompt
    const userPrompt = args.prompt ? Buffer.from(args.prompt, "base64").toString("utf-8") : "";
    const strippedPrompt = stripQuotedAndPastedContent(userPrompt);
    if (!userPrompt) {
      console.error("summary-updater: empty prompt, skipping intent update");
      return;
    }

    // Ensure summary file exists (handles race with session-start)
    await createEmptySummary(summaryPath);

    // Read current sections
    const currentIntent = await readSection(summaryPath, "User Intent");
    const currentApprovals = await readSection(summaryPath, "User Approvals");

    const result = await runAgent(
      { ...SUMMARY_INTENT_AGENT },
      {
        prompt: "Update summary sections based on this user message.",
        context: `${planModeCtx.contextString}CURRENT USER INTENT:\n${currentIntent}\n\nCURRENT USER APPROVALS:\n${currentApprovals}\n\nNEW USER MESSAGE:\n${userPrompt}`,
      }
    );

    // Parse ---INTENT--- and ---APPROVALS--- sections (with fallback)
    const parsed = parseIntentOutput(result.output);

    // Clear stale gate reasoning when intent changes significantly
    if (parsed.intent && currentIntent && isSignificantIntentChange(currentIntent, parsed.intent)) {
      await clearGateReasoning(sessionDir);
    }

    if (parsed.intent) {
      await updateSection(summaryPath, "User Intent", parsed.intent);
    }
    if (parsed.approvals) {
      await updateSection(summaryPath, "User Approvals", parsed.approvals);
    }

    await stateManager.update((state) => ({
      ...state,
      toolCallsSinceUpdate: 0,
      lastUpdated: Date.now(),
    }));

    // --- LLM fallback for ambiguous edit intent ---
    const currentState = await stateManager.load();
    if ((currentState.currentEditIntent ?? null) !== true) {
      const previousEditIntent = currentState.previousEditIntent ?? false;
      try {
        const editIntentResult = await runAgent(
          { ...EDIT_INTENT_AGENT },
          {
            prompt: "Classify this user message.",
            context: `PREVIOUS_EDIT_INTENT: ${previousEditIntent}\n\nUSER_MESSAGE:\n${strippedPrompt}`,
          }
        );

        let classified = parseEditIntentOutput(editIntentResult.output);

        // Validation: if garbage, retry once
        if (classified === null) {
          const retryResult = await runAgent(
            { ...EDIT_INTENT_AGENT },
            {
              prompt: "Classify this user message.",
              context: `PREVIOUS_EDIT_INTENT: ${previousEditIntent}\n\nUSER_MESSAGE:\n${strippedPrompt}`,
            }
          );
          classified = parseEditIntentOutput(retryResult.output);
        }

        // Only write if still null (regex didn't already decide)
        if (classified !== null) {
          await stateManager.update((s) => {
            if (s.currentEditIntent !== true) {
              return { ...s, currentEditIntent: classified };
            }
            return s;
          });
        }
      } catch {
        // LLM failure: leave as null (fail-open)
      }
    }

  } else if (mode === "actions") {
    // Throttle: skip if < 3s since last update (but always run on first invocation)
    const state = await stateManager.load();
    if (state.summaryVersion > 0 && Date.now() - state.lastUpdated < 3000) return;

    // Ensure summary file exists (handles race with session-start)
    await createEmptySummary(summaryPath);

    // Read current sections
    const currentIntent = await readSection(summaryPath, "User Intent");
    const currentActions = await readSection(summaryPath, "AI Actions");
    const currentMisalignments = await readSection(summaryPath, "Flagged Misalignments");

    const toolLogTail = readToolLogTail(sessionDir, 10);

    const result = await runAgent(
      { ...SUMMARY_ACTIONS_AGENT },
      {
        prompt: "Update summary sections based on recent AI actions.",
        context: `${planModeCtx.contextString}USER INTENT:\n${currentIntent}\n\nCURRENT AI ACTIONS:\n${currentActions}\n\nCURRENT MISALIGNMENTS:\n${currentMisalignments}\n\nRECENT TOOL LOG:\n${toolLogTail}`,
      }
    );

    // Parse ---ACTIONS--- and ---MISALIGNMENTS--- sections (with fallback)
    const parsedActions = parseActionsOutput(result.output);
    if (parsedActions.actions) {
      await updateSection(summaryPath, "AI Actions", parsedActions.actions);
    }
    if (parsedActions.misalignments) {
      await updateSection(summaryPath, "Flagged Misalignments", parsedActions.misalignments);
    }

    await stateManager.update((state) => ({
      ...state,
      toolCallsSinceUpdate: 0,
      lastUpdated: Date.now(),
    }));
  }

  cleanupPidFile(sessionDir, dedupKey);
  flushTelemetry();
}

main().catch((error) => {
  console.error("Summary updater error:", error);
  process.exit(0);  // Always exit 0 - background process failures are non-fatal
});
