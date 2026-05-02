import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getSessionDir, appendToolLog, getSessionState } from "../utils/session-store.js";
import { writeUser, writeTool, formatTodoState, extractAskUserAnswer, type TodoItem } from "../utils/synthetic.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";
import type { FrameworkPostToolUseHookInput } from "./types.js";
import { extractPathOrCmd } from "../rules/utils.js";

export async function mainPostToolUse(input: FrameworkPostToolUseHookInput, encoder: AdapterEncoder): Promise<void> {
  const subagent = isSubagent(input.transcript_path);

  if (!subagent) {
    // Log successful tool execution to JSONL
    const sessionDir = getSessionDir(input.transcript_path);
    await appendToolLog(sessionDir, {
      ts: Date.now(),
      tool: input.tool_name,
      path: extractPathOrCmd(input.tool_input).path,
      cmd: extractPathOrCmd(input.tool_input).cmd,
      status: "allowed",
      gate: "post-tool-use",
      ms: 0,
    });

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
  }

  const out = encoder.encodeOk("PostToolUse");
  await exitAfterFlush(out.exitCode, out.stdout);
}
