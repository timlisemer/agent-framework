import type { AdapterEncoder } from "../adapter/types.js";
import { dispatchPostToolUseFailure } from "../entrypoints/host-hook.js";
import { dispatchHookAndExit, exitAfterFlush } from "../utils/hook-bootstrap.js";
import type { FrameworkPostToolUseFailureHookInput } from "./types.js";

/** Thin native boundary for canonical failed/cancelled tool lifecycle commands. */
export async function mainPostToolUseFailure(
  input: FrameworkPostToolUseFailureHookInput,
  encoder: AdapterEncoder,
): Promise<void> {
  return dispatchHookAndExit(input, encoder, dispatchPostToolUseFailure, exitAfterFlush);
}
