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
import { SUMMARY_INTENT_AGENT, SUMMARY_ACTIONS_AGENT } from "./agent-configs.js";
import {
  getSummaryPath,
  getSessionDir,
  readSection,
  updateSection,
  readToolLogTail,
  getSessionState,
} from "./summary-cache.js";
import { isSubagent } from "./subagent-detector.js";

interface UpdaterArgs {
  mode: "intent" | "actions";
  transcript: string;
  prompt?: string;  // base64 encoded user prompt (for intent mode)
}

function parseArgs(args: string[]): UpdaterArgs {
  const result: Partial<UpdaterArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--mode" && next) { result.mode = next as "intent" | "actions"; i++; }
    else if (arg === "--transcript" && next) { result.transcript = next; i++; }
    else if (arg === "--prompt" && next) { result.prompt = next; i++; }
  }
  if (!result.mode || !result.transcript) {
    console.error("Usage: summary-updater --mode intent|actions --transcript <path> [--prompt <base64>]");
    process.exit(1);
  }
  return result as UpdaterArgs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { mode, transcript } = args;

  if (isSubagent(transcript)) return;

  const sessionDir = getSessionDir(transcript);
  const summaryPath = await getSummaryPath(transcript);
  const stateManager = getSessionState(sessionDir);

  if (mode === "intent") {
    // Decode user prompt
    const userPrompt = args.prompt ? Buffer.from(args.prompt, "base64").toString("utf-8") : "";
    if (!userPrompt) return;

    // Read current sections
    let currentIntent = "";
    let currentApprovals = "";
    try {
      currentIntent = await readSection(summaryPath, "User Intent");
      currentApprovals = await readSection(summaryPath, "User Approvals");
    } catch {
      // Summary may not exist yet
    }

    const result = await runAgent(
      { ...SUMMARY_INTENT_AGENT },
      {
        prompt: "Update summary sections based on this user message.",
        context: `CURRENT USER INTENT:\n${currentIntent}\n\nCURRENT USER APPROVALS:\n${currentApprovals}\n\nNEW USER MESSAGE:\n${userPrompt}`,
      }
    );

    // Parse ---INTENT--- and ---APPROVALS--- sections
    const intentMatch = result.output.match(/---INTENT---\s*([\s\S]*?)(?:---APPROVALS---|$)/);
    const approvalsMatch = result.output.match(/---APPROVALS---\s*([\s\S]*?)$/);

    if (intentMatch?.[1]?.trim()) {
      await updateSection(summaryPath, "User Intent", intentMatch[1].trim());
    }
    if (approvalsMatch?.[1]?.trim()) {
      await updateSection(summaryPath, "User Approvals", approvalsMatch[1].trim());
    }

    await stateManager.update((state) => ({
      ...state,
      toolCallsSinceUpdate: 0,
      lastUpdated: Date.now(),
    }));
  } else if (mode === "actions") {
    // Throttle: skip if < 3s since last update
    const state = await stateManager.load();
    if (Date.now() - state.lastUpdated < 3000) return;

    // Read current sections
    let currentIntent = "";
    let currentActions = "";
    let currentMisalignments = "";
    try {
      currentIntent = await readSection(summaryPath, "User Intent");
      currentActions = await readSection(summaryPath, "AI Actions");
      currentMisalignments = await readSection(summaryPath, "Flagged Misalignments");
    } catch {
      return;  // No summary yet, skip
    }

    const toolLogTail = readToolLogTail(sessionDir, 10);

    const result = await runAgent(
      { ...SUMMARY_ACTIONS_AGENT },
      {
        prompt: "Update summary sections based on recent AI actions.",
        context: `USER INTENT:\n${currentIntent}\n\nCURRENT AI ACTIONS:\n${currentActions}\n\nCURRENT MISALIGNMENTS:\n${currentMisalignments}\n\nRECENT TOOL LOG:\n${toolLogTail}`,
      }
    );

    // Parse ---ACTIONS--- and ---MISALIGNMENTS--- sections
    const actionsMatch = result.output.match(/---ACTIONS---\s*([\s\S]*?)(?:---MISALIGNMENTS---|$)/);
    const misalignMatch = result.output.match(/---MISALIGNMENTS---\s*([\s\S]*?)$/);

    if (actionsMatch?.[1]?.trim()) {
      await updateSection(summaryPath, "AI Actions", actionsMatch[1].trim());
    }
    if (misalignMatch?.[1]?.trim()) {
      await updateSection(summaryPath, "Flagged Misalignments", misalignMatch[1].trim());
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
