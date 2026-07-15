import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush } from "../../../src/utils/hook-bootstrap.js";
import { mainPostToolUseFailure } from "../../../src/hooks/post-tool-use-failure.js";
import { codexEncoder } from "../encoder.js";
import {
  initCodexEnv,
  toPostToolUseFailure,
  type CodexFailureInput,
} from "./input.js";

(async () => {
  const raw = await readStdinJson<CodexFailureInput>();
  initCodexEnv(raw);
  await mainPostToolUseFailure(toPostToolUseFailure(raw), codexEncoder);
})().catch(async (err) => {
  const out = codexEncoder.encodeError("PostToolUseFailure", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
