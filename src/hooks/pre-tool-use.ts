import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
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
import { checkIntentAlignment } from "../agents/hooks/intent-align.js";
import { detectWorkaroundPattern } from "../utils/command-patterns.js";
import { logToHomeAssistant } from "../utils/logger.js";
import { markErrorAcknowledged, setSession, checkUserInteraction } from "../utils/ack-cache.js";
import {
  setRewindSession,
  detectRewind,
  recordUserMessage,
  isFirstResponseChecked,
  markFirstResponseChecked,
  invalidateAllCaches,
} from "../utils/rewind-cache.js";
import {
  setDenialSession,
  checkDenialUserInteraction,
  recordDenial,
  MAX_SIMILAR_DENIALS,
} from "../utils/denial-cache.js";
import { readPlanContent } from "../utils/session-utils.js";
import { checkWithAppeal } from "../utils/pre-tool-use-utils.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
  hasErrorPatterns,
} from "../utils/transcript.js";
import {
  ERROR_CHECK_COUNTS,
  PLAN_VALIDATE_COUNTS,
  RECENT_TOOL_APPROVAL_COUNTS,
  STYLE_DRIFT_COUNTS,
} from "../utils/transcript-presets.js";
import { isPlanModeActive } from "../utils/plan-mode-detector.js";
import { isSubagent } from "../utils/subagent-detector.js";
import {
  checkPendingValidation,
  clearPendingValidation,
  setValidationSession,
} from "../utils/pending-validation-cache.js";
import {
  setStrictModeSession,
  shouldUseStrictMode,
  recordDenial as recordStrictDenial,
  recordError as recordStrictError,
  incrementToolCount,
  clearOneShots,
} from "../utils/strict-mode-tracker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Output structured JSON to allow the tool call and exit.
 */
function outputAllow(): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    })
  );
  process.exit(0);
}

/**
 * Output structured JSON to deny the tool call with a reason and exit.
 */
