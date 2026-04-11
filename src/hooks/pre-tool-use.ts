import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { readStdinJson, initHookProcess, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { checkToolApproval } from "../agents/hooks/tool-approve.js";
import { checkPlanIntent } from "../agents/hooks/plan-validate.js";
import { validateClaudeMd } from "../agents/hooks/claude-md-validate.js";
import { checkStyleDrift } from "../agents/hooks/style-drift.js";
import { checkQuestionValidity } from "../agents/hooks/question-validate.js";
import { checkGate } from "../agents/hooks/gate.js";
import { detectWorkaroundPattern } from "../utils/command-patterns.js";
import { detectRewind } from "../utils/rewind-cache.js";
import {
  recordDenial,
  MAX_SIMILAR_DENIALS,
} from "../utils/denial-cache.js";
import { readPlanContent, resolvePlanPath } from "../utils/session-utils.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
} from "../utils/transcript.js";
import {
  APPEAL_COUNTS,
  PLAN_VALIDATE_COUNTS,
  STYLE_DRIFT_COUNTS,
  QUESTION_VALIDATE_COUNTS,
} from "../utils/transcript-presets.js";
import { getPlanModeContext } from "../utils/plan-mode-detector.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getUnconsumedCorrections, consumeCorrections } from "../utils/correction-cache.js";
import { logFastPathApproval, logFastPathDeny } from "../utils/logger.js";
import {
  getSessionDir,
  getSessionState,
  getSummaryPath,
  readSection,
  appendToolLog,
  formatToolDetail,
  readToolLogEntries,
} from "../utils/summary-cache.js";
import {
  addEntry,
  addPatternWarnings,
  formatForPrompt,
  clearGateReasoning,
} from "../utils/gate-reasoning-cache.js";
import { isEditTool, isEditIntentExemptPath, planModeEditBlock, planModeBashBlock } from "../utils/edit-intent.js";
import {
  getActivePrediction,
  getAllPredictions,
  savePrediction,
  deactivatePrediction,
  deactivateAllPredictions,
  matchBlockedToolFromAll,
  formatPredictionContext,
} from "../utils/prediction-cache.js";
import { detectDrift } from "../utils/drift-detector.js";
import { writeTool, writeUser } from "../utils/synthetic.js";


// File tools that go through path-based risk classification (trusted/sensitive)
// and write-specific gates (edit-intent, CLAUDE.md validation, plan-file validation,
// style-drift). Read is NOT here — it's read-only with no side effects, so it
// belongs in LOW_RISK_TOOLS alongside Grep/Glob for immediate auto-approval.
const FILE_TOOLS = ["Write", "Edit", "NotebookEdit"];

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

// Low-risk tools get immediate auto-approval with no further checks.
// These are all read-only or side-effect-free — they can't modify files,
// execute commands, or affect shared state. Contrast with FILE_TOOLS above,
// which go through write-specific gates (edit-intent, style-drift, etc.).
const LOW_RISK_TOOLS = [
  // Read-only file/search/navigation
  "Read",
  "LSP",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "ToolSearch",

  // MCP resource reading (read-only)
  "ListMcpResources",
  "ReadMcpResource",

  // Internal/meta tools (low impact)
  "TodoWrite",
  "TaskOutput",
  "EnterPlanMode",
  "Skill",
];

const CONFIRMATION_PATTERN = /^\s*(y(es|ep|eah|up)?(\s*please)?|ok(ay)?|sure|go\s*ahead|do\s*it|proceed|confirm(ed)?|approved?|lgtm|sounds?\s*good|that('?s| is)\s*(fine|good|correct|right)|please(\s*do)?|yea|aye|k)\s*[.!]?\s*$/i;

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
 * Extract path or command from tool input for logging.
 */
function extractPathOrCmd(toolInput: unknown): { path?: string; cmd?: string } {
  const input = toolInput as Record<string, unknown>;
  return {
    path: (input?.file_path as string) ?? (input?.path as string) ?? undefined,
    cmd: (input?.command as string) ?? undefined,
  };
}


/**
 * Output structured JSON to allow the tool call and exit.
 * Private - only callable from exitPipeline().
 */
async function outputAllow(): Promise<never> {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  });

  return exitAfterFlush(0, output);
}

