import "../utils/load-env.js";
import { initializeTelemetry, flushTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fork } from "child_process";
import { fileURLToPath } from "url";
import { checkToolApproval } from "../agents/hooks/tool-approve.js";
import { checkPlanIntent } from "../agents/hooks/plan-validate.js";
import { checkErrorAcknowledgment } from "../agents/hooks/error-acknowledge.js";
import { validateClaudeMd } from "../agents/hooks/claude-md-validate.js";
import { checkStyleDrift } from "../agents/hooks/style-drift.js";
import { checkResponseAlignment } from "../agents/hooks/response-align.js";
import { checkQuestionValidity } from "../agents/hooks/question-validate.js";
import { detectWorkaroundPattern } from "../utils/command-patterns.js";
import { markErrorAcknowledged, setSession, checkUserInteraction } from "../utils/ack-cache.js";
import {
  setRewindSession,
  detectRewind,
  recordUserMessage,
  isFirstResponseChecked,
  markFirstResponseChecked,
  invalidateAllCaches,
  hasNewUserMessage,
  isMessageCheckedByAgent,
  markMessageCheckedByAgent,
} from "../utils/rewind-cache.js";
import {
  setDenialSession,
  checkDenialUserInteraction,
  recordDenial,
  MAX_SIMILAR_DENIALS,
} from "../utils/denial-cache.js";
import { readPlanContent } from "../utils/session-utils.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
  hasErrorPatterns,
  hasMinimumTranscript,
} from "../utils/transcript.js";
import {
  APPEAL_COUNTS,
  ERROR_CHECK_COUNTS,
  PLAN_VALIDATE_COUNTS,
  STYLE_DRIFT_COUNTS,
  QUESTION_VALIDATE_COUNTS,
} from "../utils/transcript-presets.js";
import { isPlanModeActive } from "../utils/plan-mode-detector.js";
import { isSubagent } from "../utils/subagent-detector.js";
import {
  checkPendingValidation,
  clearPendingValidation,
  setValidationSession,
  writePendingValidation,
} from "../utils/pending-validation-cache.js";
import {
  setStrictModeSession,
  shouldUseStrictMode,
  recordDenial as recordStrictDenial,
  recordError as recordStrictError,
  incrementToolCount,
  clearOneShots,
} from "../utils/strict-mode-tracker.js";
import { setExecutionMode, setTranscriptPath } from "../utils/execution-context.js";
import { EXECUTION_MODES } from "../types.js";
import { logFastPathApproval, logFastPathContinue, flushStatuslineUpdates } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Output structured JSON to allow the tool call and exit.
 * Uses Promise.race with a fallback timeout to ensure clean exit.
 */
async function outputAllow(): Promise<never> {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  });

  process.stdout.write(output + "\n");
  flushTelemetry();

  // Wait for statusline flush or timeout (200ms fallback)
  await Promise.race([
    flushStatuslineUpdates(),
    new Promise((r) => setTimeout(r, 200)),
  ]);

  process.exit(0);
}

/**
 * Output structured JSON to deny the tool call with a reason and exit.
 * Uses Promise.race with a fallback timeout to ensure clean exit.
 * Note: Caller should call recordStrictDenial() before this if needed.
 */
async function outputDeny(reason: string): Promise<never> {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

  process.stdout.write(output + "\n");
  flushTelemetry();

  // Wait for statusline flush or timeout (200ms fallback)
  await Promise.race([
    flushStatuslineUpdates(),
    new Promise((r) => setTimeout(r, 200)),
  ]);

  process.exit(0);
}


// File tools that benefit from path-based risk classification
const FILE_TOOLS = ["Read", "Write", "Edit", "NotebookEdit"];

// Sensitive file patterns - always require LLM approval
const SENSITIVE_PATTERNS = [
  ".env",
  "credentials",
  ".ssh",
  ".aws",
  "secrets",
  ".key",
  ".pem",
  "password",
];

function isPathInDirectory(filePath: string, dirPath: string): boolean {
  const resolved = path.resolve(filePath);
  const dirResolved = path.resolve(dirPath);
  return (
    resolved.startsWith(dirResolved + path.sep) || resolved === dirResolved
  );
}

