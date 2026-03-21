import "../utils/load-env.js";

import { readStdinJson } from "../utils/hook-bootstrap.js";
import { getSessionDir, incrementActiveSubagents } from "../utils/summary-cache.js";

/**
 * SubagentStart Hook
 *
 * Increments the active subagent counter so PostToolUse knows to skip
 * summary-updater LLM calls during subagent execution.
 */

interface SubagentStartHookInput {
  agent_id: string;
  agent_type: string;
  transcript_path: string;
  session_id: string;
}

async function main() {
  const input = await readStdinJson<SubagentStartHookInput>();
  const sessionDir = getSessionDir(input.transcript_path);
  incrementActiveSubagents(sessionDir);
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
