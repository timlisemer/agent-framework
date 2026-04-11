import "../utils/load-env.js";

import { readStdinJson } from "../utils/hook-bootstrap.js";
import { getSessionDir, decrementActiveSubagents } from "../utils/summary-cache.js";

/**
 * SubagentStop Hook
 *
 * Decrements the active subagent counter so PostToolUse resumes
 * spawning summary-updater LLM calls after subagent completes.
 */

interface SubagentStopHookInput {
  agent_id: string;
  agent_transcript_path: string;
  transcript_path: string;
  session_id: string;
  stop_hook_active: boolean;
}

async function main() {
  const input = await readStdinJson<SubagentStopHookInput>();
  const sessionDir = getSessionDir(input.transcript_path);
  try {
    decrementActiveSubagents(sessionDir, input.agent_id);
  } catch (err) {
    console.error("[subagent-stop] decrement failed:", err);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[subagent-stop]", err);
  process.exit(0);
});
