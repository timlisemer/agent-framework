import type { CanonicalMcp } from "../adapter/types.js";
import { activeSpec } from "../adapter/spec.js";

export const FORCE_CHECK_SATISFYING_MCPS: ReadonlySet<CanonicalMcp> = new Set([
  "check",
  "commit",
  "confirm",
  "fullconfirm",
  "validate_implementation",
]);

export function isForceCheckSatisfyingCanonicalMcp(mcp: string | null | undefined): mcp is CanonicalMcp {
  return FORCE_CHECK_SATISFYING_MCPS.has(mcp as CanonicalMcp);
}

export function isForceCheckSatisfyingMcpToolName(toolName: string): boolean {
  if (toolName.startsWith("mcp-")) {
    return isForceCheckSatisfyingCanonicalMcp(toolName.slice(4));
  }
  return isForceCheckSatisfyingCanonicalMcp(activeSpec().recognizeMcp(toolName));
}
