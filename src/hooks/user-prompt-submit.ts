import type { AdapterEncoder } from "../adapter/types.js";
import { dispatchUserPromptSubmit } from "../entrypoints/host-hook.js";
import { dispatchHookAndExit, exitAfterFlush } from "../utils/hook-bootstrap.js";
import type { FrameworkUserPromptSubmitHookInput } from "./types.js";

/** Thin native boundary for the canonical UserPromptSubmit command. */
export async function mainUserPromptSubmit(
  input: FrameworkUserPromptSubmitHookInput,
  encoder: AdapterEncoder,
): Promise<void> {
  return dispatchHookAndExit(input, encoder, dispatchUserPromptSubmit, exitAfterFlush);
}
