import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush } from "../../../src/utils/hook-bootstrap.js";
import { mainSubagentStart } from "../../../src/hooks/subagent-start.js";
import { claudeEncoder } from "../encoder.js";

interface SubagentStartHookInput {
  agent_id: string;
  agent_type: string;
  transcript_path: string;
  session_id: string;
}

(async () => {
  const input = await readStdinJson<SubagentStartHookInput>();
  await mainSubagentStart(input, claudeEncoder);
})().catch(async (err) => {
  const out = claudeEncoder.encodeError("SubagentStart", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
