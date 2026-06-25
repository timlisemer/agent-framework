import type { AiErrorInfo, AiMetadata, AiToolStatus } from "../ai-protocol/index.js";
import type { CapturePointer } from "../scenario/capture.js";
import { findCaptureByToolUseId } from "../scenario/capture.js";
import { createJsonlTailReader } from "./file-io.js";
import { readToolLogEntries, type ToolLogEntry } from "./session-store.js";

export type ToolLogTailReader = {
  read(): ToolLogEntry[];
};

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
  metadata.agentFrameworkRule = entry.gate;
  metadata.agentFrameworkToolName = entry.tool;
  metadata.agentFrameworkToolStatus = entry.status;
  if (entry.toolUseId) metadata.agentFrameworkToolUseId = entry.toolUseId;
  if (entry.reason) metadata.agentFrameworkReason = entry.reason;
  if (entry.path) metadata.agentFrameworkPath = entry.path;
  if (entry.cmd) metadata.agentFrameworkCommand = entry.cmd;
  if (typeof entry.ms === "number") metadata.agentFrameworkElapsedMs = entry.ms;
  const raw = entry as unknown as Record<string, unknown>;
  copyStringMetadata(raw, metadata, "expectedStatus", "agentFrameworkExpectedStatus");
  copyStringMetadata(raw, metadata, "expected_status", "agentFrameworkExpectedStatus");
  copyStringMetadata(raw, metadata, "expected", "agentFrameworkExpectedStatus");
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

export function toolLogHookName(entry: ToolLogEntry): string {
  if (entry.gate === "post-tool-use") return "PostToolUse";
  if (entry.gate === "system" && isToolLogFailureStatus(entry.status)) {
    return "PostToolUseFailure";
  }
  return "PreToolUse";
}

export function isLiveToolLogStatus(status: string): boolean {
  return status === "allowed" || status === "denied" || isToolLogFailureStatus(status);
}

export function isToolLogFailureStatus(status: string | null | undefined): boolean {
  return status === "failed" || status === "error";
}

export function buildAgentFrameworkToolLogUiMetadata(input: {
  entry: ToolLogEntry;
  provider: string;
  providerItemId: string;
  providerItemType: string;
  canonicalToolName?: string;
  toolSignature?: string;
}): AiMetadata {
  const metadata: AiMetadata = {
    provider: input.provider,
    providerItemId: input.providerItemId,
    providerItemType: input.providerItemType,
    agentFrameworkHook: toolLogHookName(input.entry),
  };
  if (input.canonicalToolName) metadata.agentFrameworkCanonicalToolName = input.canonicalToolName;
  if (input.toolSignature) metadata.agentFrameworkToolSignature = input.toolSignature;
  applyToolLogMetadata(metadata, input.entry);
  if (input.entry.status === "allowed") metadata.agentFrameworkDecision = "allow";
  if (input.entry.status === "denied") metadata.agentFrameworkDecision = "deny";
  return metadata;
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
  metadata.agentFrameworkCaptureSeq = capture.seq;
  metadata.agentFrameworkHook = capture.event;
  metadata.agentFrameworkDecision = capture.decision;
  metadata.agentFrameworkToolUseId = capture.tool_use_id ?? runtimeToolRef;
  if (capture.state_snapshot_seq !== null) metadata.agentFrameworkStateSnapshotSeq = capture.state_snapshot_seq;
  if (capture.epoch_id) metadata.agentFrameworkEpochId = capture.epoch_id;
  if (capture.permission_mode) metadata.agentFrameworkPermissionMode = capture.permission_mode;
  if (capture.plan_mode) {
    metadata.agentFrameworkPlanModeActive = capture.plan_mode.active;
    metadata.agentFrameworkPlanModeSource = capture.plan_mode.source;
    if (capture.plan_mode.mode) metadata.agentFrameworkPlanMode = capture.plan_mode.mode;
  }
}

export function enrichAgentFrameworkToolMetadata(input: {
  metadata?: AiMetadata;
  sessionDir: string | null | undefined;
  toolUseId: string;
}): AiMetadata | undefined {
  const metadata: AiMetadata = { ...(input.metadata ?? {}) };
  if (input.sessionDir) {
    metadata.agentFrameworkSessionDir = input.sessionDir;
    const toolLog = findRecentToolLogEntry(input.sessionDir, input.toolUseId);
    if (toolLog) applyToolLogMetadata(metadata, toolLog);
    const capture = findCaptureByToolUseId(input.sessionDir, input.toolUseId);
    if (capture) applyCaptureMetadata(metadata, capture, input.toolUseId);
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function createToolLogTailReader(filePath: string, opts?: { offset?: number; minTimestamp?: number }): ToolLogTailReader {
  const reader = createJsonlTailReader(filePath, parseToolLogEntry, { offset: opts?.offset });

  return {
    read(): ToolLogEntry[] {
      const entries = reader.read();
      return opts?.minTimestamp === undefined
        ? entries
        : entries.filter((entry) => entry.ts >= opts.minTimestamp!);
    },
  };
}

function parseToolLogEntry(line: string): ToolLogEntry | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object") return null;
    const entry = value as Partial<ToolLogEntry>;
    if (typeof entry.ts !== "number" || typeof entry.tool !== "string" || typeof entry.status !== "string") {
      return null;
    }
    return entry as ToolLogEntry;
  } catch {
    return null;
  }
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