/**
 * Output structured JSON to deny the tool call with a reason and exit.
 * Private - only callable from exitPipeline().
 */
async function outputDeny(reason: string): Promise<never> {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

  return exitAfterFlush(0, output);
}

interface PipelineExit {
  decision: "allow" | "deny";
  agent: string;
  reason: string;
}

async function main() {
  const input = await readStdinJson<PreToolUseHookInput>();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Initialize all sessions
  initHookProcess(input.transcript_path);

  const sessionDir = getSessionDir(input.transcript_path);
  const stateManager = getSessionState(sessionDir);
  const state = await stateManager.load();
  const toolCallCount = state.toolCallCount;

  // Module-scoped variables for exitPipeline
  const toolName = input.tool_name;
  const toolInput = input.tool_input;
  let currentGateNote: string | undefined;
  let lastAgent = "tool-approve";  // Tracks the last LLM agent that ran
  const startTime = Date.now();

  const DEBUG = process.env.AGENT_FRAMEWORK_DEBUG === "1";
  const planModeCtx = getPlanModeContext(input.transcript_path);
  const planMode = planModeCtx.active;
  const subagent = isSubagent(input.transcript_path);
  const coldStart = toolCallCount < 3;

  if (DEBUG && !subagent) {
    console.error(`[pre-tool-use] subagent=false transcript=${path.basename(input.transcript_path)}`);
  }

  // Subagents always use async/lazy pipeline; main agent uses sync for plan mode or cold start
  const useSyncPipeline = (planMode || coldStart) && !subagent;

  /**
   * Sole exit function - replaces all direct outputAllow()/outputDeny() calls.
   * Handles telemetry, tool log, gate reasoning, and output.
   */
  async function exitPipeline(exit: PipelineExit): Promise<never> {
    // 1. JSONL TOOL LOG: Always written
    appendToolLog(sessionDir, {
      ts: Date.now(),
      tool: toolName,
      path: extractPathOrCmd(toolInput).path,
      cmd: extractPathOrCmd(toolInput).cmd,
      status: exit.decision === "allow" ? "allowed" : "denied",
      gate: exit.agent,
      reason: exit.reason,
      ms: Date.now() - startTime,
    });

    // 3. GATE REASONING: Write entry for LLM agent decisions and denials
    const isLlmAgent = ["tool-approve", "gate", "style-drift", "plan-validate", "claude-md-validate", "question-validate", "edit-intent", "prediction-block"].includes(exit.agent);
    if (!subagent && (exit.decision === "deny" || currentGateNote || isLlmAgent)) {
      const warnings = await addPatternWarnings(toolName, toolInput, sessionDir);
      await addEntry(sessionDir, {
        toolCallIndex: toolCallCount,
        timestamp: Date.now(),
        toolName,
        toolTarget: formatToolDetail(toolName, toolInput),
        decision: exit.decision === "allow" ? "ALLOWED" : "DENIED",
        note: currentGateNote,
        warnings,
        priority: (currentGateNote || warnings.length > 0 || exit.decision === "deny") ? "high" : "normal",
      });
    }

    // 4. Deactivate edit-intent predictions when allowing an edit tool.
    //    This prevents PostToolUse from re-creating corrections based on stale
    //    edit-intent predictions that PreToolUse already resolved.
    if (exit.decision === "allow" && isEditTool(toolName) && !subagent) {
      await deactivatePrediction(sessionDir, toolName, toolInput);
    }

    // 5. OUTPUT
    if (exit.decision === "allow") {
      return outputAllow();
    }
    return outputDeny(exit.reason);
  }

  /**
   * Shared plan-validate helper: reads plan content + transcript, calls checkPlanIntent,
   * and returns the validation result. Does NOT call exitPipeline — caller decides.
   */
  async function runPlanValidation(
    mode: "edit" | "exit",
    overrideToolName?: string,
    overrideToolInput?: unknown
  ): Promise<{ approved: boolean; reason?: string }> {
    const planContent = await readPlanContent(input.transcript_path);
    const planResult = await readTranscriptExact(input.transcript_path, PLAN_VALIDATE_COUNTS);
    const conversationContext = formatTranscriptResult(planResult);
    return checkPlanIntent(
      planContent,
      (overrideToolName ?? toolName) as "Write" | "Edit",
      (overrideToolInput ?? toolInput) as { content?: string; old_string?: string; new_string?: string },
      conversationContext,
      input.transcript_path,
      projectDir,
      "PreToolUse",
      mode
    );
  }

  // ============================================================
  // STEP 0: Respond-first enforcement (first tool call only)
  // When the user says something, AI must respond with text
  // before calling any tool. Pure TypeScript, no LLM.
  // ============================================================
  if (!subagent && !state.respondFirstChecked) {
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
      const rfResult = await readTranscriptExact(input.transcript_path, {
        counts: { user: 1, assistant: 3 },
      });

      if (rfResult.user.length > 0) {
        const lastUser = rfResult.user.reduce((a, b) => a.index > b.index ? a : b);

        // Short confirmations (yes, ok, go ahead, etc.) are approving
        // a previously-explained action -- skip respond-first enforcement.
        const isConfirmation = CONFIRMATION_PATTERN.test(lastUser.content);

        if (!isConfirmation) {
          const hasTextAfterUser = rfResult.assistant.some(
            (m) => m.index > lastUser.index && m.content.trim().length > 0
          );

          if (!hasTextAfterUser) {
            logFastPathDeny("respond-first", "PreToolUse", toolName, projectDir,
              "No text response before first tool call");
            // Set flag BEFORE exitPipeline (which returns Promise<never>).
            // One denial is sufficient -- repeated denials cause infinite loops.
            await stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
            await exitPipeline({
              decision: "deny",
              agent: "respond-first",
              reason: `You must respond to the user with text before calling tools. The user said: "${lastUser.content.slice(0, 150)}". Respond with text first, then proceed with tool calls.`,
            });
            return;
          }
        }
      }
    }
    // Text confirmed present (or exempt tool or confirmation) -- skip check for rest of turn
    await stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
  }

  // ============================================================
  // STEP 1: Low-risk auto-approve
  // ============================================================

  // Synthetic message for entering plan mode (before exitPipeline exits the process)
  if (toolName === "EnterPlanMode" && !subagent) {
    await writeTool(
      input.transcript_path,
      input.session_id,
      "EnterPlanMode",
      "Entering plan mode. All subsequent tool calls are read-only until ExitPlanMode."
    );
    await deactivateAllPredictions(sessionDir);
  }

  if (
    LOW_RISK_TOOLS.includes(toolName) ||
    (toolName.startsWith("mcp__") && !/(commit|push|confirm)$/.test(toolName))
  ) {
    logFastPathApproval("low-risk-bypass", "PreToolUse", toolName, projectDir, "Low-risk tool auto-approval");
    await exitPipeline({
      decision: "allow",
      agent: "low-risk-bypass",
      reason: "Low-risk tool auto-approval",
    });
    return;
  }

  // ============================================================
  // STEP 1.5: Plan mode hard block (TypeScript only, no appeal)
  // ============================================================
  if (planMode) {
    if (FILE_TOOLS.includes(toolName)) {
      const filePath =
        (toolInput as { file_path?: string }).file_path ||
        (toolInput as { path?: string }).path || "";
      const editBlock = planModeEditBlock(planMode, toolName, filePath);
      if (editBlock) {
        logFastPathDeny("plan-mode-block", "PreToolUse", toolName, projectDir, editBlock);
        await exitPipeline({
          decision: "deny",
          agent: "plan-mode-block",
          reason: editBlock,
        });
        return;
      }
    }

    if (toolName === "Bash") {
      const command = (toolInput as { command?: string }).command || "";
      const bashBlock = planModeBashBlock(planMode, toolName, command);
      if (bashBlock) {
        logFastPathDeny("plan-mode-block", "PreToolUse", toolName, projectDir, bashBlock);
        await exitPipeline({
          decision: "deny",
          agent: "plan-mode-block",
          reason: bashBlock,
        });
        return;
      }
    }
  }

  // ============================================================
  // SUBAGENT PATH: low-risk already handled, tool-approve only
  // ============================================================
  if (subagent) {
    if (toolName === "Bash") {
      logFastPathDeny("subagent-bash-block", "PreToolUse", toolName, projectDir, "Bash denied in subagents");
      await exitPipeline({
        decision: "deny",
        agent: "subagent-bash-block",
        reason: "Bash tool is not available in subagents",
      });
      return;
    }
    const decision = await checkToolApproval(toolName, toolInput, projectDir, "PreToolUse", { lazyMode: true, planModeContext: planModeCtx.contextString });
    if (!decision.approved) {
      await exitPipeline({
        decision: "deny",
        agent: "tool-approve",
        reason: decision.reason ?? "Tool denied",
        });
      return;
    }
    await exitPipeline({
      decision: "allow",
      agent: "tool-approve",
      reason: "Subagent tool approved",
    });
    return;
  }

  // ============================================================
  // STEP 2: AskUserQuestion validation
  // ============================================================
  if (toolName === "AskUserQuestion") {
    const questionTranscript = await readTranscriptExact(input.transcript_path, QUESTION_VALIDATE_COUNTS);
    const questionContext = formatTranscriptResult(questionTranscript);

    const validation = await checkQuestionValidity(
      toolInput,
      questionContext,
      input.transcript_path,
      projectDir,
      "PreToolUse"
    );

    if (!validation.approved) {
      const appeal = await appealHelper(
        toolName,
        `AskUserQuestion: ${JSON.stringify(toolInput).slice(0, 200)}`,
        questionContext,
        validation.reason || "Question validation failed",
        projectDir,
        "PreToolUse",
        `question-validate blocked: ${validation.reason}`
      );

      if (!appeal.overturned) {
        await exitPipeline({
          decision: "deny",
          agent: "question-validate",
          reason: validation.reason || "Question validation failed - show referenced content first",
            });
        return;
      }
    }

    // Question validated or appeal overturned - allow
    await exitPipeline({
      decision: "allow",
      agent: "question-validate",
      reason: "Question validated",
    });
    return;
  }

  // ============================================================
  // STEP 2.5: Tool prediction blocking (checks ALL predictions)
  // ============================================================
  if (!subagent) {
    if (toolName.startsWith("mcp__") && /(commit|push|confirm|check)$/.test(toolName)) {
      await deactivateAllPredictions(sessionDir);
    }

    const allPredictions = await getAllPredictions(sessionDir);
    if (allPredictions.length > 0) {
      const predFilePath = (toolInput as { file_path?: string }).file_path || (toolInput as { path?: string }).path || "";
      if (isEditTool(toolName) && isEditIntentExemptPath(predFilePath)) {
        // Exempt paths skip prediction blocking — they have their own validators
      } else {
        const blockedResult = matchBlockedToolFromAll(toolName, toolInput, allPredictions);
        if (blockedResult) {
          const blockReason = `Tool "${toolName}" is not aligned with current user intent. ${blockedResult.blocked.reason}`;

          const predTranscript = formatTranscriptResult(
            await readTranscriptExact(input.transcript_path, APPEAL_COUNTS)
          );

          const appeal = await appealHelper(
            toolName,
            `${toolName} with ${JSON.stringify(toolInput).slice(0, 200)}`,
            predTranscript,
            blockReason,
            projectDir,
            "PreToolUse",
            `prediction-block: ${blockedResult.blocked.reason}`
          );

          if (!appeal.overturned) {
            await exitPipeline({
              decision: "deny",
              agent: "prediction-block",
              reason: blockReason,
            });
            return;
          }
          // Appeal overturned: clear the matching prediction
          await deactivatePrediction(sessionDir, toolName, toolInput);
          currentGateNote = appeal.gateNote;
        }
      }
    }
  }

  // ============================================================
  // STEP 2.7: Drift detection (lazy mode only)
  // ============================================================
  if (!useSyncPipeline && !subagent) {
    let userIntent = "";
    let misalignments = "";
    try {
      const summaryPath = getSummaryPath(input.transcript_path);
      userIntent = await readSection(summaryPath, "User Intent");
      misalignments = await readSection(summaryPath, "Flagged Misalignments");
    } catch {
      // No summary yet
    }

    const recentLog = readToolLogEntries(sessionDir, 10);
    const drift = detectDrift(toolName, toolInput, userIntent, misalignments, recentLog);
    if (drift.detected && drift.severity === "block") {
      const driftTranscript = formatTranscriptResult(
        await readTranscriptExact(input.transcript_path, APPEAL_COUNTS)
      );

      const appeal = await appealHelper(
        toolName,
        `${toolName} with ${JSON.stringify(toolInput).slice(0, 200)}`,
        driftTranscript,
        drift.reason,
        projectDir,
        "PreToolUse",
        `drift-block: ${drift.reason}`
      );

      if (!appeal.overturned) {
        await exitPipeline({
          decision: "deny",
          agent: "drift-block",
          reason: drift.reason,
        });
        return;
      }
      currentGateNote = appeal.gateNote;
    }
  }

  // ============================================================
  // STEP 3: Check corrections from PostToolUse
  // ============================================================
  const isSubagentLauncher = toolName === "Agent" || toolName === "Task";
  if (!subagent && !isSubagentLauncher) {
    const corrections = await getUnconsumedCorrections(sessionDir);
    const relevantCorrection = corrections.find((c) => c.toolName === toolName);
    if (relevantCorrection) {
      await consumeCorrections(sessionDir);
      await exitPipeline({
        decision: "deny",
        agent: "correction",
        reason: relevantCorrection.reason,
      });
      return;
    }
  }

  // Detect rewind - if user rewound, clear all caches
  await detectRewind(input.transcript_path);

  // ============================================================
  // FILE TOOLS PATH
  // ============================================================
  if (FILE_TOOLS.includes(toolName)) {
    const filePath =
      (toolInput as { file_path?: string }).file_path ||
      (toolInput as { path?: string }).path;

    if (filePath) {
      const trusted = isTrustedPath(filePath, projectDir);
      const sensitive = isSensitivePath(filePath);

      // Plan-validate: Write/Edit to ~/.claude/plans/
      const plansDir = path.join(os.homedir(), ".claude", "plans");
      if (
        (toolName === "Write" || toolName === "Edit") &&
        isPathInDirectory(filePath, plansDir)
      ) {
        // Skip validation if ExitPlanMode was recently approved
        const recentContext = await readTranscriptExact(
          input.transcript_path,
          APPEAL_COUNTS
        );
        // Check for actual ExitPlanMode tool result via its [ExitPlanMode] prefix
        // (set by transcript.ts:799). Do NOT use naive content.includes() here —
        // that false-positives on Read/Grep results containing ExitPlanMode source code.
        const hasExitPlanModeApproval = recentContext.tool.some(
          (r) => r.content.startsWith("[ExitPlanMode]")
        );
        if (hasExitPlanModeApproval) {
          logFastPathApproval("exit-plan-mode", "PreToolUse", toolName, projectDir, "ExitPlanMode previously approved");
          await exitPipeline({
            decision: "allow",
            agent: "exit-plan-mode",
            reason: "ExitPlanMode previously approved",
                });
          return;
        }

        // Plan files at ~/.claude/plans/ are exempt from edit-intent blocking.
        // classifyEditIntent always returns false in plan mode, making this check
        // fire unconditionally. The plan-validate LLM check below handles validation.

        const validation = await runPlanValidation("edit");

        if (!validation.approved) {
          // IMPORTANT: Do NOT remove this appeal call. Without it, user overrides
          // are ignored and plan writes get stuck in an infinite deny loop.
          const planTranscript = formatTranscriptResult(recentContext);

          const appeal = await appealHelper(
            toolName,
            `${toolName} to plan file ${filePath}`,
            planTranscript,
            validation.reason || "Plan validation failed",
            projectDir,
            "PreToolUse",
            `plan-validate blocked: ${validation.reason}`
          );

          if (!appeal.overturned) {
            await exitPipeline({
              decision: "deny",
              agent: "plan-validate",
              reason: `Plan drift detected: ${validation.reason}`,
            });
            return;
          }
          currentGateNote = appeal.gateNote;
        }

        await exitPipeline({
          decision: "allow",
          agent: "plan-validate",
          reason: "Plan validation passed",
        });
        return;
      }

      // Claude-MD-validate: Write/Edit to CLAUDE.md
      if (
        (toolName === "Write" || toolName === "Edit") &&
        filePath.endsWith("CLAUDE.md")
      ) {
        let currentContent: string | null = null;
        try {
          currentContent = await fs.promises.readFile(filePath, "utf-8");
        } catch {
          // File doesn't exist - that's OK for new files
        }

        const validation = await validateClaudeMd(
          currentContent,
          toolName as "Write" | "Edit",
          toolInput as { content?: string; old_string?: string; new_string?: string },
          input.transcript_path,
          projectDir,
          "PreToolUse"
        );

        if (!validation.approved) {
          const mdTranscriptResult = await readTranscriptExact(input.transcript_path, APPEAL_COUNTS);
          const mdTranscript = formatTranscriptResult(mdTranscriptResult);

          const appeal = await appealHelper(
            toolName,
            `CLAUDE.md ${toolName.toLowerCase()} to ${filePath}`,
            mdTranscript,
            validation.reason || "CLAUDE.md validation failed",
            projectDir,
            "PreToolUse",
            `claude-md-validate blocked: ${validation.reason}`
          );

          if (!appeal.overturned) {
            await exitPipeline({
              decision: "deny",
              agent: "claude-md-validate",
              reason: `CLAUDE.md validation failed: ${validation.reason}`,
                    });
            return;
          }
          currentGateNote = appeal.gateNote;
        }

        await exitPipeline({
          decision: "allow",
          agent: "claude-md-validate",
          reason: "CLAUDE.md validation passed",
            });
        return;
      }

      // EDIT INTENT GATE: Block edit tools when editIntent === false
      // Plan files and CLAUDE.md are handled by their own validators above (already returned)
      // Exempt paths (memory files, etc.) skip this gate
      if (
        !isEditIntentExemptPath(filePath) &&
        isEditTool(toolName) &&
        (state.currentEditIntent ?? null) === false
      ) {
        const editIntentReason = `Edit intent is false - user has not requested file modifications. Target: ${filePath}`;

        // Appeal with MAJOR HINT (strong signal to uphold)
        const eiTranscript = formatTranscriptResult(
          await readTranscriptExact(input.transcript_path, APPEAL_COUNTS)
        );

        const appeal = await appealHelper(
          toolName,
          `${toolName} to ${filePath}`,
          eiTranscript,
          editIntentReason,
          projectDir,
          "PreToolUse",
          `=== EDIT INTENT WARNING ===
The edit intent classifier has determined the user does NOT want file edits right now.
This is a STRONG signal. The user's message was analyzed and classified as non-edit intent.
You should STRONGLY LEAN toward UPHOLD unless you find EXPLICIT, UNAMBIGUOUS user approval
for editing files (e.g., "make the change", "fix it", "implement it", "go ahead and edit").
Questions, discussions, or exploration of code do NOT count as edit approval.
If in doubt, UPHOLD.
=== END EDIT INTENT WARNING ===`
        );

        if (!appeal.overturned) {
          await exitPipeline({
            decision: "deny",
            agent: "edit-intent",
            reason: editIntentReason,
          });
          return;
        }

        // BREAKTHROUGH: Track overturned edit-intent appeals (persisted in SessionState)
        const overturnCount = (state.editIntentOverturnCount ?? 0) + 1;
        await stateManager.update((s) => ({
          ...s,
          editIntentOverturnCount: overturnCount,
          ...(overturnCount >= 2 ? { currentEditIntent: true as const, editIntentTimestamp: Date.now() } : {}),
        }));

        // Deactivate the micro-prediction that generated this edit-intent block
        // so PostToolUse does not re-create a correction for the same prediction
        await deactivatePrediction(sessionDir, toolName, toolInput);

        currentGateNote = appeal.gateNote;
        // Fall through to normal pipeline
      }

      if (trusted && !sensitive) {
        if (!useSyncPipeline) {
          logFastPathApproval("trusted-path", "PreToolUse", toolName, projectDir, "Trusted file fast-path");
          await exitPipeline({
            decision: "allow",
            agent: "trusted-path",
            reason: "Trusted file fast-path",
          });
          return;
        }

        // Plan mode / cold start: run style-drift check for Edit, then fall through to gate
        if (toolName === "Edit") {
          const transcriptResult = await readTranscriptExact(
            input.transcript_path,
            STYLE_DRIFT_COUNTS
          );
          const userMessages = formatTranscriptResult(transcriptResult);

          const styleDriftResult = await checkStyleDrift(
            toolName,
            toolInput,
            projectDir,
            userMessages,
            "PreToolUse"
          );

          if (!styleDriftResult.approved) {
            const appeal = await appealHelper(
              toolName,
              `Edit to ${filePath}`,
              userMessages,
              styleDriftResult.reason || "Style drift detected",
              projectDir,
              "PreToolUse",
              `style-drift blocked: ${styleDriftResult.reason}`
            );

            if (!appeal.overturned) {
              await exitPipeline({
                decision: "deny",
                agent: "style-drift",
                reason: `Style drift detected: ${styleDriftResult.reason}`,
                        });
              return;
            }
            currentGateNote = appeal.gateNote;
          }
        }
        // After style-drift passes (or not Edit), fall through to gate agent
      }
      // High risk (untrusted or sensitive) - fall through to gate/tool-approve
    }
  }

  // ============================================================
  // PLAN MODE / COLD START: Gate agent SYNC
  // ============================================================
  if (useSyncPipeline) {
    let userIntent = "";
    let misalignments = "";
    let gateReasoning = "";
    try {
      const summaryPath = getSummaryPath(input.transcript_path);
      userIntent = await readSection(summaryPath, "User Intent");
      misalignments = await readSection(summaryPath, "Flagged Misalignments");
      gateReasoning = await formatForPrompt(sessionDir);
    } catch {
      // No summary yet - proceed without context
    }

    // Read predictions and edit intent for gate context
    let predictions: string | undefined;
    try {
      const prediction = await getActivePrediction(sessionDir);
      if (prediction) {
        predictions = formatPredictionContext(prediction);
      }
    } catch {
      // Non-fatal
    }
    const editIntent = state.currentEditIntent ?? null;

    let gateResult: { approved: boolean; reason?: string };
    try {
      gateResult = await checkGate(
        toolName,
        toolInput,
        { userIntent, misalignments, gateReasoning, predictions, editIntent, planModeContext: planModeCtx.contextString },
        projectDir,
        "PreToolUse"
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logFastPathDeny("gate", "PreToolUse", toolName, projectDir, `Gate error (fail open): ${errorMsg}`);
      gateResult = { approved: true };
    }

    if (!gateResult.approved) {
      // Get transcript for appeal
      const gateTranscriptResult = await readTranscriptExact(input.transcript_path, {
        ...APPEAL_COUNTS,
        includeSlashCommandContext: true,
      });
      const gateTranscript = formatTranscriptResult(gateTranscriptResult);

      const appeal = await appealHelper(
        toolName,
        `${toolName} with ${JSON.stringify(toolInput).slice(0, 200)}`,
        gateTranscript,
        gateResult.reason || "Gate check failed",
        projectDir,
        "PreToolUse",
        `${planModeCtx.contextString}gate blocked: ${gateResult.reason}`,
        gateTranscriptResult.slashCommandContext
      );

      if (!appeal.overturned) {
        await exitPipeline({
          decision: "deny",
          agent: "gate",
          reason: gateResult.reason ?? "Gate check failed",
            });
        return;
      }
      currentGateNote = appeal.gateNote;
    }
    lastAgent = "gate";
  }

  // ============================================================
  // TOOL-APPROVE (final gate)
  // ============================================================

  // ExitPlanMode: block if plan file doesn't exist or is empty
  if (toolName === "ExitPlanMode") {
    const planPath = await resolvePlanPath(input.transcript_path);
    if (!planPath || !(await fs.promises.stat(planPath)).size) {
      logFastPathDeny("exit-plan-mode", "PreToolUse", toolName, projectDir, "Cannot exit plan mode without a plan.");
      await exitPipeline({
        decision: "deny",
        agent: "exit-plan-mode",
        reason: "Cannot exit plan mode without a plan.",
      });
      return;
    }

    // Plan exists and is non-empty — validate content before allowing exit
    const exitValidation = await runPlanValidation("exit");
    if (!exitValidation.approved) {
      await exitPipeline({
        decision: "deny",
        agent: "plan-validate",
        reason: `Plan validation failed: ${exitValidation.reason}`,
      });
      return;
    }
  }

  const decision = await checkToolApproval(
    toolName,
    toolInput,
    projectDir,
    "PreToolUse",
    {
      lazyMode: !useSyncPipeline,
      sessionDir,
      planModeContext: planModeCtx.contextString,
    }
  );

  if (!decision.approved) {
    currentGateNote = decision.gateNote;

    // Get transcript for appeal - WITH slash command context for MCP tools
    const approveTranscriptResult = await readTranscriptExact(input.transcript_path, {
      ...APPEAL_COUNTS,
      includeSlashCommandContext: true,
    });
    const approveTranscript = formatTranscriptResult(approveTranscriptResult);

    const appeal = await appealHelper(
      toolName,
      `${toolName} with ${JSON.stringify(toolInput).slice(0, 200)}`,
      approveTranscript,
      decision.reason || "Tool denied",
      projectDir,
      "PreToolUse",
      `${planModeCtx.contextString}tool-approve blocked: ${decision.reason}`,
      approveTranscriptResult.slashCommandContext
    );

    if (!appeal.overturned) {
      // Track workaround patterns for escalation
      let finalReason = decision.reason;
      const workaroundCategory = detectWorkaroundPattern(toolName, toolInput);
      if (workaroundCategory) {
        const count = await recordDenial(workaroundCategory);
        if (count >= MAX_SIMILAR_DENIALS) {
          finalReason += ` CRITICAL: You have attempted ${count} similar workarounds for '${workaroundCategory}'. STOP trying alternatives. Either use the approved MCP tool, ask the user for guidance, or acknowledge that this action cannot be performed.`;
        }

        // Force check: block all non-low-risk tools until check MCP is called
        await savePrediction(sessionDir, {
          expectedIntent: "run mcp__agent-framework__check to verify project state",
          blockedIntent: "all non-read tools until check has been run",
          blockedTools: [{
            toolName: ".*",
            reason: `Bash command denied (${workaroundCategory}). You must run mcp__agent-framework__check first.`,
            exceptions: ["mcp__agent-framework__check", "ToolSearch"],
          }],
          userMessageSnippet: `denied: ${(finalReason ?? "").slice(0, 100)}`,
          timestamp: Date.now(),
          active: true,
        });
      }

      await exitPipeline({
        decision: "deny",
        agent: "tool-approve",
        reason: finalReason ?? "Tool denied",
        });
      return;
    }
    currentGateNote = appeal.gateNote;
    if (appeal.gateNote) currentGateNote = appeal.gateNote;
  } else {
    currentGateNote = decision.gateNote;
  }

  // Increment tool count
  await stateManager.update((s) => ({
    ...s,
    toolCallCount: s.toolCallCount + 1,
    toolCallsSinceUpdate: s.toolCallsSinceUpdate + 1,
  }));

  // Clear gate reasoning on plan approval - gives implementation phase a clean slate
  if (toolName === "ExitPlanMode") {
    await clearGateReasoning(sessionDir);
    await deactivateAllPredictions(sessionDir);
    await stateManager.update((s) => ({
      ...s,
      currentEditIntent: true as const,
      previousEditIntent: s.currentEditIntent ?? null,
      editIntentTimestamp: Date.now(),
    }));

    if (!subagent) {
      await writeTool(
        input.transcript_path,
        input.session_id,
        "ExitPlanMode",
        "Exiting plan mode."
      );
      await writeUser(
        input.transcript_path,
        input.session_id,
        "ExitPlanMode",
        "Plan approved. Proceed with implementation."
      );
    }
  }

  logFastPathApproval(lastAgent, "PreToolUse", toolName, projectDir, "All checks passed");
  await exitPipeline({
    decision: "allow",
    agent: lastAgent,
    reason: "All checks passed",
  });
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
