// Re-export CheckResult for backwards compatibility
export type { CheckResult } from "../types.js";

// Note: checkWithAppeal was removed in favor of direct appealHelper calls
// Each agent step now calls appealHelper directly and handles the response in TypeScript
