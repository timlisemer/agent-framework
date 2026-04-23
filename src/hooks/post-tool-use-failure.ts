import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getSessionDir, appendToolLog } from "../utils/session-store.js";
import { withSessionLock } from "../utils/session-mutex.js";

/**
 * PostToolUseFailure Hook
 *
 * Logs tool failures to the session JSONL tool log.
 */

interface PostToolUseFailureHookInput {
  tool_name: string;
  error: string;
  is_interrupt: boolean;
  transcript_path: string;
}

async function main() {
  const input = await readStdinJson<PostToolUseFailureHookInput>();

  // Skip subagents and interrupts
  if (isSubagent(input.transcript_path) || input.is_interrupt) {
    exitAfterFlush(0);
    return;
  }

  const sessionDir = getSessionDir(input.transcript_path);
  await withSessionLock(sessionDir, async () => {
    await appendToolLog(sessionDir, {
      ts: Date.now(),
      tool: input.tool_name,
      status: "failed",
      gate: "system",
      reason: input.error?.slice(0, 200),
      ms: 0,
    });
  });

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
