import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import * as path from "path";
import { fileURLToPath } from "url";
import { type PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { readStdinJson } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { spawnBackground } from "../utils/spawn-background.js";
import { getSessionDir, appendToolLog, getActiveSubagentCount } from "../utils/summary-cache.js";
import { writeUser, writeTool, formatTodoState, extractAskUserAnswer, type TodoItem } from "../utils/synthetic.js";
import { getAllPredictions, matchBlockedTool } from "../utils/prediction-cache.js";
import { writeCorrection } from "../utils/correction-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    // Post-tool prediction validation: catch violations from predictions that arrived late
    const predictions = await getAllPredictions(sessionDir);
    for (const pred of predictions) {
      const match = matchBlockedTool(input.tool_name, input.tool_input, pred.blockedTools);
      if (match) {
        await writeCorrection(sessionDir, {
          toolName: input.tool_name,
          toolTarget: (input.tool_input as Record<string, unknown>)?.file_path as string
            || (input.tool_input as Record<string, unknown>)?.command as string || "",
          reason: `Tool ${input.tool_name} violated prediction: ${match.reason}`,
          source: "post-tool",
          timestamp: Date.now(),
          consumed: false,
        });
        break;
      }
    }

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

    // Regular tools: spawn summary-updater
    const activeSubagents = getActiveSubagentCount(sessionDir);
    if (activeSubagents === 0) {
      const updaterPath = path.join(__dirname, "../utils/summary-updater.js");
      spawnBackground(updaterPath, [
        "--mode", "actions",
        "--transcript", input.transcript_path,
        "--session-id", input.session_id,
      ], { dedupKey: "summary-updater-actions", sessionDir });
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
