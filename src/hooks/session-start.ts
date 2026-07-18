import type { AdapterEncoder } from "../adapter/types.js";
import { dispatchSessionStart } from "../entrypoints/host-hook.js";
import { dispatchHookAndExit, exitAfterFlush } from "../utils/hook-bootstrap.js";
import type { FrameworkSessionStartHookInput } from "./types.js";

export type SessionStartHookInput = FrameworkSessionStartHookInput;

/** Thin native boundary for canonical host-session lifecycle commands. */
export async function mainSessionStart(
  input: SessionStartHookInput,
  encoder: AdapterEncoder,
): Promise<void> {
  return dispatchHookAndExit(input, encoder, dispatchSessionStart, exitAfterFlush);
}
