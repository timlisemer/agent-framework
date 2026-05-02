import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush } from "../../../src/utils/hook-bootstrap.js";
import { mainSessionStart } from "../../../src/hooks/session-start.js";
import { claudeEncoder } from "../encoder.js";

interface SessionStartHookInput {
  source: "startup" | "resume" | "compact" | "clear";
  session_id: string;
  transcript_path: string;
}

(async () => {
  const input = await readStdinJson<SessionStartHookInput>();
  await mainSessionStart(input, claudeEncoder);
})().catch(async (err) => {
  const out = claudeEncoder.encodeError("SessionStart", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
