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
import { savePrediction } from "./prediction-cache.js";
import { isPlanModeActive } from "./plan-mode-detector.js";

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { mode, transcript } = args;

  if (isSubagent(transcript)) return;

  const sessionDir = getSessionDir(transcript);
  const summaryPath = await getSummaryPath(transcript, args.sessionId);
  const stateManager = getSessionState(sessionDir);

  if (mode === "intent") {
    // Decode user prompt
    const userPrompt = args.prompt ? Buffer.from(args.prompt, "base64").toString("utf-8") : "";
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
        context: `CURRENT USER INTENT:\n${currentIntent}\n\nCURRENT USER APPROVALS:\n${currentApprovals}\n\nNEW USER MESSAGE:\n${userPrompt}`,
      }
    );

    // Parse ---INTENT--- and ---APPROVALS--- sections (with fallback)
    const parsed = parseIntentOutput(result.output);
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
    if ((currentState.currentEditIntent ?? null) === null) {
      const previousEditIntent = currentState.previousEditIntent ?? false;
      try {
        const editIntentResult = await runAgent(
          { ...EDIT_INTENT_AGENT },
          {
            prompt: "Classify this user message.",
            context: `PREVIOUS_EDIT_INTENT: ${previousEditIntent}\n\nUSER_MESSAGE:\n${userPrompt}`,
          }
        );

        let classified = parseEditIntentOutput(editIntentResult.output);

        // Validation: if garbage, retry once
        if (classified === null) {
          const retryResult = await runAgent(
            { ...EDIT_INTENT_AGENT },
            {
              prompt: "Classify this user message.",
              context: `PREVIOUS_EDIT_INTENT: ${previousEditIntent}\n\nUSER_MESSAGE:\n${userPrompt}`,
            }
          );
          classified = parseEditIntentOutput(retryResult.output);
        }

        // Only write if still null (regex didn't already decide)
        if (classified !== null) {
          await stateManager.update((s) => {
            if ((s.currentEditIntent ?? null) === null) {
              return { ...s, currentEditIntent: classified };
            }
            return s;
          });
        }
      } catch {
        // LLM failure: leave as null (fail-open)
      }
    }

    // --- Derive and write predictions ---
    const updatedState = await stateManager.load();
    const editIntent = updatedState.currentEditIntent ?? null;
    const planMode = isPlanModeActive(transcript);

    let expectedIntent = "";
    let blockedIntent = "";
    const blockedTools: { toolName: string; targetPattern?: string; reason: string; exceptions?: string[] }[] = [];

    if (planMode) {
      expectedIntent = "planning and exploration tools";
      blockedIntent = "no file modification or execution tools";
      blockedTools.push({
        toolName: "Edit|Write|NotebookEdit",
        reason: "plan mode active - no file modifications",
      });
    } else if (editIntent === true) {
      expectedIntent = "file editing tools for implementation";
    } else if (editIntent === false) {
      expectedIntent = "read-only exploration tools";
      blockedIntent = "no write/edit tools";
      blockedTools.push({
        toolName: "Edit|Write|NotebookEdit",
        reason: "edit intent is false - read-only exploration",
      });
    }

    // Scan for explicit user directives blocking execution
    if (/\b(don'?t|do not)\s+(run|execute)\b/i.test(userPrompt)) {
      blockedTools.push({ toolName: "Bash", reason: "user said no execution" });
      blockedIntent += (blockedIntent ? "; " : "") + "no execution";
    }
    if (/\b(don'?t|do not)\s+(push|deploy)\b/i.test(userPrompt)) {
      blockedTools.push({ toolName: "Bash", targetPattern: "git push*", reason: "user said no pushing" });
      blockedIntent += (blockedIntent ? "; " : "") + "no pushing/deploying";
    }

    // Detect "use X agents only" pattern
    const agentOnlyMatch = userPrompt.match(/\buse\s+(\w+)\s+agents?\b/i);
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

    await savePrediction(sessionDir, {
      expectedIntent,
      blockedIntent,
      blockedTools,
      userMessageSnippet: userPrompt.slice(0, 200),
      timestamp: Date.now(),
      active: true,
    });
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
        context: `USER INTENT:\n${currentIntent}\n\nCURRENT AI ACTIONS:\n${currentActions}\n\nCURRENT MISALIGNMENTS:\n${currentMisalignments}\n\nRECENT TOOL LOG:\n${toolLogTail}`,
      }
    );

    // Parse ---ACTIONS--- and ---MISALIGNMENTS--- sections (with fallback)
    const parsed = parseActionsOutput(result.output);
    if (parsed.actions) {
      await updateSection(summaryPath, "AI Actions", parsed.actions);
    }
    if (parsed.misalignments) {
      await updateSection(summaryPath, "Flagged Misalignments", parsed.misalignments);
    }

    await stateManager.update((state) => ({
      ...state,
      toolCallsSinceUpdate: 0,
      lastUpdated: Date.now(),
    }));
  }

  flushTelemetry();
}

main().catch((error) => {
  console.error("Summary updater error:", error);
  process.exit(0);  // Always exit 0 - background process failures are non-fatal
});
