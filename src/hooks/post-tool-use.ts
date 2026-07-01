import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { appendToolLog, getSessionState } from "../utils/session-store.js";
import { getAgentFrameworkSessionDir } from "../utils/paths.js";
import { writeUser, writeTool, formatTodoState, extractAskUserAnswer, type TodoItem } from "../utils/synthetic.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { appendCapture, capturePlanModeFromDetection } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";
import type { FrameworkPostToolUseHookInput } from "./types.js";
import { extractFilePaths, extractPathOrCmd, isPlanFile } from "../rules/utils.js";
import { activeSpec } from "../adapter/spec.js";
import { detectPlanModeForHook } from "../utils/plan-mode-detector.js";
import { extractPlanName } from "../utils/planfile.js";
import { readPlanFileContent, writeCurrentPlanSidecar } from "../utils/plan-source.js";
import { isTextEditToolName } from "../utils/edit-tools.js";
import * as path from "path";

export async function mainPostToolUse(input: FrameworkPostToolUseHookInput, encoder: AdapterEncoder): Promise<void> {
  // Log successful tool execution to JSONL
  const sessionDir = getAgentFrameworkSessionDir({ transcriptPath: input.transcript_path });
  const spec = activeSpec();
  const planModeDetection = await detectPlanModeForHook({
    spec,
    permissionMode: input.permission_mode,
    collaborationMode: input.collaboration_mode,
    transcriptPath: input.transcript_path,
    sessionDir,
  });
  const canonical = spec.canonicalizeToolCall(input.tool_name, input.tool_input);
  const canonicalPathOrCmd = extractPathOrCmd(canonical.toolInput);
  await appendToolLog(sessionDir, {
    ts: Date.now(),
    tool: canonical.toolName,
    path: canonicalPathOrCmd.path,
    paths: extractFilePaths(canonical.toolName, canonical.toolInput),
    cmd: canonicalPathOrCmd.cmd,
    status: "allowed",
    gate: "post-tool-use",
    ms: 0,
  });

  if (isTextEditToolName(canonical.toolName)) {
    for (const filePath of extractFilePaths(canonical.toolName, canonical.toolInput)) {
      if (!isPlanFile(filePath, sessionDir)) continue;
      const content = await readPlanFileContent(filePath);
      if (content?.trim()) {
        const planName = extractPlanName(content) ?? path.basename(filePath, ".md");
        writeCurrentPlanSidecar(sessionDir, {
          kind: "file",
          path: filePath,
          planName,
        });
      }
    }
  }

  const state = await getSessionState(sessionDir).load().catch(() => null);
  if (state) {
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "PostToolUse",
      tool_use_id: (input as unknown as Record<string, string>).tool_use_id,
      decision: "ok",
      permission_mode: input.permission_mode ?? null,
      plan_mode: capturePlanModeFromDetection(planModeDetection),
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
  }

  // AskUserQuestion: write user's answer as a synthetic user message
  if (input.tool_name === "AskUserQuestion") {
    const answer = extractAskUserAnswer(input.tool_response);
    if (answer) {
      await writeUser(input.transcript_path, input.session_id, "AskUserQuestion", answer);
    }
    const out = encoder.encodeOk("PostToolUse");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  // TodoWrite: write task state as a synthetic tool message
  if (input.tool_name === "TodoWrite") {
    const toolInput = input.tool_input as { todos?: Array<{ content: string; status: string; activeForm: string }> };
    if (toolInput?.todos && Array.isArray(toolInput.todos)) {
      const todoText = formatTodoState(toolInput.todos as TodoItem[]);
      if (todoText) {
        await writeTool(input.transcript_path, input.session_id, "TodoWrite", `Current tasks:\n${todoText}`);
      }
    }
    const out = encoder.encodeOk("PostToolUse");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const out = encoder.encodeOk("PostToolUse");
  await exitAfterFlush(out.exitCode, out.stdout);
}
