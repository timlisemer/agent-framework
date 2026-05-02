import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush, initHookProcess } from "../../../src/utils/hook-bootstrap.js";
import { mainStop } from "../../../src/hooks/stop-response-check.js";
import { codexEncoder } from "../encoder.js";
import { initCodexEnv, toStop, type CodexStopInput } from "./input.js";

(async () => {
  const raw = await readStdinJson<CodexStopInput>();
  initCodexEnv(raw);
  const input = toStop(raw);
  initHookProcess(input.transcript_path);
  await mainStop(input, codexEncoder);
})().catch(async (err) => {
  const out = codexEncoder.encodeError("Stop", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
