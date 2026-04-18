import "../utils/load-env.js";

import { readStdinJson } from "../utils/hook-bootstrap.js";
import { getSessionDir, incrementActiveSubagents } from "../utils/session-store.js";

/**
 * SubagentStart Hook
 *
 * Increments the active subagent counter.
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
  incrementActiveSubagents(sessionDir, input.agent_id);
  process.exit(0);
}

main().catch((err) => {
  console.error("[subagent-start]", err);
  process.exit(0);
});
