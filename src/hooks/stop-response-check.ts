import { setTranscriptPath } from "../utils/execution-context.js";
import { writeTool } from "../utils/synthetic.js";
import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionState, readRecentToolLogPriorErrors } from "../utils/session-store.js";
import { getAgentFrameworkSessionDir } from "../utils/paths.js";
import { detectPlanModeForHook, getPlanModeContext } from "../utils/plan-mode-detector.js";
import { extractActionableToolResultFeedback, readTranscriptExact } from "../utils/transcript.js";
import { FIRST_RESPONSE_STOP_COUNTS } from "../utils/transcript-presets.js";
import { evaluateRulesForStop, ALL_RULES } from "../rules/index.js";
import { getMostRecentMessage } from "../rules/response-align-stop.js";
import type { RuleContext } from "../rules/types.js";
import type { PriorErrorContext } from "../utils/prior-error-context.js";
import type { AdapterEncoder } from "../adapter/types.js";
import type { FrameworkStopHookInput } from "./types.js";
import { resolveHostContext } from "../utils/host-context.js";
import { activeSpec } from "../adapter/spec.js";
import { validatePlanExitPresentation, writeCurrentPlanSidecar } from "../utils/plan-source.js";
import { appendCapture, capturePlanModeFromDetection } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";
import { rotateEpochIfNeeded } from "../scenario/lifecycle.js";

function priorErrorIdentity(context: PriorErrorContext): string {
  return [
    context.source,
    context.gate ?? "",
    context.tool ?? "",
    context.toolUseId ?? "",
    context.text,
  ].join("\0");
}

function mergePriorErrorContexts(
  transcriptContexts: readonly PriorErrorContext[],
  toolLogContexts: readonly PriorErrorContext[],
): PriorErrorContext[] {
  const merged = new Map<string, PriorErrorContext>();
  for (const context of [...transcriptContexts, ...toolLogContexts]) {
    const key = priorErrorIdentity(context);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...context, provenance: [...context.provenance] });
      continue;
    }
    merged.set(key, {
      ...existing,
      provenance: [...new Set([...existing.provenance, ...context.provenance])],
      gate: context.gate ?? existing.gate,
      tool: context.tool ?? existing.tool,
      toolUseId: context.toolUseId ?? existing.toolUseId,
      index: context.index ?? existing.index,
      ts: Math.max(existing.ts ?? 0, context.ts ?? 0) || undefined,
      isError: existing.isError === true || context.isError === true ? true : undefined,
    });
  }

  const all = [...merged.values()];
  const transcriptKeys = new Set(transcriptContexts.map(priorErrorIdentity));
  const transcriptOnly = all.filter((context) => transcriptKeys.has(priorErrorIdentity(context)));
  const toolLogOnly = all
    .filter((context) => !transcriptKeys.has(priorErrorIdentity(context)))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    .slice(-10);
  const transcriptOrdered = transcriptOnly.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // Keep sources in explicit precedence order instead of comparing transcript
  // line indexes with wall-clock timestamps. The evaluator scans this list from
  // the end, so current transcript feedback wins over supplemental tool-log-only
  // context whenever both are present.
  return [...toolLogOnly, ...transcriptOrdered];
}

/**
 * Stop Hook: Response Check
 *
 * This hook runs when the AI stops (text-only response, no tool calls).
 * Bootstraps the rule pipeline for Stop-eligible rules (responseAlignStopRule).
 */

