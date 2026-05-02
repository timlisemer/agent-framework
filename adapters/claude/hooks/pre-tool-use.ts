import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { readStdinJson, exitAfterFlush, initHookProcess } from "../../../src/utils/hook-bootstrap.js";
import { mainPreToolUse } from "../../../src/hooks/pre-tool-use.js";
import { claudeEncoder } from "../encoder.js";

(async () => {
  const input = await readStdinJson<PreToolUseHookInput>();
  initHookProcess(input.transcript_path);
  await mainPreToolUse(input, claudeEncoder);
})().catch(async (err) => {
  const fallback = claudeEncoder.encodePreToolUseDeny(
    `Hook error: ${err instanceof Error ? err.message : String(err)}.`
  );
  await exitAfterFlush(1, fallback.stdout);
});
