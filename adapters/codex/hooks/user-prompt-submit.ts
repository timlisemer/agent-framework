import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush, initHookProcess } from "../../../src/utils/hook-bootstrap.js";
import { mainUserPromptSubmit } from "../../../src/hooks/user-prompt-submit.js";
import { codexEncoder } from "../encoder.js";
import { initCodexEnv, toUserPromptSubmit, type CodexPromptInput } from "./input.js";

(async () => {
  const raw = await readStdinJson<CodexPromptInput>();
  initCodexEnv(raw);
  const input = toUserPromptSubmit(raw);
  initHookProcess(input.transcript_path);
  await mainUserPromptSubmit(input, codexEncoder);
})().catch(async (err) => {
  const out = codexEncoder.encodeError("UserPromptSubmit", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
