import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { readStdinJson, initHookProcess, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { checkPlanIntent } from "../agents/hooks/plan-validate.js";
import { validateClaudeMd } from "../agents/hooks/claude-md-validate.js";
import { detectRewind } from "../utils/rewind-cache.js";
import { readPlanContent } from "../utils/session-utils.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
  detectParallelBatch,
  type ParallelBatchInfo,
} from "../utils/transcript.js";
import {
  APPEAL_COUNTS,
  PLAN_VALIDATE_COUNTS,
} from "../utils/transcript-presets.js";
import { getPlanModeContext, isPlanModeFromInput, isPlanModeActive } from "../utils/plan-mode-detector.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { logFastPathApproval } from "../utils/logger.js";
import {
  getSessionDir,
  getSessionState,
  appendToolLog,
  readToolLogEntries,
  formatToolDetail,
} from "../utils/summary-cache.js";
import {
  addEntry,
  addPatternWarnings,
  clearGateReasoning,
} from "../utils/gate-reasoning-cache.js";
import { writeTool, writeUser } from "../utils/synthetic.js";
import {
  FILE_TOOLS,
  isPathInDirectory,
  extractPathOrCmd,
  isPlanFile,
  extractFilePath,
} from "../rules/utils.js";
import { ALL_RULES, evaluateRules } from "../rules/index.js";
import type { RuleContext } from "../rules/types.js";


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
  usesLlm?: boolean;
}

