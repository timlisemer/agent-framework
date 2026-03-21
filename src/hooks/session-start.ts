import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import {
  getSummaryPath,
  getSessionDir,
  createEmptySummary,
  readSummary,
  getSessionState,
  deleteSummary,
} from "../utils/summary-cache.js";

/**
 * SessionStart Hook
 *
 * Manages session lifecycle:
 * - "startup": create empty summary, init session-dir
 * - "resume": re-inject summary as additionalContext
 * - "compact": re-inject summary (force-updated by PreCompact)
 * - "clear": delete summary + session-dir
 */

interface SessionStartHookInput {
  source: "startup" | "resume" | "compact" | "clear";
  session_id: string;
  transcript_path: string;
}

const MAX_SUMMARY_SIZE = 4096;

async function main() {
  const input = await readStdinJson<SessionStartHookInput>();
  const { source, session_id, transcript_path } = input;

  // No summary system for subagents
  if (isSubagent(transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  const summaryPath = await getSummaryPath(transcript_path, session_id);
  const sessionDir = getSessionDir(transcript_path);

  if (source === "startup") {
    await createEmptySummary(summaryPath);
    // Init session state
    const stateManager = getSessionState(sessionDir);
    await stateManager.save({
      lastUserMessageHash: "",
      summaryVersion: 0,
      toolCallCount: 0,
      toolCallsSinceUpdate: 0,
      lastUpdated: Date.now(),
      currentEditIntent: null,
      previousEditIntent: null,
      editIntentTimestamp: 0,
      editIntentOverturnCount: 0,
    });
    exitAfterFlush(0);
    return;
  }

  if (source === "resume" || source === "compact") {
    try {
      const summary = await readSummary(summaryPath);
      let content = `## User Intent\n${summary.userIntent}\n\n## User Approvals\n${summary.userApprovals}\n\n## AI Actions\n${summary.aiActions}\n\n## Flagged Misalignments\n${summary.flaggedMisalignments}`;

      // Cap at MAX_SUMMARY_SIZE
      if (content.length > MAX_SUMMARY_SIZE) {
        // Trim AI Actions (oldest entries) to fit
        const trimmedActions = summary.aiActions.split("\n").slice(-5).join("\n");
        content = `## User Intent\n${summary.userIntent}\n\n## User Approvals\n${summary.userApprovals}\n\n## AI Actions\n${trimmedActions}\n\n## Flagged Misalignments\n${summary.flaggedMisalignments}`;
        if (content.length > MAX_SUMMARY_SIZE) {
          content = content.slice(0, MAX_SUMMARY_SIZE);
        }
      }

      // Check if PreCompact may have failed (for compact source)
      if (source === "compact") {
        const stateManager = getSessionState(sessionDir);
        const state = await stateManager.load();
        if (state.toolCallsSinceUpdate > 10) {
          content = "[SUMMARY MAY BE INCOMPLETE]\n\n" + content;
        }
      }

      const output = JSON.stringify({ additionalContext: content });
      exitAfterFlush(0, output);
      return;
    } catch {
      // No summary exists - exit without additionalContext
      exitAfterFlush(0);
      return;
    }
  }

  if (source === "clear") {
    await deleteSummary(transcript_path);
    exitAfterFlush(0);
    return;
  }

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
