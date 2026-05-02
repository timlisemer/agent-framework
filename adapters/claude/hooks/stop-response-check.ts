import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { readStdinJson, exitAfterFlush, initHookProcess } from "../../../src/utils/hook-bootstrap.js";
import { mainStop } from "../../../src/hooks/stop-response-check.js";
import { claudeEncoder } from "../encoder.js";

(async () => {
  const input = await readStdinJson<StopHookInput>();
  initHookProcess(input.transcript_path);
  await mainStop(input, claudeEncoder);
})().catch(async (err) => {
  const out = claudeEncoder.encodeError("Stop", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
