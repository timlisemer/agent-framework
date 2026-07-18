import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush, initHookProcess } from "../../../src/utils/hook-bootstrap.js";
import { mainUserPromptSubmit } from "../../../src/hooks/user-prompt-submit.js";
import { claudeEncoder } from "../encoder.js";

interface UserPromptSubmitHookInput {
  prompt: string;
  transcript_path: string;
  session_id: string;
  delivery_id?: string;
  permission_mode?: string;
}

(async () => {
  const input = await readStdinJson<UserPromptSubmitHookInput>();
  initHookProcess(input.transcript_path);
  await mainUserPromptSubmit(input, claudeEncoder);
})().catch(async (err) => {
  const out = claudeEncoder.encodeError("UserPromptSubmit", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
