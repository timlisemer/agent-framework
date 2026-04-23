import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import * as fs from "fs";
import * as path from "path";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import {
  getSessionDir,
  getSessionState,
  resetActiveSubagents,
  sessionStateDefaults,
} from "../utils/session-store.js";
import { withSessionLock } from "../utils/session-mutex.js";

/**
 * SessionStart Hook
 *
 * Manages session lifecycle:
 * - "startup": init session-dir + state.json
 * - "resume" / "compact": no-op (Claude Code's native compaction handles
 *   transcript continuity)
 * - "clear": delete session-dir
 */

interface SessionStartHookInput {
  source: "startup" | "resume" | "compact" | "clear";
  session_id: string;
  transcript_path: string;
}

async function main() {
  const input = await readStdinJson<SessionStartHookInput>();
  const { source, transcript_path } = input;

  // Reset subagent counter on startup -- leaked counters from crashed
  // subagents must not poison the new session
  if (source === "startup") {
    try {
      const earlySessionDir = getSessionDir(transcript_path);
      resetActiveSubagents(earlySessionDir);
    } catch {}
  }

  if (isSubagent(transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  const sessionDir = getSessionDir(transcript_path);
  const statePath = path.join(sessionDir, "state.json");

  if (source === "startup") {
    await withSessionLock(sessionDir, async () => {
      await fs.promises.mkdir(sessionDir, { recursive: true });
      if (!fs.existsSync(statePath)) {
        await getSessionState(sessionDir).save(sessionStateDefaults());
      }
    });
    exitAfterFlush(0);
    return;
  }

  if (source === "clear") {
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    exitAfterFlush(0);
    return;
  }

  // resume / compact: no-op. Claude Code's native compaction handles
  // transcript continuity; state.json / tool-log.jsonl / gate-reasoning.json
  // persist on disk untouched.
  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
