import { dispatchHookAndExit, exitAfterFlush } from "../utils/hook-bootstrap.js";
import type { AdapterEncoder } from "../adapter/types.js";
import type { FrameworkPreToolUseHookInput } from "./types.js";
import { dispatchPreToolUse } from "../entrypoints/host-hook.js";

/** Native hook boundary: parse/canonicalize, dispatch, encode. */
export async function mainPreToolUse(
  input: FrameworkPreToolUseHookInput,
  encoder: AdapterEncoder,
): Promise<void> {
  return dispatchHookAndExit(input, encoder, dispatchPreToolUse, exitAfterFlush);
}
