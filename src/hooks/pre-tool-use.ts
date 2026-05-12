import * as path from "path";
import * as fs from "fs";
import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { validateClaudeMd } from "../agents/hooks/claude-md-validate.js";
import { readPlanFileContent, validatePlanEdit } from "../utils/plan-source.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { activeSpec } from "../adapter/spec.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";
import { buildAppealUserState } from "../agents/hooks/tool-appeal-user-state.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
  detectParallelBatch,
  userTurnIsFreshSinceLockout,
  readRecentUserMessagesArray,
  userTurnFollowedByCompletedToolRoundtrip,
  resolveActiveSlashCommandAllowedTools,
  type ParallelBatchInfo,
} from "../utils/transcript.js";
import {
  APPEAL_COUNTS,
} from "../utils/transcript-presets.js";
import { getPlanModeContext } from "../utils/plan-mode-detector.js";
import {
  findUnprocessedPlanApproval,
  synthesizePostApprovalPrediction,
} from "../utils/plan-approval-detector.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { logFastPathApproval } from "../utils/logger.js";
import {
  getSessionDir,
  getSessionState,
  appendToolLog,
  formatToolDetail,
} from "../utils/session-store.js";
import {
  addEntry,
  addPatternWarnings,
  clearGateReasoning,
} from "../utils/gate-reasoning-cache.js";
import { findBatchDecision } from "../utils/batch-decision-cache.js";
import { writeTool, writeUser } from "../utils/synthetic.js";
import {
  FILE_TOOLS,
  isPathInDirectory,
  extractPathOrCmd,
  isPlanFile,
  extractFilePath,
  extractFilePaths,
} from "../rules/utils.js";
import { ALL_RULES, evaluateRules } from "../rules/index.js";
import type { RuleContext } from "../rules/types.js";
import type { FrameworkPreToolUseHookInput } from "./types.js";
import { resolveHostContext } from "../utils/host-context.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { detectEpochChange, loadCurrentEpoch, rotateEpoch } from "../scenario/epoch.js";
import { onEpochRotation } from "../scenario/lifecycle.js";

interface PipelineExit {
  decision: "allow" | "deny";
  agent: string;
  reason: string;
  usesLlm?: boolean;
  mirroredFromLeader?: boolean;
}

function syntheticToolSource(content: string): string | null {
  const match = content.match(/^\[([^\]]+)\]/);
  return match?.[1] ?? null;
}

