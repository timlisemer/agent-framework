import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { type PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { readStdinJson, exitAfterFlush } from "../../../src/utils/hook-bootstrap.js";
import { mainPostToolUse } from "../../../src/hooks/post-tool-use.js";
import { claudeEncoder } from "../encoder.js";

(async () => {
  const input = await readStdinJson<PostToolUseHookInput>();
  await mainPostToolUse(input, claudeEncoder);
})().catch(async (err) => {
  const out = claudeEncoder.encodeError("PostToolUse", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