function outputDeny(reason: string): never {
  // Record denial so next tool uses strict mode
  recordStrictDenial();
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
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
  } catch (error) {
    // Log error but don't block - fail-open for performance
    logToHomeAssistant({
      agent: "pre-tool-use-hook",
      level: "error",
      problem: "Failed to spawn async validator",
      answer: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main() {
  const input: PreToolUseHookInput = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(JSON.parse(data)));
  });

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Set sessions for all caches (ensures isolation between main session and subagents)
  setValidationSession(input.transcript_path);
  setStrictModeSession(input.transcript_path);

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
        if (!isFirstResponseChecked()) {
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "info",
            problem: `${input.tool_name} ${filePath}`,
            answer: "First tool after user message - using strict validation",
          });
          // Fall through to strict validation
        } else {
          // Check other strict mode rules
          const strictCheck = shouldUseStrictMode(input.tool_name, input.tool_input);
          if (!strictCheck.strict) {
            // LAZY VALIDATION: Allow immediately, validate async
            logToHomeAssistant({
              agent: "pre-tool-use-hook",
              level: "info",
              problem: `${input.tool_name} ${filePath}`,
              answer: subagent && planMode
                ? "Subagent in plan mode - using lazy validation"
                : "Fast-path: trusted path, spawning async validator",
            });

            spawnAsyncValidator(input.tool_name, filePath, input.transcript_path, input.tool_input);
            outputAllow();
          } else {
            // Strict mode triggered by rules
            logToHomeAssistant({
              agent: "pre-tool-use-hook",
              level: "info",
              problem: `${input.tool_name} ${filePath}`,
              answer: `Strict mode: ${strictCheck.reason}`,
            });
            // Fall through to strict validation
          }
        }
      }

      // Plan mode (non-subagent) or special files: fall through to strict validation
      if (planMode && !subagent) {
        logToHomeAssistant({
          agent: "pre-tool-use-hook",
          level: "info",
          problem: `${input.tool_name} ${filePath}`,
          answer: "Plan mode active - using strict validation",
        });
      }
    }
  }

  // ============================================================
  // STEP 2: Check pending validation from previous async validator
  // This catches failures from lazy validation on previous tool calls
  // ============================================================
  const pendingFailure = checkPendingValidation();
  if (pendingFailure?.status === "failed") {
    clearPendingValidation(); // Don't block repeatedly
    recordStrictError(); // Next tool will use strict mode
    logToHomeAssistant({
      agent: "pre-tool-use-hook",
      level: "decision",
      problem: `Previous ${pendingFailure.toolName} async validation`,
      answer: `FAILED: ${pendingFailure.failureReason}`,
    });
    outputDeny(`Previous ${pendingFailure.toolName} had issues: ${pendingFailure.failureReason}`);
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
    "AskUserQuestion", // Prompts user for input (safe)
    "ExitPlanMode", // Exit plan mode (internal to Claude)
    "EnterPlanMode", // Enter plan mode (internal to Claude)
    "Skill", // Invoke skills like /commit (user-initiated)
  ];
  if (
    LOW_RISK_TOOLS.includes(input.tool_name) ||
    input.tool_name.startsWith("mcp__")
  ) {
    outputAllow();
  }

  // ============================================================
  // STRICT VALIDATION PATH
  // Reached when: plan mode, untrusted paths, special files, or non-FILE_TOOLS
  // ============================================================

  // Set session ID for cache invalidation on new session
  setSession(input.transcript_path);
  setDenialSession(input.transcript_path);
  setRewindSession(input.transcript_path);

  // Detect rewind - if user rewound, clear all caches
  const rewound = await detectRewind(input.transcript_path);
  if (rewound) {
    logToHomeAssistant({
      agent: "pre-tool-use-hook",
      level: "info",
      problem: "Rewind detected",
      answer: "Cleared all caches, re-validating fresh",
    });
  }

  // Block confirm tool from Claude Code - requires explicit user approval
  // Internal agents (like commit) call runConfirmAgent() directly, bypassing this hook
  if (input.tool_name === "mcp__agent-framework__confirm") {
    const denyReason =
      "Confirm requires explicit user approval. Use /commit or explicitly request confirm.";
    const result = await checkWithAppeal(
      async () => ({ approved: false, reason: denyReason }),
      input.tool_name,
      input.tool_input,
      input.transcript_path
    );

    if (!result.approved) {
      outputDeny(result.reason ?? denyReason);
    }
    outputAllow();
  }

  // First-response intent check - detect if AI's first tool call ignores user question/request
  // Only check for action tools (Edit, Write, Bash, etc.) - investigation tools are fine
  // Gate: only run once per user turn (reset when user sends new message or rewinds)
  const ACTION_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash", "Agent", "Task"];

  // Skip first response intent check if ExitPlanMode was recently approved
  // User has explicitly approved the plan, allow implementation to proceed
  if (ACTION_TOOLS.includes(input.tool_name) && !isFirstResponseChecked()) {
    const recentForIntent = await readTranscriptExact(
      input.transcript_path,
      RECENT_TOOL_APPROVAL_COUNTS
    );
    const hasExitPlanModeApproval = recentForIntent.toolResult.some(
      (r) =>
        r.content.includes("ExitPlanMode") &&
        (r.content.includes("approved") || r.content.includes("allow"))
    );
    if (hasExitPlanModeApproval) {
      // Clear ALL caches when plan is approved - user approval counts as fresh start
      invalidateAllCaches();
      markFirstResponseChecked();
      logToHomeAssistant({
        agent: "pre-tool-use-hook",
        level: "info",
        problem: `First response: ${input.tool_name}`,
        answer: "ExitPlanMode approved - cleared caches and skipping intent check",
      });
    }
  }

  if (ACTION_TOOLS.includes(input.tool_name) && !isFirstResponseChecked()) {
    // Mark as checked so we don't run again for subsequent tool calls in same turn
    markFirstResponseChecked();

    const intentResult = await checkWithAppeal(
      async () => {
        const result = await checkIntentAlignment(
          input.tool_name,
          input.tool_input,
          input.transcript_path
        );
        return result;
      },
      input.tool_name,
      input.tool_input,
      input.transcript_path,
      {
        appealContext: `${input.tool_name} as first response`,
        onAppealSuccess: () =>
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "info",
            problem: `First response intent appealed: ${input.tool_name}`,
            answer: "APPEALED - continuing",
          }),
      }
    );

    if (!intentResult.approved) {
      logToHomeAssistant({
        agent: "pre-tool-use-hook",
        level: "decision",
        problem: `First response: ${input.tool_name}`,
        answer: `BLOCKED: ${intentResult.reason}`,
      });
      outputDeny(
        `First response misalignment: ${intentResult.reason}. Please respond to the user's message first.`
      );
    }
  }

  // Error acknowledgment check - detect if AI is ignoring errors
  // Step 1: Quick pattern check (TypeScript only, no LLM)
  const errorCheckResult = await readTranscriptExact(input.transcript_path, ERROR_CHECK_COUNTS);
  const errorCheckTranscript = formatTranscriptResult(errorCheckResult);

  // Clear caches if user has sent a new message (any user interaction = fresh start)
  const lastUserMessage = errorCheckResult.user[errorCheckResult.user.length - 1];
  if (lastUserMessage) {
    checkUserInteraction(lastUserMessage.content);
    checkDenialUserInteraction(lastUserMessage.content);
    // Record user message for rewind detection
    recordUserMessage(lastUserMessage.content, lastUserMessage.index);
  }

  // Only check TOOL_RESULT lines for error patterns to avoid false positives from Read tool (source code)
  const quickCheck = hasErrorPatterns(errorCheckTranscript, { toolResultsOnly: true });

  // Skip error-ack if tool matches suggested alternative (conservative exact match)
  if (quickCheck.needsCheck && matchesSuggestedAlternative(input.tool_name, errorCheckTranscript)) {
    logToHomeAssistant({
      agent: "pre-tool-use-hook",
      level: "info",
      problem: `${input.tool_name} matches suggested alternative`,
      answer: "Skipping error-ack check",
    });
    // Continue to next checks (don't require explicit ack)
  } else if (quickCheck.needsCheck) {
    // Step 2: Only call Haiku if error/directive patterns detected
    // Track the reason for potential markErrorAcknowledged call
    let blockReason = "";

    const ackResult = await checkWithAppeal(
      async () => {
        const result = await checkErrorAcknowledgment(
          errorCheckTranscript,
          input.tool_name,
          input.tool_input,
          input.transcript_path
        );
        if (result.startsWith("BLOCK:")) {
          blockReason = result.substring(7).trim();
          return { approved: false, reason: blockReason };
        }
        return { approved: true };
      },
      input.tool_name,
      input.tool_input,
      input.transcript_path,
      {
        onAppealSuccess: () => {
          markErrorAcknowledged(blockReason);
          // Also cache the ORIGINAL error pattern (what cache check looks for)
          // This fixes cache key mismatch: error-ack output format vs original error text
          const originalIssue = errorCheckTranscript.match(
            /error TS\d+[^\n]*|Error:[^\n]*|failed[^\n]*|FAILED[^\n]*/i
          );
          if (originalIssue) {
            markErrorAcknowledged(originalIssue[0]);
          }
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "decision",
            problem: `${input.tool_name} error-acknowledge appealed`,
            answer: "APPEALED - continuing",
          });
        },
      }
    );

    if (!ackResult.approved) {
      logToHomeAssistant({
        agent: "pre-tool-use-hook",
        level: "decision",
        problem: `${input.tool_name} blocked for ignoring errors`,
        answer: ackResult.reason ?? blockReason,
      });
      outputDeny(`Error acknowledgment required: ${ackResult.reason ?? blockReason}`);
    }
  }

  // Path-based risk classification for file tools (STRICT PATH)
  // This section handles: plan files, CLAUDE.md, and untrusted paths
  // Low risk: inside project or ~/.claude, and not sensitive
  // High risk: outside trusted dirs or sensitive files
  if (FILE_TOOLS.includes(input.tool_name)) {
    const filePath =
      (input.tool_input as { file_path?: string }).file_path ||
      (input.tool_input as { path?: string }).path;
    if (filePath) {
      // Plan file drift detection - validate plan content against user intent
      const plansDir = path.join(os.homedir(), ".claude", "plans");
      if (
        (input.tool_name === "Write" || input.tool_name === "Edit") &&
        isPathInDirectory(filePath, plansDir)
      ) {
        // Skip validation if ExitPlanMode was recently approved
        // This means user approved the plan and AI is now writing it
        const recentContext = await readTranscriptExact(
          input.transcript_path,
          RECENT_TOOL_APPROVAL_COUNTS
        );
        const hasExitPlanModeApproval = recentContext.toolResult.some(
          (r) =>
            r.content.includes("ExitPlanMode") &&
            (r.content.includes("approved") || r.content.includes("allow"))
        );
        if (hasExitPlanModeApproval) {
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "info",
            problem: `Plan ${input.tool_name.toLowerCase()} to ${filePath}`,
            answer: "ExitPlanMode approved - skipping validation",
          });
          outputAllow();
        }

        // Get current plan and conversation context
        const currentPlan = readPlanContent(input.transcript_path);
        const planResult = await readTranscriptExact(input.transcript_path, PLAN_VALIDATE_COUNTS);
        const conversationContext = formatTranscriptResult(planResult);

        // Wrap plan validation with appeal
        const validation = await checkWithAppeal(
          () =>
            checkPlanIntent(
              currentPlan,
              input.tool_name as "Write" | "Edit",
              input.tool_input as { content?: string; old_string?: string; new_string?: string },
              conversationContext,
              input.transcript_path
            ),
          input.tool_name,
          input.tool_input,
          input.transcript_path,
          { appealContext: `Plan ${input.tool_name.toLowerCase()} to ${filePath}` }
        );

        if (!validation.approved) {
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "decision",
            problem: `Plan ${input.tool_name.toLowerCase()} to ${filePath}`,
            answer: `DRIFT: ${validation.reason}`,
          });
          outputDeny(`Plan drift detected: ${validation.reason}`);
        }
        // Plan validated - allow write
        outputAllow();
      }

      // CLAUDE.md validation - detect Write/Edit to any CLAUDE.md file
      if (
        (input.tool_name === "Write" || input.tool_name === "Edit") &&
        filePath.endsWith("CLAUDE.md")
      ) {
        // Get current file content (null if doesn't exist)
        let currentContent: string | null = null;
        try {
          currentContent = fs.readFileSync(filePath, "utf-8");
        } catch {
          // File doesn't exist - that's OK for new files
        }

        const validation = await checkWithAppeal(
          () =>
            validateClaudeMd(
              currentContent,
              input.tool_name as "Write" | "Edit",
              input.tool_input as { content?: string; old_string?: string; new_string?: string },
              input.transcript_path
            ),
          input.tool_name,
          input.tool_input,
          input.transcript_path,
          {
            appealContext: `CLAUDE.md ${input.tool_name.toLowerCase()} to ${filePath}`,
          }
        );

        if (!validation.approved) {
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "decision",
            problem: `CLAUDE.md ${input.tool_name.toLowerCase()} to ${filePath}`,
            answer: `REJECTED: ${(validation.reason ?? "").slice(0, 200)}`,
          });
          outputDeny(`CLAUDE.md validation failed: ${validation.reason}`);
        }
        // CLAUDE.md validated - allow write
        outputAllow();
      }

      const trusted = isTrustedPath(filePath, projectDir);
      const sensitive = isSensitivePath(filePath);

      if (trusted && !sensitive) {
        // Low risk path - but check for style drift on Edit tool
        // Edit has old_string/new_string for comparison; Write/NotebookEdit lack old content
        if (input.tool_name === "Edit") {
          // Get user messages to check if style change was requested
          const transcriptResult = await readTranscriptExact(
            input.transcript_path,
            STYLE_DRIFT_COUNTS
          );
          const userMessages = formatTranscriptResult(transcriptResult);

          // Check for style drift with automatic appeal on denial
          const styleDriftResult = await checkWithAppeal(
            () =>
              checkStyleDrift(
                input.tool_name,
                input.tool_input,
                projectDir,
                userMessages
              ),
            input.tool_name,
            input.tool_input,
            input.transcript_path
          );

          if (!styleDriftResult.approved) {
            logToHomeAssistant({
              agent: "pre-tool-use-hook",
              level: "decision",
              problem: `Edit ${filePath}`,
              answer: `STYLE DRIFT: ${styleDriftResult.reason}`,
            });
            outputDeny(`Style drift detected: ${styleDriftResult.reason}`);
          }
        }

        // Low risk - auto-approve (passed style-drift check or not applicable)
        outputAllow();
      }
      // High risk - fall through to LLM approval
    }
  }

  const toolDescription = `${input.tool_name} with ${JSON.stringify(
    input.tool_input
  )}`;

  // Tool approval with automatic appeal on denial
  const decision = await checkWithAppeal(
    () => checkToolApproval(input.tool_name, input.tool_input, projectDir),
    input.tool_name,
    input.tool_input,
    input.transcript_path
  );

  logToHomeAssistant({
    agent: "pre-tool-use-hook",
    level: "decision",
    problem: toolDescription,
    answer: decision.approved ? "ALLOWED" : `DENIED: ${decision.reason}`,
  });

  if (!decision.approved) {
    // Track workaround patterns for escalation
    let finalReason = decision.reason;
    const pattern = detectWorkaroundPattern(input.tool_name, input.tool_input);
    if (pattern) {
      const count = recordDenial(pattern);

      if (count >= MAX_SIMILAR_DENIALS) {
        finalReason += ` CRITICAL: You have attempted ${count} similar workarounds for '${pattern}'. STOP trying alternatives. Either use the approved MCP tool, ask the user for guidance, or acknowledge that this action cannot be performed.`;
        logToHomeAssistant({
          agent: "pre-tool-use-hook",
          level: "escalation",
          problem: `Repeated workaround attempts: ${pattern}`,
          answer: `Count: ${count}`,
        });
      }
    }

    // Output structured JSON to deny and provide feedback to Claude
    outputDeny(finalReason ?? "Tool denied");
  }

  // Strict validation passed - update state
  markFirstResponseChecked();
  incrementToolCount();
  clearOneShots();

  // Explicitly allow approved tools
  outputAllow();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
