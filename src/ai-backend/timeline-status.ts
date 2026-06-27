import type {
  AiBackendProcessStatus,
  AiMessageStatus,
  AiSessionStatus,
  AiToolStatus,
} from "../ai-protocol/index.js";

const ACTIVE_SESSION_STATUSES = new Set<AiSessionStatus>(["running", "waiting"]);
const ACTIVE_MESSAGE_STATUSES = new Set<AiMessageStatus>(["pending", "streaming"]);
const DANGLING_MESSAGE_STATUSES = new Set<AiMessageStatus>(["streaming"]);
const ACTIVE_TOOL_STATUSES = new Set<AiToolStatus>(["created", "waiting", "delayed", "approved", "running"]);
const DANGLING_TOOL_STATUSES = new Set<AiToolStatus>(["created", "delayed", "approved", "running"]);
const ACTIVE_BACKEND_PROCESS_STATUSES = new Set<AiBackendProcessStatus>(["created", "running"]);

export function isActiveSessionStatus(status: AiSessionStatus): boolean {
  return ACTIVE_SESSION_STATUSES.has(status);
}

export function isActiveMessageStatus(status: AiMessageStatus): boolean {
  return ACTIVE_MESSAGE_STATUSES.has(status);
}

export function isDanglingMessageStatus(status: AiMessageStatus): boolean {
  return DANGLING_MESSAGE_STATUSES.has(status);
}

export function isActiveToolStatus(status: AiToolStatus): boolean {
  return ACTIVE_TOOL_STATUSES.has(status);
}

export function isDanglingToolStatus(status: AiToolStatus): boolean {
  return DANGLING_TOOL_STATUSES.has(status);
}

export function isActiveBackendProcessStatus(status: AiBackendProcessStatus): boolean {
  return ACTIVE_BACKEND_PROCESS_STATUSES.has(status);
}