export async function mainStop(input: FrameworkStopHookInput, encoder: AdapterEncoder): Promise<void> {
  const host = resolveHostContext(input);
  setTranscriptPath(input.transcript_path);
  if (
    process.env.AGENT_FRAMEWORK_DISABLE_STOP_BLOCK === "1" &&
    process.env.AGENT_FRAMEWORK_RUNTIME_PROFILE === "internalWrite"
  ) {
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath: input.transcript_path });
    try {
      const state = await getSessionState(sessionDir).load().catch(() => undefined);
      if (state) appendStateSnapshot(sessionDir, state, input.transcript_path);
    } catch {
      // best-effort internal write capture
    }
    const out = encoder.encodeStopPass();
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }
  const sessionDir = getAgentFrameworkSessionDir({ transcriptPath: input.transcript_path });

  await rotateEpochIfNeeded(sessionDir, input.transcript_path);

  const stateManager = getSessionState(sessionDir);
  const state = await stateManager.load();

  const spec = activeSpec();
  const planModeDetection = await detectPlanModeForHook({
    spec,
    permissionMode: input.permission_mode,
    collaborationMode: input.collaboration_mode,
    transcriptPath: input.transcript_path,
    sessionDir,
  });
  const planMode = planModeDetection.active;

  const tx = await readTranscriptExact(input.transcript_path, FIRST_RESPONSE_STOP_COUNTS);
  const assistantText = input.last_assistant_message ??
    (tx.assistant.length > 0 ? getMostRecentMessage(tx.assistant).content : null);
  const transcriptAssistantTexts = [...tx.assistant]
    .sort((a, b) => b.index - a.index)
    .map((message) => message.content);
  const planExitText = [
    input.last_assistant_message,
    ...(tx.assistantTextCandidates ?? []),
    ...transcriptAssistantTexts,
  ].find((candidate) => spec.isPlanExit({ event: "Stop", assistantText: candidate ?? null })) ?? null;
  const stopPlanExit = planExitText !== null;
  if (stopPlanExit && !planModeDetection.active) {
    const reason = "Proposed plan block emitted outside plan mode.";
    const epoch = loadCurrentEpoch(sessionDir);
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "Stop",
      decision: "block",
      permission_mode: input.permission_mode ?? null,
      plan_mode: capturePlanModeFromDetection(planModeDetection),
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
    const out = encoder.encodeStopBlock(reason);
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  if (stopPlanExit) {
    const validation = await validatePlanExitPresentation({
      transcriptPath: input.transcript_path,
      sessionDir,
      projectDir: host.projectDir,
      hookName: "Stop",
      assistantText: planExitText,
    });
    const epoch = loadCurrentEpoch(sessionDir);
    if (!validation.approved) {
      const reason = `Plan validation failed: ${validation.reason}`;
      await writeTool(input.transcript_path, input.session_id, "plan-validate", reason);
      const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
      appendCapture(sessionDir, {
        ts: Date.now(),
        epoch_id: epoch?.id ?? "unknown",
        parent_capture_seq: null,
        event: "Stop",
        decision: "block",
        permission_mode: input.permission_mode ?? null,
        plan_mode: capturePlanModeFromDetection(planModeDetection),
        injection_seqs: [],
        injection_hashes: [],
        state_snapshot_seq: snapshotSeq,
      });
      const out = encoder.encodeStopBlock(reason);
      await exitAfterFlush(out.exitCode, out.stdout);
      return;
    }
    if (validation.source?.kind === "file") {
      writeCurrentPlanSidecar(sessionDir, validation.source);
    }
  }

  if (tx.user.length === 0 || tx.assistant.length === 0) {
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "Stop",
      decision: "pass",
      permission_mode: input.permission_mode ?? null,
      plan_mode: capturePlanModeFromDetection(planModeDetection),
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
    const out = encoder.encodeStopPass();
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const ctx: RuleContext = {
    hookEvent: "Stop",
    toolName: "",
    projectDir: host.projectDir,
    host,
    transcriptPath: input.transcript_path,
    sessionDir,
    sessionId: input.session_id,
    state,
    stateManager,
    planMode,
    planModeCtx: getPlanModeContext(planMode),
    assistantText: assistantText ?? getMostRecentMessage(tx.assistant).content,
    userText: getMostRecentMessage(tx.user).content,
    priorErrorContext: mergePriorErrorContexts(
      extractActionableToolResultFeedback(tx.tool),
      readRecentToolLogPriorErrors(sessionDir, 25, {
        sinceTs: state.lastUserMessageTimestamp || undefined,
        onlyUnresolvedSinceSuccess: true,
      }),
    ),
  };

  const result = await evaluateRulesForStop(ALL_RULES, ctx);

  const epoch = loadCurrentEpoch(sessionDir);

  if (result.decision === "block" && result.systemMessage) {
    await writeTool(input.transcript_path, input.session_id, "response-align-stop", result.systemMessage);
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "Stop",
      decision: "block",
      permission_mode: input.permission_mode ?? null,
      plan_mode: capturePlanModeFromDetection(planModeDetection),
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
    const out = encoder.encodeStopBlock(result.systemMessage);
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
  appendCapture(sessionDir, {
    ts: Date.now(),
    epoch_id: epoch?.id ?? "unknown",
    parent_capture_seq: null,
    event: "Stop",
    decision: "pass",
    permission_mode: input.permission_mode ?? null,
    plan_mode: capturePlanModeFromDetection(planModeDetection),
    injection_seqs: [],
    injection_hashes: [],
    state_snapshot_seq: snapshotSeq,
  });
  const out = encoder.encodeStopPass();
  await exitAfterFlush(out.exitCode, out.stdout);
}
