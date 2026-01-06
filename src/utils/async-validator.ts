#!/usr/bin/env node
/**
 * Async Validator - Background Process for Lazy Validation
 *
 * This is a standalone script that runs asynchronously after the pre-tool-use
 * hook has already allowed a tool. It performs all the "slow" validations
 * (LLM calls, transcript reads) and writes results to the pending validation cache.
 *
 * If any validation fails, the next tool call will be blocked with the failure reason.
 *
 * ## Usage (spawned by pre-tool-use hook)
 *
 * ```
 * node async-validator.js --tool Edit --file /path/to/file.ts --transcript /path/to/transcript
 * ```
 *
 * ## Validations Run
 *
 * 1. Intent alignment check (first-response only)
 * 2. Error acknowledgment check
 * 3. Style drift check (Edit tool only)
 *
 * @module async-validator
 */

import { checkIntentAlignment } from "../agents/hooks/intent-align.js";
import { checkStyleDrift } from "../agents/hooks/style-drift.js";
import { checkErrorAcknowledgment } from "../agents/hooks/error-acknowledge.js";
import { writePendingValidation, clearPendingValidation } from "./pending-validation-cache.js";
import { readTranscriptExact, formatTranscriptResult } from "./transcript.js";
import { ERROR_CHECK_COUNTS } from "./transcript-presets.js";
import { logToHomeAssistant } from "./logger.js";

interface ValidatorArgs {
  tool: string;
  file: string;
  transcript: string;
  toolInput?: string;
}

/**
 * Parse command line arguments.
 */
function parseArgs(args: string[]): ValidatorArgs {
  const result: Partial<ValidatorArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--tool" && next) {
      result.tool = next;
      i++;
    } else if (arg === "--file" && next) {
      result.file = next;
      i++;
    } else if (arg === "--transcript" && next) {
      result.transcript = next;
      i++;
    } else if (arg === "--input" && next) {
      result.toolInput = next;
      i++;
    }
  }

  if (!result.tool || !result.file || !result.transcript) {
    console.error("Usage: async-validator --tool <name> --file <path> --transcript <path> [--input <json>]");
    process.exit(1);
  }

  return result as ValidatorArgs;
}

/**
 * Main validation runner.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { tool, file, transcript } = args;

  // Parse tool input if provided
  let toolInput: unknown = { file_path: file };
  if (args.toolInput) {
    try {
      toolInput = JSON.parse(args.toolInput);
    } catch {
      // Use default
    }
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  try {
    // Validation 1: Intent Alignment (for action tools)
    const actionTools = ["Edit", "Write", "NotebookEdit", "Bash", "Agent", "Task"];
    if (actionTools.includes(tool)) {
      const intentResult = await checkIntentAlignment(tool, toolInput, transcript);
      if (!intentResult.approved) {
        writePendingValidation({
          status: "failed",
          toolName: tool,
          filePath: file,
          failureReason: `Intent misalignment: ${intentResult.reason}`,
        });
        logToHomeAssistant({
          agent: "async-validator",
          level: "decision",
          problem: `${tool} intent check`,
          answer: `FAILED: ${intentResult.reason}`,
        });
        return;
      }
    }

    // Validation 2: Error Acknowledgment
    const errorResult = await readTranscriptExact(transcript, ERROR_CHECK_COUNTS);
    const errorTranscript = formatTranscriptResult(errorResult);
    const ackResult = await checkErrorAcknowledgment(errorTranscript, tool, toolInput);
    if (ackResult.startsWith("BLOCK:")) {
      const reason = ackResult.substring(7).trim();
      writePendingValidation({
        status: "failed",
        toolName: tool,
        filePath: file,
        failureReason: `Error not acknowledged: ${reason}`,
      });
      logToHomeAssistant({
        agent: "async-validator",
        level: "decision",
        problem: `${tool} error-ack check`,
        answer: `FAILED: ${reason}`,
      });
      return;
    }

    // Validation 3: Style Drift (Edit tool only)
    if (tool === "Edit") {
      const styleResult = await checkStyleDrift(tool, toolInput, projectDir);
      if (!styleResult.approved) {
        writePendingValidation({
          status: "failed",
          toolName: tool,
          filePath: file,
          failureReason: `Style drift: ${styleResult.reason}`,
        });
        logToHomeAssistant({
          agent: "async-validator",
          level: "decision",
          problem: `${tool} style-drift check`,
          answer: `FAILED: ${styleResult.reason}`,
        });
        return;
      }
    }

    // All validations passed
    writePendingValidation({
      status: "passed",
      toolName: tool,
      filePath: file,
    });

    logToHomeAssistant({
      agent: "async-validator",
      level: "info",
      problem: `${tool} async validation`,
      answer: "PASSED",
    });
  } catch (error) {
    // On error, fail-open (treat as passed)
    // This ensures we don't block tools due to validator issues
    logToHomeAssistant({
      agent: "async-validator",
      level: "error",
      problem: `${tool} async validation error`,
      answer: error instanceof Error ? error.message : String(error),
    });

    // Clear any pending validation to avoid blocking
    clearPendingValidation();
  }
}

// Run main
main().catch((error) => {
  console.error("Async validator error:", error);
  process.exit(1);
});
