export const AI_MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;
export const AI_MESSAGE_STATUSES = ["pending", "streaming", "completed", "failed", "cancelled"] as const;
export const AI_TOOL_STATUSES = [
  "created",
  "waiting",
  "delayed",
  "approved",
  "denied",
  "unsupported",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const AI_TOOL_RESULT_STATES = ["completed", "failed", "denied", "cancelled", "unsupported", "movedToProcess"] as const;
export const AI_ERROR_CODES = ["cancelled", "invalid_request", "not_found", "conflict", "runtime_error"] as const;
