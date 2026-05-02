import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush, initHookProcess } from "../../../src/utils/hook-bootstrap.js";
import { mainPreToolUse } from "../../../src/hooks/pre-tool-use.js";
import { codexEncoder } from "../encoder.js";
import { initCodexEnv, toPreToolUse, type CodexToolInput } from "./input.js";

(async () => {
  const raw = await readStdinJson<CodexToolInput>();
  initCodexEnv(raw);
  const input = toPreToolUse(raw);
  initHookProcess(input.transcript_path);
  await mainPreToolUse(input, codexEncoder);
})().catch(async (err) => {
  const out = codexEncoder.encodePreToolUseDeny(
    `Hook error: ${err instanceof Error ? err.message : String(err)}.`
  );
  await exitAfterFlush(out.exitCode, out.stdout);
});
