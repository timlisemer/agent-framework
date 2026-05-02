import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush } from "../../../src/utils/hook-bootstrap.js";
import { mainSessionStart } from "../../../src/hooks/session-start.js";
import { codexEncoder } from "../encoder.js";
import { initCodexEnv, sessionId, transcriptPath, type CodexSessionStartInput } from "./input.js";

(async () => {
  const raw = await readStdinJson<CodexSessionStartInput>();
  initCodexEnv(raw);
  await mainSessionStart(
    {
      source: raw.source ?? "startup",
      session_id: sessionId(raw),
      transcript_path: transcriptPath(raw),
    },
    codexEncoder
  );
})().catch(async (err) => {
  const out = codexEncoder.encodeError("SessionStart", String(err));
  await exitAfterFlush(out.exitCode, out.stdout);
});
