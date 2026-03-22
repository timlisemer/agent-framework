#!/usr/bin/env node
/**
 * Async Gate Validator - Background Gate Check
 *
 * Replaces async-validator.ts. Runs gate agent asynchronously after
 * tool calls are already allowed. If gate fails, writes failure to
 * pending validation cache for next tool call to catch.
 *
 * @module async-gate-validator
 */

import "./load-env.js";
import { initializeTelemetry, flushTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { checkGate } from "../agents/hooks/gate.js";
import {
  writePendingValidation,
  clearPendingValidation,
  initValidationSession,
} from "./pending-validation-cache.js";
import {
  getSummaryPath,
  getSessionDir,
  getSessionState,
  readSection,
  isStaleSummary,
} from "./summary-cache.js";
import { isSubagent } from "./subagent-detector.js";
import { formatForPrompt } from "./gate-reasoning-cache.js";
import { getActivePrediction, formatPredictionContext } from "./prediction-cache.js";
import { cleanupPidFile } from "./spawn-background.js";

interface ValidatorArgs {
  tool: string;
  file: string;
  transcript: string;
  input?: string;
  userHash?: string;
  sessionId?: string;
}

function parseArgs(args: string[]): ValidatorArgs {
  const result: Partial<ValidatorArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--tool" && next) { result.tool = next; i++; }
    else if (arg === "--file" && next) { result.file = next; i++; }
    else if (arg === "--transcript" && next) { result.transcript = next; i++; }
    else if (arg === "--input" && next) { result.input = next; i++; }
    else if (arg === "--user-hash" && next) { result.userHash = next; i++; }
    else if (arg === "--session-id" && next) { result.sessionId = next; i++; }
  }
  if (!result.tool || !result.file || !result.transcript) {
    console.error("Usage: async-gate-validator --tool <name> --file <path> --transcript <path> [--input <json>] [--user-hash <hash>] [--session-id <id>]");
    process.exit(1);
  }
  return result as ValidatorArgs;
}

const DEDUP_KEY = "async-gate-validator";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { tool, file, transcript } = args;

  const sessionDir = getSessionDir(transcript);

  // Hard timeout: self-terminate to prevent zombie processes
  const hardTimeout = setTimeout(() => {
    console.error("[async-gate-validator] Hard timeout reached, exiting");
    cleanupPidFile(sessionDir, DEDUP_KEY);
    flushTelemetry();
    process.exit(0);
  }, 60_000);
  hardTimeout.unref();

  initValidationSession(sessionDir);

  // Skip for subagents
  if (isSubagent(transcript)) {
    await clearPendingValidation();
    return;
  }

  let toolInput: unknown = { file_path: file };
  if (args.input) {
    try {
      toolInput = JSON.parse(args.input);
    } catch {
      // Use default
    }
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  try {
    // Read summary sections
    let userIntent = "";
    let misalignments = "";
    const summaryPath = getSummaryPath(transcript);

    const stale = await isStaleSummary(sessionDir);
    if (!stale) {
      try {
        userIntent = await readSection(summaryPath, "User Intent");
        misalignments = await readSection(summaryPath, "Flagged Misalignments");
      } catch {
        // Summary doesn't exist yet - gate handles gracefully
      }
    }

    // Read gate reasoning
    let gateReasoning = "";
    try {
      gateReasoning = await formatForPrompt(sessionDir);
    } catch {
      // No gate reasoning yet
    }

    // Read predictions and edit intent for gate context
    let predictions: string | undefined;
    let editIntent: boolean | null | undefined;
    try {
      const prediction = await getActivePrediction(sessionDir);
      if (prediction) {
        predictions = formatPredictionContext(prediction);
      }
      const stateManager = getSessionState(sessionDir);
      const state = await stateManager.load();
      editIntent = state.currentEditIntent ?? null;
    } catch {
      // Non-fatal
    }

    // Run gate agent
    const gateResult = await checkGate(
      tool,
      toolInput,
      { userIntent, misalignments, gateReasoning, predictions, editIntent },
      projectDir,
      "PreToolUse"
    );

    if (!gateResult.approved) {
      await writePendingValidation({
        status: "failed",
        toolName: tool,
        filePath: file,
        failureReason: `Gate check failed: ${gateResult.reason}`,
        userMessageHash: args.userHash,
      });
    } else {
      await writePendingValidation({
        status: "passed",
        toolName: tool,
        filePath: file,
        userMessageHash: args.userHash,
      });
    }
  } catch (error) {
    console.error(`[async-gate-validator] Error: ${error instanceof Error ? error.message : String(error)}`);
    await clearPendingValidation();
  }

  cleanupPidFile(sessionDir, DEDUP_KEY);
  flushTelemetry();
}

main().catch((error) => {
  console.error("Async gate validator error:", error);
  process.exit(1);
});
