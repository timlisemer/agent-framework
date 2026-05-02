import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush } from "../../../src/utils/hook-bootstrap.js";
import { mainPostToolUseFailure } from "../../../src/hooks/post-tool-use-failure.js";
import { claudeEncoder } from "../encoder.js";

interface PostToolUseFailureHookInput {
  tool_name: string;
  error: string;
  is_interrupt: boolean;
  transcript_path: string;
}

(async () => {
  const input = await readStdinJson<PostToolUseFailureHookInput>();
  await mainPostToolUseFailure(input, claudeEncoder);
})().catch(async (err) => {
  const out = claudeEncoder.encodeError("PostToolUseFailure", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
