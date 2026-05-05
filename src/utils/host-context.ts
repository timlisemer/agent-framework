/**
 * Host context — pure delegate to the active adapter spec.
 *
 * All path/config knowledge lives in adapters/<name>/host-context.ts.
 * This module is a thin pass-through that generic code imports.
 *
 * @module utils/host-context
 */

import { activeSpec } from "../adapter/spec.js";
export type { HostContext } from "../adapter/types.js";

export function resolveHostContext(input?: { cwd?: string }): import("../adapter/types.js").HostContext {
  return activeSpec().resolveHostContext(input ?? {});
}
