import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { readStdinJson } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getSessionDir, appendToolLog } from "../utils/session-store.js";
import { writeUser, writeTool, formatTodoState, extractAskUserAnswer, type TodoItem } from "../utils/synthetic.js";

async function main() {
  const input = await readStdinJson<PostToolUseHookInput>();

  if (!isSubagent(input.transcript_path)) {
    // Log successful tool execution to JSONL
    const sessionDir = getSessionDir(input.transcript_path);
    appendToolLog(sessionDir, {
      ts: Date.now(),
      tool: input.tool_name,
      path: (input.tool_input as Record<string, unknown>)?.file_path as string | undefined,
      cmd: (input.tool_input as Record<string, unknown>)?.command as string | undefined,
      status: "allowed",
      gate: "post-tool-use",
      ms: 0,
    });

    // AskUserQuestion: write user's answer as a synthetic user message
    if (input.tool_name === "AskUserQuestion") {
      const answer = extractAskUserAnswer((input as Record<string, unknown>).tool_response);
      if (answer) {
        await writeUser(input.transcript_path, input.session_id, "AskUserQuestion", answer);
      }
      process.exit(0);
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
      process.exit(0);
      return;
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