export async function mainPreToolUse(input: FrameworkPreToolUseHookInput, encoder: AdapterEncoder): Promise<void> {
  const spec = activeSpec();
  const canonical = spec.canonicalizeToolCall(input.tool_name, input.tool_input);
  const rawToolName = input.tool_name;

  const host = resolveHostContext(input);
  const projectDir = host.projectDir;

  const sessionDir = getSessionDir(input.transcript_path);

  // Detect epoch change (transcript rewind) and reset derived caches when needed.
  const epochChange = detectEpochChange(sessionDir, input.transcript_path);
  if (epochChange.rotated) {
    const newEpoch = rotateEpoch(
      sessionDir,
      epochChange.reason!,
      epochChange.anchorUuid ?? null,
    );
    await onEpochRotation(sessionDir, newEpoch);
  }

  const stateManager = getSessionState(sessionDir);
  let state = await stateManager.load();

  // Module-scoped variables for exitPipeline
  const toolName = canonical.toolName;     // canonical end-to-end downstream
  const toolInput = canonical.toolInput;
  const planExit = spec.isPlanExit({
    event: "PreToolUse",
    canonicalToolName: toolName,
    rawToolName,
    toolInput,
  });
  let currentGateNote: string | undefined;
  const startTime = Date.now();

  const planModeDetection = spec.detectPlanMode({
    permissionMode: input.permission_mode,
    transcriptPath: input.transcript_path,
  });
  const planMode = planModeDetection.active;
  const planModeCtx = getPlanModeContext(planMode);
  const subagent = isSubagent(input.transcript_path);

  // Clear stale forceCheckPending when a fresh user turn has begun: the most
  // recent non-meta user-text message has no completed tool roundtrip after
  // it. Mirrors the user-prompt-submit clear semantic (UserPromptSubmit
  // clears unconditionally on every fresh prompt). The PreToolUse-side
  // fallback is necessary because the test harness fires only SessionStart +
  // the target hook for a PreToolUse target, and live sessions can compact
  // the originating errored tool_result out of the visible window.
  if (state.forceCheckPending && !subagent) {
    const freshTurn = await userTurnIsFreshSinceLockout(input.transcript_path);
    if (freshTurn) {
      await stateManager.update((s) => ({ ...s, forceCheckPending: false }));
      state = { ...state, forceCheckPending: false };
    }
  }

  // Plan-approval intent supersession. The synthetic "User has approved your
  // plan." tool_result is wrapped in a user-role entry but is NOT a
  // UserPromptSubmit-eligible turn, so SENTIMENT_AGENT never re-runs and
  // currentPrediction.intent stays anchored to the pre-approval task.
  // Detect at PreToolUse entry, synthesize a fresh prediction, clear gate
  // reasoning so prior rule decisions (made under the stale intent) do not
  // replay. The sentinel `lastProcessedPlanApprovalToolUseId` ensures the
  // synthesis fires at most once per approval; the next UserPromptSubmit
  // resets it to null so future approvals re-fire.
  if (!subagent) {
    const approval = await findUnprocessedPlanApproval(input.transcript_path)
      .catch(() => null);
    if (approval && approval.toolUseId !== state.lastProcessedPlanApprovalToolUseId) {
      const fresh = synthesizePostApprovalPrediction(approval.approvalContent);
      await stateManager.update((s) => ({
        ...s,
        currentPrediction: fresh,
        lastProcessedPlanApprovalToolUseId: approval.toolUseId,
        frustrationStreak: 0,
        // Reset edit-intent bookkeeping the same way user-prompt-submit does
        // on a fresh prediction. We deliberately set currentEditIntent to
        // null (not true): the prior session's ExitPlanMode-allow path may
        // have set it true, but the gate LLM will re-evaluate edits against
        // the NEW synthesized intent. The edit-intent rule only fires on
        // `=== false`, so null cleanly skips it; null vs true is a minor
        // signal-strength downgrade in the gate context, not a correctness
        // issue. Choosing null over true keeps the system honest about what
        // it actually knows post-approval.
        previousEditIntent: s.currentEditIntent ?? null,
        currentEditIntent: null,
        editIntentTimestamp: Date.now(),
        editIntentOverturnCount: 0,
        respondFirstChecked: false,
      }));
      state = await stateManager.load();
      await clearGateReasoning(sessionDir);
    }
  }

  // Fail open on any detection error — falls through to normal single-tool pipeline
  let batchInfo: ParallelBatchInfo | null = null;
  try {
    batchInfo = await detectParallelBatch(input.transcript_path, input.tool_use_id);
  } catch {
    // Detection failed — treat as solo tool (safe fallback)
  }

  /**
   * Sole exit function - replaces all direct outputAllow()/outputDeny() calls.
   * Handles telemetry, tool log, gate reasoning, and output.
   */
  async function exitPipeline(exit: PipelineExit): Promise<never> {
    let assignedToolCallIndex = -1;
    if (!exit.mirroredFromLeader) {
      await stateManager.update((s) => {
        const next = { ...s, toolCallCount: s.toolCallCount + 1 };
        assignedToolCallIndex = s.toolCallCount;
        if (exit.decision === "allow" && planExit) {
          next.currentEditIntent = true as const;
          next.previousEditIntent = s.currentEditIntent ?? null;
          next.editIntentTimestamp = Date.now();
        }
        return next;
      });

      if (!subagent && assignedToolCallIndex >= 0) {
        // assignedToolCallIndex === -1 indicates stateManager.update threw inside
        // its closure (CacheManager.update silently swallows errors per
        // cache-manager.ts:351-358). Writing an entry with toolCallIndex: -1
        // would collide with every other failed-update entry and corrupt
        // updateAppealOutcome's by-index lookup. Skip the addEntry in that case.
        const usesLlm = exit.usesLlm ?? false;
        if (exit.decision === "deny" || currentGateNote || usesLlm) {
          const warnings = await addPatternWarnings(toolName, toolInput, sessionDir);
          await addEntry(sessionDir, {
            toolCallIndex: assignedToolCallIndex,
            timestamp: Date.now(),
            toolName,
            toolTarget: formatToolDetail(toolName, toolInput),
            decision: exit.decision === "allow" ? "ALLOWED" : "DENIED",
            note: currentGateNote,
            warnings,
            priority: (currentGateNote || warnings.length > 0 || exit.decision === "deny") ? "high" : "normal",
          });
        }
      }

      if (exit.decision === "allow" && planExit) {
        await clearGateReasoning(sessionDir);
        if (!subagent) {
          await writeTool(input.transcript_path, input.session_id, toolName, "Exiting plan mode.");
          await writeUser(input.transcript_path, input.session_id, toolName, "Plan approved. Proceed with implementation.");
        }
      }
    }

    // forceCheckPending clear: keyed on THIS hook's toolName, not the leader's.
    // Applies to both leader and mirrored siblings — if THIS hook is an MCP
    // commit/push/confirm/check that was allowed (directly or mirrored), it
    // satisfies the force-check lockout. Keeping this outside the
    // `!mirroredFromLeader` guard preserves today's semantics where every
    // allowed MCP-matching tool clears the flag.
    {
      const mcp = spec.recognizeMcp(rawToolName);
      if (exit.decision === "allow" && mcp && (["commit", "push", "confirm", "check"] as const).includes(mcp as "commit" | "push" | "confirm" | "check")) {
        await stateManager.update((s) => ({ ...s, forceCheckPending: false }));
      }
    }

    await appendToolLog(sessionDir, {
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

    {
      const latestState = await stateManager.load().catch(() => state);
      const snapshotSeq = appendStateSnapshot(sessionDir, latestState, input.transcript_path);
      const currentEpoch = loadCurrentEpoch(sessionDir);
      appendCapture(sessionDir, {
        ts: Date.now(),
        epoch_id: currentEpoch?.id ?? "unknown",
        parent_capture_seq: null,
        event: "PreToolUse",
        tool_use_id: input.tool_use_id,
        decision: exit.decision,
        permission_mode: input.permission_mode ?? null,
        plan_mode: {
          active: planModeDetection.active,
          mode: planModeDetection.mode,
          source: planModeDetection.source,
        },
        injection_seqs: [],
        injection_hashes: [],
        state_snapshot_seq: snapshotSeq,
      });
    }

    if (exit.decision === "allow") {
      const out = encoder.encodePreToolUseAllow();
      return exitAfterFlush(out.exitCode, out.stdout);
    }
    const out = encoder.encodePreToolUseDeny(exit.reason);
    return exitAfterFlush(out.exitCode, out.stdout);
  }

  /**
   * Shared plan-validate helper: reads plan content + transcript, calls checkPlanIntent,
   * and returns the validation result. Does NOT call exitPipeline -- caller decides.
   */
  async function runPlanValidation(
    mode: "edit" | "exit",
    currentPlan: string | null,
    overrideToolName?: string,
    overrideToolInput?: unknown,
  ): Promise<{ approved: boolean; reason?: string }> {
    return validatePlanEdit({
      currentPlan,
      toolName: (overrideToolName ?? toolName) as "Write" | "Edit",
      toolInput: (overrideToolInput ?? toolInput) as { content?: string; old_string?: string; new_string?: string },
      transcriptPath: input.transcript_path,
      projectDir,
      hookName: "PreToolUse",
      mode,
    });
  }

  if (batchInfo) {
    // Leader (position 0) always runs the full pipeline.
    // Siblings (position > 0) poll tool-log.jsonl for the leader's decision
    // and mirror it. No cross-process lock; the leader's appendToolLog is
    // an atomic POSIX append and findBatchDecision is a read-only scan.
    if (batchInfo.position > 0) {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const cached = findBatchDecision(sessionDir, batchInfo.allIds);
        if (cached) {
          const reason = cached.decision === "deny"
            ? `Error in parallel tool call: ${cached.reason}`
            : cached.reason;
          await exitPipeline({
            decision: cached.decision,
            agent: "batch-sibling",
            reason,
            mirroredFromLeader: true,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Leader crashed / never wrote. Fall through and run the pipeline
      // ourselves — bounded graceful degradation, not deadlock. This
      // matches the pre-commit behavior of waitForBatchLeader's
      // fail-open-on-timeout branch.
    }
    // Leader (position 0) falls through to the normal pipeline below.
  }

  // Deterministic outside-project-root classification.
  // - Plan files under the active adapter's plans root: handled by the
  //   existing plan-validate block below; NOT flagged here.
  // - In-project files: normal flow.
  // - Otherwise (true outside-project, e.g. /etc/hosts): flag the context so
  //   downstream LLM gates inject a harsh "be extra conservative" warning.
  //   NEVER a hard block — the task explicitly requires soft LLM review.
  let outsideRootPath: string | undefined;
  if (FILE_TOOLS.includes(toolName)) {
    for (const raw of extractFilePaths(toolName, toolInput)) {
      const abs = path.isAbsolute(raw) ? raw : path.resolve(projectDir, raw);
      if (!isPathInDirectory(abs, projectDir) && !isPlanFile(abs)) {
        outsideRootPath = abs;
        break;
      }
    }
  }

  // Pull the latest 5 user-text entries directly from the transcript. The
  // freshest is the same `latestUserMessage` the existing 3.7-path-(a)
  // re-authorization fallbacks read; the older four feed step 3.10's
  // look-back over a discharged side-clarification. Use the array helper
  // so a literal "---" inside a user message doesn't fragment.
  const recentUserMessages = await readRecentUserMessagesArray(
    input.transcript_path,
    5,
  ).catch(() => []);
  const latestUserMessage =
    recentUserMessages.length > 0
      ? recentUserMessages[recentUserMessages.length - 1]
      : "";

  // Discharge probe: was the user-text turn that produced the cached
  // prediction's snippet followed by a completed non-error tool roundtrip?
  // If yes, the cached snippet's imperative has been obeyed and step 3.10
  // may suppress the mood-driven step-4 deny when an older outer user
  // turn favorably names the firing tool.
  let cachedSnippetSideTaskDischarged = false;
  const cachedSnippet = state.currentPrediction?.userMessageSnippet ?? "";
  if (cachedSnippet) {
    cachedSnippetSideTaskDischarged =
      await userTurnFollowedByCompletedToolRoundtrip(
        input.transcript_path,
        cachedSnippet,
      ).catch(() => false);
  }

  const slashCommandAllowedTools = await resolveActiveSlashCommandAllowedTools(
    input.transcript_path,
  ).catch(() => undefined);

  // Build rule context
  const ctx: RuleContext = {
    hookEvent: "PreToolUse",
    toolName,
    rawToolName,
    toolInput,
    toolUseId: input.tool_use_id,
    projectDir,
    host,
    transcriptPath: input.transcript_path,
    sessionDir,
    sessionId: input.session_id,
    state,
    stateManager,
    planMode,
    planModeCtx,
    subagent,
    outsideRootPath,
    latestUserMessage,
    recentUserMessages,
    cachedSnippetSideTaskDischarged,
    slashCommandAllowedTools,
  };

  // Run all rules (respond-first, low-risk, plan-mode-block, subagent,
  // question-validate, prediction-block, drift-detect,
  // error-acknowledge, sensitive-path-block, edit-intent, style-drift, gate, tool-approve)
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

  // EXCEPTIONS: plan-validate and claude-md-validate run AFTER all rules pass.
  // sensitive-path-block rule (priority 58) does not apply to plan/CLAUDE.md
  // files so they always reach this point.
  if (FILE_TOOLS.includes(toolName)) {
      const filePath = extractFilePath(toolName, toolInput);

    if (filePath) {
      // Plan-validate: Write/Edit to the active adapter's plans root.
      if (
        (toolName === "Write" || toolName === "Edit") &&
        isPathInDirectory(filePath, host.plansRoot)
      ) {
        // Skip validation if the adapter's plan-exit tool was recently approved.
        const recentContext = await readTranscriptExact(
          input.transcript_path,
          APPEAL_COUNTS
        );
        const hasPlanExitApproval = recentContext.tool.some((r) => {
          const source = syntheticToolSource(r.content);
          return source !== null && spec.isPlanExit({
            event: "PreToolUse",
            canonicalToolName: source,
            rawToolName: source,
          });
        });
        if (hasPlanExitApproval) {
          logFastPathApproval("plan-exit", "PreToolUse", toolName, projectDir, "Plan exit previously approved");
          await exitPipeline({
            decision: "allow",
            agent: "plan-exit",
            reason: "Plan exit previously approved",
          });
          return;
        }

        const currentPlan = await readPlanFileContent(filePath);
        const validation = await runPlanValidation("edit", currentPlan);

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
            buildAppealUserState(state),
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

      // Host instruction-file validate: Write/Edit to any of the active
      // adapter's instruction files (Claude: CLAUDE.md; Codex: AGENTS.md and
      // CLAUDE.md). The validator handles all of them with the same prompt.
      const instructionBasenames = host.instructionFiles.map((f) => path.basename(f));
      if (
        (toolName === "Write" || toolName === "Edit") &&
        instructionBasenames.some((name) => filePath.endsWith(name))
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
            `${path.basename(filePath)} ${toolName.toLowerCase()} to ${filePath}`,
            mdTranscript,
            validation.reason || "CLAUDE.md validation failed",
            projectDir,
            "PreToolUse",
            buildAppealUserState(state),
            `claude-md-validate blocked: ${validation.reason}`
          );

          if (!appeal.overturned) {
            await exitPipeline({
              decision: "deny",
              agent: "claude-md-validate",
              reason: `${path.basename(filePath)} validation failed: ${validation.reason}`,
              usesLlm: true,
            });
            return;
          }
          currentGateNote = appeal.gateNote;
        }

        await exitPipeline({
          decision: "allow",
          agent: "claude-md-validate",
          reason: `${path.basename(filePath)} validation passed`,
          usesLlm: true,
        });
        return;
      }
    }
  }

  logFastPathApproval("all-rules", "PreToolUse", toolName, projectDir, "All checks passed");
  await exitPipeline({
    decision: "allow",
    agent: "all-rules",
    reason: "All checks passed",
  });
}
