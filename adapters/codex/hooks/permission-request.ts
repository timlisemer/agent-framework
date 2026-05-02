import "../../../src/utils/load-env.js";
import { initializeTelemetry } from "../../../src/telemetry/index.js";
initializeTelemetry();
import { readStdinJson, exitAfterFlush, initHookProcess } from "../../../src/utils/hook-bootstrap.js";
import { mainPreToolUse } from "../../../src/hooks/pre-tool-use.js";
import { codexEncoder } from "../encoder.js";
import { initCodexEnv, toPermissionRequest, type CodexToolInput } from "./input.js";
import type { AdapterEncoder, EncodedOutput, EventName } from "../../../src/adapter/types.js";

const permissionEncoder: AdapterEncoder = {
  ...codexEncoder,
  encodePreToolUseAllow(): EncodedOutput {
    return codexEncoder.encodePermissionRequestAllow?.() ?? { stdout: "", exitCode: 0 };
  },
  encodePreToolUseDeny(reason: string): EncodedOutput {
    return codexEncoder.encodePermissionRequestDeny?.(reason) ?? codexEncoder.encodePreToolUseDeny(reason);
  },
  encodeError(_event: EventName, message: string): EncodedOutput {
    return codexEncoder.encodePermissionRequestDeny?.(message) ?? codexEncoder.encodeError("PermissionRequest", message);
  },
};

(async () => {
  const raw = await readStdinJson<CodexToolInput>();
  initCodexEnv(raw);
  const input = toPermissionRequest(raw);
  initHookProcess(input.transcript_path);
  await mainPreToolUse(
    {
      ...input,
      tool_use_id: input.tool_use_id ?? `${input.tool_name}-${Date.now()}`,
    },
    permissionEncoder
  );
})().catch(async (err) => {
  const out = permissionEncoder.encodePreToolUseDeny(
    `Hook error: ${err instanceof Error ? err.message : String(err)}.`
  );
  await exitAfterFlush(out.exitCode, out.stdout);
});
