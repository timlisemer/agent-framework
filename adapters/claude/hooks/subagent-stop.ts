import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush } from "../../../src/utils/hook-bootstrap.js";
import { mainSubagentStop } from "../../../src/hooks/subagent-stop.js";
import { claudeEncoder } from "../encoder.js";

interface SubagentStopHookInput {
  agent_id: string;
  agent_transcript_path: string;
  transcript_path: string;
  session_id: string;
  stop_hook_active: boolean;
}

(async () => {
  const input = await readStdinJson<SubagentStopHookInput>();
  await mainSubagentStop(input, claudeEncoder);
})().catch(async (err) => {
  const out = claudeEncoder.encodeError("SubagentStop", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
