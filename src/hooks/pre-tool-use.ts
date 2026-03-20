import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";
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
import { readPlanContent } from "../utils/session-utils.js";
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
import { isPlanModeActive } from "../utils/plan-mode-detector.js";
import { isSubagent } from "../utils/subagent-detector.js";
import {
  checkPendingValidation,
  clearPendingValidation,
  writePendingValidation,
} from "../utils/pending-validation-cache.js";
import { logFastPathApproval, logFastPathDeny } from "../utils/logger.js";
import { spawnBackground } from "../utils/spawn-background.js";
import {
  getSessionDir,
  getSessionState,
  getSummaryPath,
  readSection,
  appendToolLog,
  formatToolDetail,
} from "../utils/summary-cache.js";
import {
  addEntry,
  addPatternWarnings,
  formatForPrompt,
} from "../utils/gate-reasoning-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const LOW_RISK_TOOLS = [
  // Read-only search/navigation
  "LSP",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",

  // MCP resource reading (read-only)
  "ListMcpResources",
  "ReadMcpResource",

  // Internal/meta tools (low impact)
  "TodoWrite",
  "TaskOutput",
  "ExitPlanMode",
  "EnterPlanMode",
  "Skill",
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
 * Spawn the async gate validator as a background process.
 * Uses spawnBackground to fork the async-gate-validator module.
 * If spawn fails, writes a pending validation failure to cache.
 */
