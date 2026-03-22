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

    // Summary-updater is spawned here for regular tool executions only.
    // Synthetic messages (from plan mode transitions, stop hook, etc.) trigger
    // summary-updater via appendSyntheticToolResult in transcript-writer.ts.
    // Do NOT add summary-updater spawning for synthetic messages here — that
    // would cause duplicate summary runs.
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