async function waitForBatchLeader(
  sessionDir: string,
  leaderId: string,
): Promise<{ decision: "allow" | "deny"; reason: string }> {
  // Poll tool-log.jsonl for the leader's entry.
  // In production, hooks fire as separate parallel processes — the leader
  // may still be running when siblings start. Siblings poll until the
  // leader writes its result. In the test harness, hooks fire sequentially
  // so the leader always finishes first.
  const maxAttempts = 600; // 600 * 100ms = 60s max (leader may run multiple LLM calls)
  for (let i = 0; i < maxAttempts; i++) {
    const entries = readToolLogEntries(sessionDir, 50);
    const leader = entries.find((e) => e.toolUseId === leaderId);
    if (leader) {
      return {
        decision: leader.status === "allowed" ? "allow" : "deny",
        reason: leader.reason ?? "Batch leader decision",
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Timeout: fail open
  return { decision: "allow", reason: "Batch leader timed out — fail open" };
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

  const planMode = input.permission_mode !== undefined
    ? isPlanModeFromInput(input)
    : isPlanModeActive(input.transcript_path);
  const planModeCtx = getPlanModeContext(planMode);
  const subagent = isSubagent(input.transcript_path);
  const coldStart = toolCallCount < 3;

  // Fail open on any detection error — falls through to normal single-tool pipeline
  let batchInfo: ParallelBatchInfo | null = null;
  try {
    batchInfo = await detectParallelBatch(input.transcript_path, input.tool_use_id);
  } catch {
    // Detection failed — treat as solo tool (safe fallback)
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
      toolUseId: input.tool_use_id,
      batchPosition: batchInfo?.position,
      batchSize: batchInfo?.batchSize,
      path: extractPathOrCmd(toolInput).path,
      cmd: extractPathOrCmd(toolInput).cmd,
      status: exit.decision === "allow" ? "allowed" : "denied",
      gate: exit.agent,
      reason: exit.reason,
      ms: Date.now() - startTime,
    });

    // 3. GATE REASONING: Write entry for LLM agent decisions and denials
    const usesLlm = exit.usesLlm ?? false;
    if (!subagent && (exit.decision === "deny" || currentGateNote || usesLlm)) {
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

    // 4. Clear the workaround force-check lockout when allowing any MCP
    // commit/push/confirm/check tool. The currentPrediction is intentionally
    // NOT cleared here — single clear point is the next UserPromptSubmit.
    if (exit.decision === "allow" && /^mcp__.*(commit|push|confirm|check)$/.test(toolName)) {
      await stateManager.update((s) => ({
        ...s,
        forceCheckPending: false,
      }));
    }

    // 5. OUTPUT
    if (exit.decision === "allow") {
      return outputAllow();
    }
    return outputDeny(exit.reason);
  }

  /**
   * Shared plan-validate helper: reads plan content + transcript, calls checkPlanIntent,
   * and returns the validation result. Does NOT call exitPipeline -- caller decides.
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

  if (batchInfo && batchInfo.position > 0) {
    // Sibling in a parallel batch. The leader (position 0) runs the full
    // pipeline. Wait for the leader's result and propagate it.
    const leaderResult = await waitForBatchLeader(sessionDir, batchInfo.leaderId);

    // Only increment toolCallsSinceUpdate on allow (matching leader behavior —
    // the leader's increment only runs on the allow path)
    if (leaderResult.decision === "allow") {
      await stateManager.update((s) => ({
        ...s,
        toolCallsSinceUpdate: s.toolCallsSinceUpdate + 1,
      }));
    }

    // Route through exitPipeline for consistent telemetry (tool log, gate
    // reasoning for denials, prediction deactivation). Gate reasoning is
    // naturally skipped for allowed siblings because "batch-sibling" is not
    // an LLM agent and currentGateNote is unset.
    const reason = leaderResult.decision === "deny"
      ? `Error in parallel tool call: ${leaderResult.reason}`
      : leaderResult.reason;
    await exitPipeline({
      decision: leaderResult.decision,
      agent: "batch-sibling",
      reason,
    });
    return; // exitPipeline calls process.exit
  }

  // Deterministic outside-project-root classification.
  // - Plan files (~/.claude/plans/*.md): handled by the existing plan-validate
  //   block below; NOT flagged here.
  // - In-project files: normal flow.
  // - Otherwise (true outside-project, e.g. /etc/hosts): flag the context so
  //   downstream LLM gates inject a harsh "be extra conservative" warning.
  //   NEVER a hard block — the task explicitly requires soft LLM review.
  let outsideRootPath: string | undefined;
  if (FILE_TOOLS.includes(toolName)) {
    const raw = extractFilePath(toolName, toolInput);
    if (raw) {
      const abs = path.isAbsolute(raw) ? raw : path.resolve(projectDir, raw);
      if (!isPathInDirectory(abs, projectDir) && !isPlanFile(abs)) {
        outsideRootPath = abs;
      }
    }
  }

  // Build rule context
  const ctx: RuleContext = {
    toolName,
    toolInput,
    toolUseId: input.tool_use_id,
    projectDir,
    transcriptPath: input.transcript_path,
    sessionDir,
    sessionId: input.session_id,
    state,
    stateManager,
    planMode,
    planModeCtx,
    subagent,
    coldStart,
    useSyncPipeline,
    toolCallCount,
    outsideRootPath,
  };

  // Run all rules (respond-first, low-risk, plan-mode-block, subagent,
  // question-validate, prediction-block, drift-detect, correction,
  // error-acknowledge, trusted-path, edit-intent, style-drift, gate, tool-approve)
  const ruleResult = await evaluateRules(ALL_RULES, ctx, "PreToolUse");

  if (ruleResult) {
    // Rule produced a decision (allow or deny)
    currentGateNote = ruleResult.gateNote;
    await exitPipeline({
      decision: ruleResult.decision,
      agent: ruleResult.agent,
      reason: ruleResult.reason,
      usesLlm: ruleResult.usesLlm,
    });
    return;
  }

  // Rewind detection -- runs AFTER evaluateRules, preserving current position
  await detectRewind(input.transcript_path);

  // EXCEPTIONS: plan-validate and claude-md-validate run AFTER all rules pass.
  // trusted-path rule (priority 58) explicitly excludes plan/CLAUDE.md files
  // so they always reach this point.
  if (FILE_TOOLS.includes(toolName)) {
    const filePath =
      (toolInput as { file_path?: string }).file_path ||
      (toolInput as { path?: string }).path;

    if (filePath) {
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
              usesLlm: true,
            });
            return;
          }
          currentGateNote = appeal.gateNote;
        }

        await exitPipeline({
          decision: "allow",
          agent: "plan-validate",
          reason: "Plan validation passed",
          usesLlm: true,
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
              usesLlm: true,
            });
            return;
          }
          currentGateNote = appeal.gateNote;
        }

        await exitPipeline({
          decision: "allow",
          agent: "claude-md-validate",
          reason: "CLAUDE.md validation passed",
          usesLlm: true,
        });
        return;
      }
    }
  }

  // Post-allow bookkeeping (tool count, ExitPlanMode cleanup)
  await stateManager.update((s) => ({
    ...s,
    toolCallCount: s.toolCallCount + 1,
    toolCallsSinceUpdate: s.toolCallsSinceUpdate + 1,
  }));

  // Clear gate reasoning on plan approval - gives implementation phase a clean slate
  if (toolName === "ExitPlanMode") {
    await clearGateReasoning(sessionDir);
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

  logFastPathApproval("all-rules", "PreToolUse", toolName, projectDir, "All checks passed");
  await exitPipeline({
    decision: "allow",
    agent: "all-rules",
    reason: "All checks passed",
  });
}

main().catch(async (err) => {
  // Safety net: Always output a valid JSON response before exiting
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
