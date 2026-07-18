import type { AdapterEncoder } from "../adapter/types.js";
import { dispatchStop } from "../entrypoints/host-hook.js";
import { dispatchHookAndExit, exitAfterFlush } from "../utils/hook-bootstrap.js";
import type { FrameworkStopHookInput } from "./types.js";

/** Thin native boundary for the canonical Stop command. */
export async function mainStop(
  input: FrameworkStopHookInput,
  encoder: AdapterEncoder,
): Promise<void> {
  return dispatchHookAndExit(input, encoder, dispatchStop, exitAfterFlush);
}