function isTrustedPath(filePath: string, projectDir: string): boolean {
  const claudeDir = path.join(os.homedir(), ".claude");
  return (
    isPathInDirectory(filePath, projectDir) ||
    isPathInDirectory(filePath, claudeDir)
  );
}

function isSensitivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Check if current tool call matches a suggested alternative from a previous denial.
 * Uses conservative exact matching.
 *
 * @param toolName - Current tool being called
 * @param transcript - Recent transcript with tool results
 * @returns true if tool matches a suggestion, skip error-ack check
 */
function matchesSuggestedAlternative(toolName: string, transcript: string): boolean {
  // Only check TOOL_RESULT lines for denied suggestions
  const toolResultLines = transcript
    .split("\n")
    .filter((l) => l.startsWith("TOOL_RESULT:"))
    .join("\n");

  // Conservative patterns - extract exact tool name
  const patterns = [
    /suggested alternative:\s*(?:use\s+)?["']?(\w+)["']?/gi,
    /use\s+["']?(\w+)["']?\s+(?:tool\s+)?instead/gi,
    /use\s+the\s+["']?(\w+)["']?\s+tool/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(toolResultLines)) !== null) {
      const suggested = match[1];
      // Exact match only (conservative)
      if (toolName === suggested) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Spawn the async validator as a background process.
 * The validator will run all LLM-based validations and write results to cache.
 * If any validation fails, the next tool call will be blocked.
 */
function spawnAsyncValidator(
  toolName: string,
  filePath: string,
  transcriptPath: string,
  toolInput: unknown
): void {
  const validatorPath = path.join(__dirname, "../utils/async-validator.js");

  try {
    const child = fork(
      validatorPath,
      [
        "--tool", toolName,
        "--file", filePath,
        "--transcript", transcriptPath,
        "--input", JSON.stringify(toolInput),
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
  } catch (err) {
    // Record spawn failure to cache so next tool call can detect it
    const errorMessage = err instanceof Error ? err.message : String(err);
    writePendingValidation({
      toolName,
      filePath,
      status: "failed",
      failureReason: `Async validator spawn failed: ${errorMessage}`,
    }).catch(() => {
      // Ignore cache write errors - fail open for performance
    });
  }
}

async function main() {
  const input: PreToolUseHookInput = await new Promise((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(() => reject(new Error("stdin timeout")), 30000);
    const onData = (chunk: Buffer | string) => (data += chunk);
    const onEnd = () => {
      clearTimeout(timeout);
      process.stdin.removeListener("data", onData);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Set sessions for all caches (ensures isolation between main session and subagents)
  setValidationSession(input.transcript_path);
  setStrictModeSession(input.transcript_path);
  setTranscriptPath(input.transcript_path);
  setRewindSession(input.transcript_path);

  // ============================================================
  // STEP 1: Fast-path for FILE_TOOLS on trusted paths (LAZY VALIDATION)
  // MUST run before checkPendingValidation() to avoid unnecessary cache I/O
  // In regular mode: allow immediately, validate async
  // In plan mode: fall through to strict validation
  // ============================================================
  if (FILE_TOOLS.includes(input.tool_name)) {
    const filePath =
      (input.tool_input as { file_path?: string }).file_path ||
      (input.tool_input as { path?: string }).path;

    if (filePath) {
      const trusted = isTrustedPath(filePath, projectDir);
      const sensitive = isSensitivePath(filePath);
      const planMode = isPlanModeActive(input.transcript_path);
      const subagent = isSubagent(input.transcript_path);

      // Fast path: trusted + not sensitive + (not plan mode OR subagent) + not special file
      // All subagents get lazy mode (they are typically read-only exploration)
      const plansDir = path.join(os.homedir(), ".claude", "plans");
      const isPlanFile = isPathInDirectory(filePath, plansDir);
      const isClaudeMd = filePath.endsWith("CLAUDE.md");

      // Base eligibility for lazy validation
      const baseEligible = trusted && !sensitive && (!planMode || subagent) && !isPlanFile && !isClaudeMd;

      if (baseEligible) {
        // Check first-response rule: first tool after user message uses strict
        let firstResponseChecked = await isFirstResponseChecked();
        if (!firstResponseChecked) {
          // Fall through to strict validation
        } else {
          // Check for new user message (race condition: user interrupt during parallel tool calls)
          // This re-reads transcript and resets firstResponseChecked if new message found
          const newMessage = await hasNewUserMessage(input.transcript_path);
          if (newMessage) {
            firstResponseChecked = false; // Fall through to strict validation
          }
        }

        if (firstResponseChecked) {
          // Check other strict mode rules
          const strictCheck = await shouldUseStrictMode(input.tool_name, input.tool_input);
          if (!strictCheck.strict) {
            // CRITICAL: Check pending validation BEFORE allowing fast-path
            // This catches async validator failures from previous lazy-validated tools
            const pendingFailure = await checkPendingValidation();
            if (pendingFailure?.status === "failed") {
              await clearPendingValidation();
              await recordStrictError();
              await recordStrictDenial();
              outputDeny(`Previous ${pendingFailure.toolName} had issues: ${pendingFailure.failureReason}`);
              return;
            }

            // LAZY VALIDATION: Allow immediately, validate async
            setExecutionMode(EXECUTION_MODES.LAZY);
            spawnAsyncValidator(input.tool_name, filePath, input.transcript_path, input.tool_input);
            logFastPathApproval("lazy-validation", "PreToolUse", input.tool_name, projectDir, "Trusted file fast-path approval");
            outputAllow();
            return;
          }
          // Strict mode triggered by rules - fall through
        }
      }
      // Plan mode (non-subagent) or special files: fall through to strict validation
    }
  }

  // ============================================================
  // STEP 2: Check pending validation from previous async validator
  // This catches failures from lazy validation on previous tool calls
  // BUT first check if user sent a new message (clears stale validations)
  // ============================================================

  // Read transcript early to detect new user messages before checking pending validation
  const earlyTranscriptResult = await readTranscriptExact(input.transcript_path, ERROR_CHECK_COUNTS);

  // Extract last user message early for low-risk bypass message marking
  const earlyLastUserMessage = earlyTranscriptResult.user[earlyTranscriptResult.user.length - 1];
  const earlyLastUserContent = earlyLastUserMessage?.content || "";

  // Check if user sent a new message or answered AskUserQuestion - clears stale pending validations
  const hasAskUserAnswerEarly = earlyTranscriptResult.toolResult.some(
    (tr) => tr.content.includes("User answered") || tr.content.includes("answered Claude's questions") || tr.content.includes("→")
  );

  // Clear pending validation and confirm state if user provided new input
  // (invalidates stale async validation failures)
  if (hasAskUserAnswerEarly) {
    await clearPendingValidation();
  }

  const pendingFailure = await checkPendingValidation();
  if (pendingFailure?.status === "failed") {
    await clearPendingValidation(); // Don't block repeatedly
    await recordStrictError(); // Next tool will use strict mode
    await recordStrictDenial();
    outputDeny(`Previous ${pendingFailure.toolName} had issues: ${pendingFailure.failureReason}`);
    return;
  }

  // ============================================================
  // STEP 3: Auto-approve low-risk tools
  // These tools are read-only or have no filesystem/system impact
  // ============================================================
  const LOW_RISK_TOOLS = [
    // Read-only search/navigation
    "LSP", // Language server protocol queries
    "Grep", // File content search
    "Glob", // File pattern matching
    "WebSearch", // Web search
    "WebFetch", // Fetch web content

    // MCP resource reading (read-only)
    "ListMcpResources", // List available MCP resources
    "ReadMcpResource", // Read an MCP resource

    // Internal/meta tools (low impact)
    "TodoWrite", // Task list management (internal to Claude)
    "TaskOutput", // Read output from background tasks
    "ExitPlanMode", // Exit plan mode (internal to Claude)
    "EnterPlanMode", // Enter plan mode (internal to Claude)
    "Skill", // Invoke skills like /commit (user-initiated)
  ];

  // Read-only MCP tools that can be auto-approved (no side effects)
  const READ_ONLY_MCP_TOOLS = [
    "mcp__agent-framework__check", // Read-only diagnostics (lint/build check)
  ];

  // MCP tools that require approval (commit/push/confirm) are handled by tool-approve blacklist
  // They will be denied by tool-approve and then tool-appeal checks for slash command context

  if (
    LOW_RISK_TOOLS.includes(input.tool_name) ||
    READ_ONLY_MCP_TOOLS.includes(input.tool_name)
  ) {
    // Mark message as checked for response-align BEFORE early return
    // This ensures subsequent tool calls know the user's request was handled
    // (prevents duplicate checking after MCP calls like "Run the mcp!!!!")
    if (earlyLastUserContent) {
      await markMessageCheckedByAgent("response-align", earlyLastUserContent);
    }
    logFastPathApproval("low-risk-bypass", "PreToolUse", input.tool_name, projectDir, "Low-risk tool auto-approval");
    outputAllow();
    return;
  }

  // ============================================================
  // STEP 4: AskUserQuestion validation
  // Validates questions before showing to user - catches:
  // - Questions about unseen content (e.g., plan not displayed)
  // - Questions user already answered earlier
  // - Workflow violations (asking implementation questions before plan approved)
  // ============================================================
  if (input.tool_name === "AskUserQuestion") {
    const questionTranscript = await readTranscriptExact(input.transcript_path, QUESTION_VALIDATE_COUNTS);
    const questionContext = formatTranscriptResult(questionTranscript);

    const validation = await checkQuestionValidity(
      input.tool_input,
      questionContext,
      input.transcript_path,
      projectDir,
      "PreToolUse"
    );

    if (!validation.approved) {
      // Call appeal helper to check if user context overrides block
      const appeal = await appealHelper(
        input.tool_name,
        `AskUserQuestion: ${JSON.stringify(input.tool_input).slice(0, 200)}`,
        questionContext,
        validation.reason || "Question validation failed",
        projectDir,
        "PreToolUse",
        `question-validate blocked: ${validation.reason}`
      );

      if (!appeal.overturned) {
        await recordStrictDenial();
        outputDeny(validation.reason || "Question validation failed - show referenced content first");
        return;
      }
    }

    // Question validated or appeal overturned - allow
    logFastPathApproval("question-validate", "PreToolUse", input.tool_name, projectDir, "Question validated");
    outputAllow();
    return;
  }

  // ============================================================
  // STRICT VALIDATION PATH
  // Reached when: plan mode, untrusted paths, special files, or non-FILE_TOOLS
  // ============================================================

  // Set session ID for cache invalidation on new session
  setSession(input.transcript_path);
  setDenialSession(input.transcript_path);
  // setRewindSession already called at early session setup (line 260)

  // Detect rewind - if user rewound, clear all caches
  await detectRewind(input.transcript_path);

  // ============================================================
  // STRICT VALIDATION FLOW
  // Step 1: Error-Acknowledge
  // Step 2: Intent-Validate
  // Step 3: Path-Based Agents (plan, claudemd, style-drift)
  // Step 4: Tool-Approve (with lazy mode optimization)
  // ============================================================

  const ACTION_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash", "Agent", "Task"];

  // Check if ExitPlanMode was recently approved - skip intent check
  const firstResponseChecked = await isFirstResponseChecked();
  if (ACTION_TOOLS.includes(input.tool_name) && !firstResponseChecked) {
    const recentForIntent = await readTranscriptExact(
      input.transcript_path,
      APPEAL_COUNTS
    );
    const hasExitPlanModeApproval = recentForIntent.toolResult.some(
      (r) =>
        r.content.includes("ExitPlanMode") &&
        (r.content.includes("approved") || r.content.includes("allow"))
    );
    if (hasExitPlanModeApproval) {
      // Clear ALL caches when plan is approved - user approval counts as fresh start
      await invalidateAllCaches();
      await markFirstResponseChecked();
    }
  }

  // ============================================================
  // STEP 1: ERROR-ACKNOWLEDGE
  // TS Pre-check: hasErrorPatterns() on TOOL_RESULT lines
  // If triggered: LLM → if block → appealHelper → decide
  // ============================================================
  const errorCheckResult = await readTranscriptExact(input.transcript_path, ERROR_CHECK_COUNTS);
  const errorCheckTranscript = formatTranscriptResult(errorCheckResult);

  // Clear caches if user has sent a new message (any user interaction = fresh start)
  const lastUserMessage = errorCheckResult.user[errorCheckResult.user.length - 1];
  if (lastUserMessage) {
    await checkUserInteraction(lastUserMessage.content);
    await checkDenialUserInteraction(lastUserMessage.content);
    // Record user message for rewind detection
    await recordUserMessage(lastUserMessage.content, lastUserMessage.index);
  }

  // Also clear caches if user answered via AskUserQuestion tool
  // (tool result with answer indicator means fresh user input)
  const hasAskUserAnswer = errorCheckResult.toolResult.some(
    (tr) => tr.content.includes("User answered") || tr.content.includes("answered Claude's questions") || tr.content.includes("→")
  );
  if (hasAskUserAnswer) {
    await invalidateAllCaches();
  }

  // TS Pre-check: Only check TOOL_RESULT lines for error patterns
  const errorPreCheck = hasErrorPatterns(errorCheckTranscript, { toolResultsOnly: true });

  // Skip error-ack if transcript doesn't have minimum required context.
  // Error-ack needs: 1 user message AND at least 1 assistant or tool result.
  // Without this, there's no user directive to check acknowledgment against.
  const hasErrorAckContext = hasMinimumTranscript(errorCheckResult, {
    user: 1,
    assistantOrToolResult: 1,
  });

  // Skip error-ack if tool matches suggested alternative (conservative exact match)
  // Also skip if this message was already checked by error-acknowledge (per-agent tracking)
  const lastUserContent = lastUserMessage?.content || "";
  const errorAckAlreadyChecked = lastUserContent
    ? await isMessageCheckedByAgent("error-acknowledge", lastUserContent)
    : false;

  if (
    errorPreCheck.needsCheck &&
    hasErrorAckContext &&
    !matchesSuggestedAlternative(input.tool_name, errorCheckTranscript) &&
    !errorAckAlreadyChecked
  ) {
    // Mark as checked BEFORE running (prevents parallel duplicates)
    if (lastUserContent) {
      await markMessageCheckedByAgent("error-acknowledge", lastUserContent);
    }

    // Run error-acknowledge LLM agent
    const ackResult = await checkErrorAcknowledgment(
      errorCheckTranscript,
      input.tool_name,
      input.tool_input,
      projectDir,
      input.transcript_path,
      "PreToolUse"
    );

    if (ackResult.startsWith("BLOCK:")) {
      const blockReason = ackResult.substring(7).trim();

      // Call appeal helper
      const appeal = await appealHelper(
        input.tool_name,
        `${input.tool_name} with ${JSON.stringify(input.tool_input).slice(0, 200)}`,
        errorCheckTranscript,
        blockReason,
        projectDir,
        "PreToolUse",
        `error-acknowledge blocked: ${blockReason}`
      );

      if (appeal.overturned) {
        // User approved - cache the error as acknowledged and allow immediately
        await markErrorAcknowledged(blockReason);
        const originalIssue = errorCheckTranscript.match(
          /error TS\d+[^\n]*|Error:[^\n]*|failed[^\n]*|FAILED[^\n]*/i
        );
        if (originalIssue) {
          await markErrorAcknowledged(originalIssue[0]);
        }
        logFastPathApproval("error-acknowledge", "PreToolUse", input.tool_name, projectDir, "Appeal overturned - user approved");
        outputAllow();
        return;
      } else {
        // User did not approve - block
        await recordStrictDenial();
        outputDeny(`Error acknowledgment required: ${blockReason}`);
        return;
      }
    } else {
      // ackResult is "OK" - log continue and proceed to next step
      logFastPathContinue("error-acknowledge", "PreToolUse", input.tool_name, projectDir, "Error acknowledged - continuing to next check");
    }
  }

  // ============================================================
  // STEP 2: RESPONSE-ALIGN
  // Per-agent tracking: runs once per user message for response-align
  // Validates: preamble violations + intent alignment
  // If triggered: LLM → if block → appealHelper → decide
  // ============================================================
  const responseAlignAlreadyChecked = lastUserContent
    ? await isMessageCheckedByAgent("response-align", lastUserContent)
    : false;

  if (!responseAlignAlreadyChecked && lastUserContent) {
    // Mark as checked BEFORE running (prevents parallel duplicates)
    await markMessageCheckedByAgent("response-align", lastUserContent);
    // Also mark the legacy flag for backward compatibility
    await markFirstResponseChecked();

    // Run response-alignment LLM agent (validates preamble + intent)
    const intentResult = await checkResponseAlignment(
      input.tool_name,
      input.tool_input,
      input.transcript_path,
      projectDir,
      "PreToolUse"
    );

    if (!intentResult.approved) {
      // Get transcript for appeal
      const intentTranscriptResult = await readTranscriptExact(input.transcript_path, APPEAL_COUNTS);
      const intentTranscript = formatTranscriptResult(intentTranscriptResult);

      // Call appeal helper
      const appeal = await appealHelper(
        input.tool_name,
        `${input.tool_name} as first response`,
        intentTranscript,
        intentResult.reason || "First response misalignment",
        projectDir,
        "PreToolUse",
        `intent-validate blocked: ${intentResult.reason}`
      );

      if (!appeal.overturned) {
        // User did not approve - block
        await recordStrictDenial();
        outputDeny(`First response misalignment: ${intentResult.reason}. Please respond to the user's message first.`);
        return;
      }
      // Appeal overturned - user approved, allow immediately
      logFastPathApproval("response-align", "PreToolUse", input.tool_name, projectDir, "Appeal overturned - user approved");
      outputAllow();
      return;
    } else {
      // Response aligned - log continue and proceed to next step
      logFastPathContinue("response-align", "PreToolUse", input.tool_name, projectDir, "Response aligned - continuing to next check");
    }
  }

  // ============================================================
  // STEP 3: PATH-BASED AGENTS (only for FILE_TOOLS)
  // 3a. Plan-Validate: (Write|Edit) + path in ~/.claude/plans/
  // 3b. ClaudeMD-Validate: (Write|Edit) + path.endsWith("CLAUDE.md")
  // 3c. Style-Drift: Edit + trusted path
  // ============================================================
  if (FILE_TOOLS.includes(input.tool_name)) {
    const filePath =
      (input.tool_input as { file_path?: string }).file_path ||
      (input.tool_input as { path?: string }).path;

    if (filePath) {
      // 3a. PLAN-VALIDATE
      const plansDir = path.join(os.homedir(), ".claude", "plans");
      if (
        (input.tool_name === "Write" || input.tool_name === "Edit") &&
        isPathInDirectory(filePath, plansDir)
      ) {
        // Skip validation if ExitPlanMode was recently approved
        const recentContext = await readTranscriptExact(
          input.transcript_path,
          APPEAL_COUNTS
        );
        const hasExitPlanModeApproval = recentContext.toolResult.some(
          (r) =>
            r.content.includes("ExitPlanMode") &&
            (r.content.includes("approved") || r.content.includes("allow"))
        );
        if (hasExitPlanModeApproval) {
          logFastPathApproval("exit-plan-mode", "PreToolUse", input.tool_name, projectDir, "ExitPlanMode previously approved");
          outputAllow();
          return;
        }

        // Get current plan and conversation context
        const currentPlan = await readPlanContent(input.transcript_path);
        const planResult = await readTranscriptExact(input.transcript_path, PLAN_VALIDATE_COUNTS);
        const conversationContext = formatTranscriptResult(planResult);

        // Run plan-validate LLM agent
        const validation = await checkPlanIntent(
          currentPlan,
          input.tool_name as "Write" | "Edit",
          input.tool_input as { content?: string; old_string?: string; new_string?: string },
          conversationContext,
          input.transcript_path,
          projectDir,
          "PreToolUse"
        );

        if (!validation.approved) {
          // Call appeal helper
          const appeal = await appealHelper(
            input.tool_name,
            `Plan ${input.tool_name.toLowerCase()} to ${filePath}`,
            conversationContext,
            validation.reason || "Plan drift detected",
            projectDir,
            "PreToolUse",
            `plan-validate blocked: ${validation.reason}`
          );

          if (!appeal.overturned) {
            await recordStrictDenial();
            outputDeny(`Plan drift detected: ${validation.reason}`);
            return;
          }
          logFastPathApproval("appeal-overturn", "PreToolUse", input.tool_name, projectDir, "Appeal overturned - plan-validate");
        } else {
          logFastPathApproval("plan-validate", "PreToolUse", input.tool_name, projectDir, "Plan validation passed");
        }
        // Plan validated or appeal overturned - allow write
        outputAllow();
        return;
      }

      // 3b. CLAUDE-MD-VALIDATE
      if (
        (input.tool_name === "Write" || input.tool_name === "Edit") &&
        filePath.endsWith("CLAUDE.md")
      ) {
        // Get current file content (null if doesn't exist)
        let currentContent: string | null = null;
        try {
          currentContent = await fs.promises.readFile(filePath, "utf-8");
        } catch {
          // File doesn't exist - that's OK for new files
        }

        // Run claude-md-validate LLM agent
        const validation = await validateClaudeMd(
          currentContent,
          input.tool_name as "Write" | "Edit",
          input.tool_input as { content?: string; old_string?: string; new_string?: string },
          input.transcript_path,
          projectDir,
          "PreToolUse"
        );

        if (!validation.approved) {
          // Get transcript for appeal
          const mdTranscriptResult = await readTranscriptExact(input.transcript_path, APPEAL_COUNTS);
          const mdTranscript = formatTranscriptResult(mdTranscriptResult);

          // Call appeal helper
          const appeal = await appealHelper(
            input.tool_name,
            `CLAUDE.md ${input.tool_name.toLowerCase()} to ${filePath}`,
            mdTranscript,
            validation.reason || "CLAUDE.md validation failed",
            projectDir,
            "PreToolUse",
            `claude-md-validate blocked: ${validation.reason}`
          );

          if (!appeal.overturned) {
            await recordStrictDenial();
            outputDeny(`CLAUDE.md validation failed: ${validation.reason}`);
            return;
          }
          logFastPathApproval("appeal-overturn", "PreToolUse", input.tool_name, projectDir, "Appeal overturned - claude-md");
        } else {
          logFastPathApproval("claude-md-validate", "PreToolUse", input.tool_name, projectDir, "CLAUDE.md validation passed");
        }
        // CLAUDE.md validated or appeal overturned - allow write
        outputAllow();
        return;
      }

      const trusted = isTrustedPath(filePath, projectDir);
      const sensitive = isSensitivePath(filePath);

      if (trusted && !sensitive) {
        // 3c. STYLE-DRIFT (only for Edit on trusted paths)
        if (input.tool_name === "Edit") {
          // Get user messages to check if style change was requested
          const transcriptResult = await readTranscriptExact(
            input.transcript_path,
            STYLE_DRIFT_COUNTS
          );

          // Style-drift checks against CLAUDE.md preferences.
          // If blocked, appealHelper will check if user explicitly requested the style change.
          const userMessages = formatTranscriptResult(transcriptResult);

          // Run style-drift LLM agent
          const styleDriftResult = await checkStyleDrift(
            input.tool_name,
            input.tool_input,
            projectDir,
            userMessages,
            "PreToolUse"
          );

          if (!styleDriftResult.approved) {
            // Call appeal helper to check if user approved the style change
            const appeal = await appealHelper(
              input.tool_name,
              `Edit to ${filePath}`,
              userMessages,
              styleDriftResult.reason || "Style drift detected",
              projectDir,
              "PreToolUse",
              `style-drift blocked: ${styleDriftResult.reason}`
            );

            if (!appeal.overturned) {
              await recordStrictDenial();
              outputDeny(`Style drift detected: ${styleDriftResult.reason}`);
              return;
            }
            // Appeal overturned - user approved, allow immediately
            logFastPathApproval("style-drift", "PreToolUse", input.tool_name, projectDir, "Appeal overturned - user approved");
            outputAllow();
            return;
          } else {
            // Style check passed - log continue
            logFastPathContinue("style-drift", "PreToolUse", input.tool_name, projectDir, "Style check passed - continuing to approval");
          }
        }

        // Low risk - auto-approve (passed style-drift check or not applicable)
        logFastPathApproval("trusted-path", "PreToolUse", input.tool_name, projectDir, "Trusted path auto-approval");
        outputAllow();
        return;
      }
      // High risk (untrusted or sensitive) - fall through to tool-approve
    }
  }

  // ============================================================
  // STEP 4: TOOL-APPROVE (final gate)
  // TS Pre-check: getBlacklistHighlights() for Bash commands
  // Lazy mode: skip LLM if no blacklist matches
  // Otherwise: LLM → if block → appealHelper → decide
  // ============================================================

  // Determine if we're in lazy mode (regular mode + trusted paths already handled)
  // At this point we're in strict validation, but we can still use lazy mode
  // for tool-approve if there are no blacklist violations
  const planMode = isPlanModeActive(input.transcript_path);
  const subagent = isSubagent(input.transcript_path);
  const lazyMode = !planMode || subagent; // Lazy mode when not in plan mode, or is subagent

  // Block ExitPlanMode if plan file is empty
  if (input.tool_name === "ExitPlanMode") {
    const planContent = await readPlanContent(input.transcript_path);
    if (!planContent || planContent.trim() === "") {
      outputDeny("Cannot exit plan mode without a plan. Write your plan to the plan file first.");
      return;
    }
  }

  // Run tool-approve LLM agent with lazy mode option
  const decision = await checkToolApproval(
    input.tool_name,
    input.tool_input,
    projectDir,
    "PreToolUse",
    { lazyMode }
  );

  if (!decision.approved) {
    // Get transcript for appeal - WITH slash command context for MCP tools
    const approveTranscriptResult = await readTranscriptExact(input.transcript_path, {
      ...APPEAL_COUNTS,
      includeSlashCommandContext: true,
    });
    const approveTranscript = formatTranscriptResult(approveTranscriptResult);

    // Call appeal helper
    const appeal = await appealHelper(
      input.tool_name,
      `${input.tool_name} with ${JSON.stringify(input.tool_input).slice(0, 200)}`,
      approveTranscript,
      decision.reason || "Tool denied",
      projectDir,
      "PreToolUse",
      `tool-approve blocked: ${decision.reason}`,
      approveTranscriptResult.slashCommandContext
    );

    if (!appeal.overturned) {
      // Track workaround patterns for escalation
      let finalReason = decision.reason;
      const pattern = detectWorkaroundPattern(input.tool_name, input.tool_input);
      if (pattern) {
        const count = await recordDenial(pattern);

        if (count >= MAX_SIMILAR_DENIALS) {
          finalReason += ` CRITICAL: You have attempted ${count} similar workarounds for '${pattern}'. STOP trying alternatives. Either use the approved MCP tool, ask the user for guidance, or acknowledge that this action cannot be performed.`;
        }
      }

      // Output structured JSON to deny and provide feedback to Claude
      await recordStrictDenial();
      outputDeny(finalReason ?? "Tool denied");
      return;
    }
    logFastPathApproval("appeal-overturn", "PreToolUse", input.tool_name, projectDir, "Appeal overturned - tool-approve");
    // Appeal overturned - continue to allow
  }
  // Note: tool-approve agent logs its own decision via logApprove/logDeny

  // Strict validation passed - update state
  await markFirstResponseChecked();
  await incrementToolCount();
  await clearOneShots();

  // Explicitly allow approved tools
  outputAllow();
}

main().catch(async (err) => {
  // Safety net: Always output a valid JSON response before exiting
  // This prevents Claude Code from prompting for manual confirmation
  const errorMessage = err instanceof Error ? err.message : String(err);
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Hook error: ${errorMessage}. Please try again.`,
    },
  });

  process.stdout.write(output + "\n");
  console.error("PreToolUse hook error:", err);

  // Wait briefly for output to flush, then exit
  await new Promise((r) => setTimeout(r, 200));
  process.exit(1);
});
