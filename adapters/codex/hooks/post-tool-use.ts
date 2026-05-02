import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush } from "../../../src/utils/hook-bootstrap.js";
import { mainPostToolUse } from "../../../src/hooks/post-tool-use.js";
import { codexEncoder } from "../encoder.js";
import { initCodexEnv, toPostToolUse, type CodexToolInput } from "./input.js";

(async () => {
  const raw = await readStdinJson<CodexToolInput>();
  initCodexEnv(raw);
  await mainPostToolUse(toPostToolUse(raw), codexEncoder);
})().catch(async (err) => {
  const out = codexEncoder.encodeError("PostToolUse", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
