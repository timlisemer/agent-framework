import type { AiErrorInfo, AiMetadata, AiToolStatus } from "../ai-protocol/index.js";
import { AGENT_FRAMEWORK_METADATA_KEYS } from "./agent-framework-metadata.js";
import type { CapturePointer } from "../scenario/capture.js";
import { findCaptureByToolUseId } from "../scenario/capture.js";
import { readToolLogEntries, type ToolLogEntry } from "./session-store.js";

const METADATA_KEYS = AGENT_FRAMEWORK_METADATA_KEYS;

export function findRecentToolLogEntry(sessionDir: string, toolUseId: string): ToolLogEntry | null {
  return findRecentToolLogEntryMatching(sessionDir, (entry) => entry.toolUseId === toolUseId);
}

export function findRecentToolLogEntryMatching(
  sessionDir: string,
  predicate: (entry: ToolLogEntry) => boolean,
  count = 200
): ToolLogEntry | null {
  try {
    return readToolLogEntries(sessionDir, count)
      .reverse()
      .find(predicate) ?? null;
  } catch {
    return null;
  }
}

export function applyToolLogMetadata(metadata: AiMetadata, entry: ToolLogEntry): void {
  metadata[METADATA_KEYS.rule] = entry.gate;
  metadata[METADATA_KEYS.toolName] = entry.tool;
  metadata[METADATA_KEYS.toolStatus] = entry.status;
  if (entry.toolUseId) metadata[METADATA_KEYS.toolUseId] = entry.toolUseId;
  if (entry.reason) metadata[METADATA_KEYS.reason] = entry.reason;
  if (entry.path) metadata[METADATA_KEYS.path] = entry.path;
  if (entry.cmd) metadata[METADATA_KEYS.command] = entry.cmd;
  if (typeof entry.ms === "number") metadata[METADATA_KEYS.elapsedMs] = entry.ms;
  const raw = entry as unknown as Record<string, unknown>;
  copyStringMetadata(raw, metadata, "expectedStatus", METADATA_KEYS.expectedStatus);
  copyStringMetadata(raw, metadata, "expected_status", METADATA_KEYS.expectedStatus);
  copyStringMetadata(raw, metadata, "expected", METADATA_KEYS.expectedStatus);
}

export function toolLogErrorMessage(entry: ToolLogEntry): string {
  const prefix = entry.status === "denied" ? "Tool denied" : "Tool failed";
  const context = `${entry.tool}${entry.gate ? ` / ${entry.gate}` : ""}`;
  return entry.reason ? `${prefix} (${context}): ${entry.reason}` : `${prefix} (${context})`;
}

export function toolLogTerminalStatus(entry: ToolLogEntry | null | undefined): Extract<AiToolStatus, "denied" | "failed"> | null {
  if (!entry) return null;
  if (entry.status === "denied") return "denied";
  if (isToolLogFailureStatus(entry.status)) return "failed";
  return null;
}

export function isToolLogFailureStatus(status: string | null | undefined): boolean {
  return status === "failed" || status === "error";
}

export function toolLogRuntimeError(entry: ToolLogEntry, metadata?: AiMetadata): AiErrorInfo {
  return {
    code: "runtime_error",
    message: toolLogErrorMessage(entry),
    recoverable: false,
    ...(metadata ? { metadata } : {}),
  };
}

export function applyCaptureMetadata(
  metadata: AiMetadata,
  capture: CapturePointer,
  runtimeToolRef: string
): void {
  metadata[METADATA_KEYS.captureSeq] = capture.seq;
  metadata[METADATA_KEYS.hook] = capture.event;
  metadata[METADATA_KEYS.decision] = capture.decision;
  metadata[METADATA_KEYS.toolUseId] = capture.tool_use_id ?? runtimeToolRef;
  if (capture.state_snapshot_seq !== null) metadata[METADATA_KEYS.stateSnapshotSeq] = capture.state_snapshot_seq;
  if (capture.epoch_id) metadata[METADATA_KEYS.epochId] = capture.epoch_id;
  if (capture.permission_mode) metadata[METADATA_KEYS.permissionMode] = capture.permission_mode;
  if (capture.plan_mode) {
    metadata[METADATA_KEYS.planModeActive] = capture.plan_mode.active;
    metadata[METADATA_KEYS.planModeSource] = capture.plan_mode.source;
    if (capture.plan_mode.mode) metadata[METADATA_KEYS.planMode] = capture.plan_mode.mode;
  }
}

export function enrichAgentFrameworkToolMetadata(input: {
  metadata?: AiMetadata;
  sessionDir: string | null | undefined;
  toolUseId: string;
}): AiMetadata | undefined {
  const metadata: AiMetadata = { ...(input.metadata ?? {}) };
  if (input.sessionDir) {
    metadata[METADATA_KEYS.sessionDir] = input.sessionDir;
    const toolLog = findRecentToolLogEntry(input.sessionDir, input.toolUseId);
    if (toolLog) applyToolLogMetadata(metadata, toolLog);
    const capture = findCaptureByToolUseId(input.sessionDir, input.toolUseId);
    if (capture) applyCaptureMetadata(metadata, capture, input.toolUseId);
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function copyStringMetadata(
  source: Record<string, unknown>,
  target: AiMetadata,
  sourceKey: string,
  targetKey: string
): void {
  const value = source[sourceKey];
  if (typeof value === "string" && value.trim()) target[targetKey] = value;
}
