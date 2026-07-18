import type { AdapterEncoder } from "../adapter/types.js";
import { dispatchPostToolUse } from "../entrypoints/host-hook.js";
import { dispatchHookAndExit, exitAfterFlush } from "../utils/hook-bootstrap.js";
import type { FrameworkPostToolUseHookInput } from "./types.js";

/** Thin native boundary for the canonical successful tool lifecycle command. */
export async function mainPostToolUse(
  input: FrameworkPostToolUseHookInput,
  encoder: AdapterEncoder,
): Promise<void> {
  return dispatchHookAndExit(input, encoder, dispatchPostToolUse, exitAfterFlush);
}