function spawnAsyncGateValidator(
  toolName: string,
  filePath: string,
  transcriptPath: string,
  toolInput: unknown
): void {
  const validatorPath = path.join(__dirname, "../utils/async-gate-validator.js");

  try {
    spawnBackground(validatorPath, [
      "--tool", toolName,
      "--file", filePath,
      "--transcript", transcriptPath,
      "--input", JSON.stringify(toolInput),
    ]);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    writePendingValidation({
      toolName,
      filePath,
      status: "failed",
      failureReason: `Async gate validator spawn failed: ${errorMessage}`,
    }).catch(() => {
      // Ignore cache write errors - fail open for performance
    });
  }
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
  source: "typescript" | "llm";
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
  const startTime = Date.now();

  const planMode = isPlanModeActive(input.transcript_path);
  const subagent = isSubagent(input.transcript_path);
  const coldStart = toolCallCount < 3;

  // Use plan-mode pipeline for: plan mode (non-subagent), cold start (first 3 tools)
  const useSyncPipeline = (planMode && !subagent) || coldStart;

  /**
   * Sole exit function - replaces all direct outputAllow()/outputDeny() calls.
   * Handles telemetry, tool log, gate reasoning, and output.
   */
  async function exitPipeline(exit: PipelineExit): Promise<never> {
    // 1. TELEMETRY: Only for TypeScript-only decisions
    if (exit.source === "typescript") {
      if (exit.decision === "allow") {
        logFastPathApproval(exit.agent, "PreToolUse", toolName, projectDir, exit.reason);
      } else {
        logFastPathDeny(exit.agent, "PreToolUse", toolName, projectDir, exit.reason);
      }
    }

    // 2. JSONL TOOL LOG: Always written
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

    // 3. GATE REASONING: Write entry for interesting decisions
    if (exit.decision === "deny" || currentGateNote) {
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

    // 4. OUTPUT
    if (exit.decision === "allow") {
      return outputAllow();
    }
    return outputDeny(exit.reason);
  }

  // ============================================================
  // STEP 1: Low-risk auto-approve
  // ============================================================
  if (
    LOW_RISK_TOOLS.includes(toolName) ||
    (toolName.startsWith("mcp__") && !/(commit|push|confirm)$/.test(toolName))
  ) {
    await exitPipeline({
      decision: "allow",
      agent: "low-risk-bypass",
      reason: "Low-risk tool auto-approval",
      source: "typescript",
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
          source: "llm",
        });
        return;
      }
    }

    // Question validated or appeal overturned - allow
    await exitPipeline({
      decision: "allow",
      agent: "question-validate",
      reason: "Question validated",
      source: "llm",
    });
    return;
  }

  // ============================================================
  // STEP 3: Check pending async gate validation
  // ============================================================
  const isSubagentLauncher = toolName === "Agent" || toolName === "Task";
  if (!subagent && !isSubagentLauncher) {
    const pendingFailure = await checkPendingValidation();
    if (pendingFailure?.status === "failed") {
      await clearPendingValidation();
      await exitPipeline({
        decision: "deny",
        agent: "async-gate",
        reason: `Previous ${pendingFailure.toolName} had issues: ${pendingFailure.failureReason}`,
        source: "typescript",
      });
      return;
    }
  }

  // Detect rewind - if user rewound, clear all caches
  await detectRewind(input.transcript_path);

  // ============================================================
  // SUBAGENT PATH: low-risk already handled, tool-approve only
  // ============================================================
  if (subagent) {
    const decision = await checkToolApproval(toolName, toolInput, projectDir, "PreToolUse", { lazyMode: true });
    if (!decision.approved) {
      await exitPipeline({
        decision: "deny",
        agent: "tool-approve",
        reason: decision.reason ?? "Tool denied",
        source: "llm",
      });
      return;
    }
    await exitPipeline({
      decision: "allow",
      agent: "tool-approve",
      reason: "Subagent tool approved",
      source: "llm",
    });
    return;
  }

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
        const hasExitPlanModeApproval = recentContext.toolResult.some(
          (r) =>
            r.content.includes("ExitPlanMode") &&
            (r.content.includes("approved") || r.content.includes("allow"))
        );
        if (hasExitPlanModeApproval) {
          await exitPipeline({
            decision: "allow",
            agent: "exit-plan-mode",
            reason: "ExitPlanMode previously approved",
            source: "typescript",
          });
          return;
        }

        const currentPlan = await readPlanContent(input.transcript_path);
        const planResult = await readTranscriptExact(input.transcript_path, PLAN_VALIDATE_COUNTS);
        const conversationContext = formatTranscriptResult(planResult);

        const validation = await checkPlanIntent(
          currentPlan,
          toolName as "Write" | "Edit",
          toolInput as { content?: string; old_string?: string; new_string?: string },
          conversationContext,
          input.transcript_path,
          projectDir,
          "PreToolUse"
        );

        if (!validation.approved) {
          const appeal = await appealHelper(
            toolName,
            `Plan ${toolName.toLowerCase()} to ${filePath}`,
            conversationContext,
            validation.reason || "Plan drift detected",
            projectDir,
            "PreToolUse",
            `plan-validate blocked: ${validation.reason}`
          );

          if (!appeal.overturned) {
            await exitPipeline({
              decision: "deny",
              agent: "plan-validate",
              reason: `Plan drift detected: ${validation.reason}`,
              source: "llm",
            });
            return;
          }
          currentGateNote = appeal.gateNote;
        }

        await exitPipeline({
          decision: "allow",
          agent: "plan-validate",
          reason: "Plan validation passed",
          source: "llm",
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
              source: "llm",
            });
            return;
          }
          currentGateNote = appeal.gateNote;
        }

        await exitPipeline({
          decision: "allow",
          agent: "claude-md-validate",
          reason: "CLAUDE.md validation passed",
          source: "llm",
        });
        return;
      }

      if (trusted && !sensitive) {
        if (!useSyncPipeline) {
          // NON-PLAN MODE: Auto-approve + spawn async gate validator
          spawnAsyncGateValidator(toolName, filePath, input.transcript_path, toolInput);
          await exitPipeline({
            decision: "allow",
            agent: "trusted-path",
            reason: "Trusted file fast-path approval",
            source: "typescript",
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
                source: "llm",
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
      const summaryPath = await getSummaryPath(input.transcript_path);
      userIntent = await readSection(summaryPath, "User Intent");
      misalignments = await readSection(summaryPath, "Flagged Misalignments");
      gateReasoning = await formatForPrompt(sessionDir);
    } catch {
      // No summary yet - proceed without context
    }

    const gateResult = await checkGate(
      toolName,
      toolInput,
      { userIntent, misalignments, gateReasoning },
      projectDir,
      "PreToolUse"
    );

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
        `gate blocked: ${gateResult.reason}`,
        gateTranscriptResult.slashCommandContext
      );

      if (!appeal.overturned) {
        await exitPipeline({
          decision: "deny",
          agent: "gate",
          reason: gateResult.reason ?? "Gate check failed",
          source: "llm",
        });
        return;
      }
      currentGateNote = appeal.gateNote;
    }
  }

  // ============================================================
  // TOOL-APPROVE (final gate)
  // ============================================================

  // Block ExitPlanMode if plan file is empty
  if (toolName === "ExitPlanMode") {
    const planContent = await readPlanContent(input.transcript_path);
    if (!planContent || planContent.trim() === "") {
      await exitPipeline({
        decision: "deny",
        agent: "exit-plan-mode",
        reason: "Cannot exit plan mode without a plan.",
        source: "typescript",
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
      `tool-approve blocked: ${decision.reason}`,
      approveTranscriptResult.slashCommandContext
    );

    if (!appeal.overturned) {
      // Track workaround patterns for escalation
      let finalReason = decision.reason;
      const pattern = detectWorkaroundPattern(toolName, toolInput);
      if (pattern) {
        const count = await recordDenial(pattern);
        if (count >= MAX_SIMILAR_DENIALS) {
          finalReason += ` CRITICAL: You have attempted ${count} similar workarounds for '${pattern}'. STOP trying alternatives. Either use the approved MCP tool, ask the user for guidance, or acknowledge that this action cannot be performed.`;
        }
      }

      await exitPipeline({
        decision: "deny",
        agent: "tool-approve",
        reason: finalReason ?? "Tool denied",
        source: "llm",
      });
      return;
    }
    currentGateNote = appeal.gateNote;
    if (appeal.gateNote) currentGateNote = appeal.gateNote;
  } else {
    currentGateNote = decision.gateNote;
    // Non-plan mode: spawn async gate validator in background
    if (!useSyncPipeline) {
      const filePath = (toolInput as Record<string, unknown>)?.file_path as string ?? "";
      spawnAsyncGateValidator(toolName, filePath, input.transcript_path, toolInput);
    }
  }

  // Increment tool count
  await stateManager.update((s) => ({
    ...s,
    toolCallCount: s.toolCallCount + 1,
    toolCallsSinceUpdate: s.toolCallsSinceUpdate + 1,
  }));

  await exitPipeline({
    decision: "allow",
    agent: "pipeline-pass",
    reason: "All checks passed",
    source: "typescript",
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
