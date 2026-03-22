import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { isSubagent } from "./subagent-detector.js";
import { getSessionDir, appendToolLog, getActiveSubagentCount } from "./summary-cache.js";
import { spawnBackground } from "./spawn-background.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Transcript Writer - Synthetic Entry Injection
 *
 * Appends synthetic tool_result entries to the transcript file so that
 * hook outputs (like stop hook systemMessage) become visible to agents
 * reading the transcript.
 *
 * WITHOUT this, stop hook feedback is injected by Claude Code as system
 * messages and doesn't appear in transcripts - agents can't see previous
 * hook feedback.
 *
 * IMPORTANT — Summary integration:
 * All synthetic messages flow through this function to reach the summary system.
 * This is the ONLY place where SyntheticMessage entries are logged to the tool log
 * and summary-updater is spawned for synthetic content. Callers must NOT separately
 * log SyntheticMessage or spawn summary-updater — doing so would cause duplicate
 * summary runs.
 *
 * @module transcript-writer
 */

/**
 * Append a synthetic tool_result entry to the transcript, log it to the tool log,
 * and trigger summary-updater.
 *
 * This is the centralized entry point for all synthetic messages into the summary
 * system. Do NOT log SyntheticMessage entries or spawn summary-updater outside of
 * this function — that would cause duplicate summary runs for the same action.
 *
 * NOTE: We omit tool_use_id since this is a synthetic entry with no corresponding
 * tool_use block. The tool name is embedded in the content prefix instead.
 *
 * @param transcriptPath - Path to the transcript JSONL file
 * @param hookName - Name of the hook generating this message (e.g., "Stop", "PlanMode")
 * @param message - The message content to inject
 * @param sessionId - Claude Code session ID (for summary-updater)
 */
export async function appendSyntheticToolResult(
  transcriptPath: string,
  hookName: string,
  message: string,
  sessionId: string
): Promise<void> {
  // 1. Append synthetic entry to transcript JSONL
  const entry = {
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          // No tool_use_id - synthetic entry, no corresponding tool_use block
          content: `[${hookName} Hook Feedback]\n${message}`,
        },
      ],
    },
  };
  await fs.promises.appendFile(transcriptPath, JSON.stringify(entry) + "\n");

  // 2. Log to tool log and trigger summary-updater (main agent only).
  //    This is the ONLY place SyntheticMessage entries enter the summary pipeline.
  //    Callers must not duplicate this — no separate appendToolLog or spawnBackground.
  if (!isSubagent(transcriptPath)) {
    const sessionDir = getSessionDir(transcriptPath);
    appendToolLog(sessionDir, {
      ts: Date.now(),
      tool: "SyntheticMessage",
      status: "allowed",
      gate: hookName,
      reason: message.slice(0, 200),
      ms: 0,
    });

    const activeSubagents = getActiveSubagentCount(sessionDir);
    if (activeSubagents === 0) {
      const updaterPath = path.join(__dirname, "summary-updater.js");
      spawnBackground(updaterPath, [
        "--mode", "actions",
        "--transcript", transcriptPath,
        "--session-id", sessionId,
      ]);
    }
  }
}
