import path from "node:path";
import type { AiErrorInfo, AiMetadata, AiToolCall, AiToolOutputBlock, AiToolStatus } from "../../src/ai-protocol/index.js";
import type { AdapterSessionHistoryMessage, AdapterSessionHistoryRecord } from "../../src/adapter/types.js";
import {
  listManagedSessionRecords,
  MANAGED_SESSION_MAX_FILE_BYTES,
  readManagedSessionRecord,
  stringAt,
  type JsonObject,
} from "../shared/session-history.js";
import { readJsonlTail } from "../../src/utils/file-io.js";
import { trimmedStringField } from "../../src/utils/output.js";
import { findExistingAgentFrameworkSessionDirForTranscript, managedProviderRoot } from "../../src/utils/paths.js";
import { summarizeToolInputForUi } from "../../src/utils/tool-input-summary.js";
import { codexTranscriptCwd, codexTranscriptSessionId } from "./paths.js";
import { codexEntrySessionId } from "./transcript-metadata.js";
import {
  enrichAgentFrameworkToolMetadata,
  findRecentToolLogEntry,
  findRecentToolLogEntryMatching,
  toolLogRuntimeError,
  toolLogTerminalStatus,
} from "../../src/utils/agent-framework-tool-log.js";
import type { ToolLogEntry } from "../../src/utils/session-store.js";
import {
  codexToolLogEntryMatchesToolCall,
  interpretCodexToolOutputPayload,
  normalizeCodexToolName,
  parseCodexToolInput,
} from "./tool-payload.js";
import { codexToolLogMetadata } from "./tool-identity.js";

export async function listManagedSessions(input: {
  maxResults: number;
}): Promise<readonly AdapterSessionHistoryRecord[]> {
  return listManagedSessionRecords({
    root: path.join(managedProviderRoot("codex"), "sessions"),
    maxResults: input.maxResults,
    readRecord: readCodexSession,
  });
}

function readCodexSession(filePath: string): AdapterSessionHistoryRecord | null {
  const record = readManagedSessionRecord({
    adapterName: "codex",
    filePath,
    defaultSessionId: codexTranscriptSessionId(filePath) ?? path.basename(filePath).replace(/\.jsonl$/, ""),
    workingDirPaths: [["payload", "cwd"], ["cwd"]],
    sessionIdPaths: [],
    sessionIdFor: codexEntrySessionId,
    roleFor: (raw: JsonObject) => {
      if (stringAt(raw, ["type"]) === "event_msg" && stringAt(raw, ["payload", "type"]) === "agent_message") {
        return "assistant";
      }
      const role = stringAt(raw, ["role"]) ?? stringAt(raw, ["message", "role"]) ?? stringAt(raw, ["payload", "role"]);
      return role === "assistant" || role === "user" ? role : null;
    },
    textPaths: [["text"], ["content"], ["message", "content"], ["payload", "text"], ["payload", "content"], ["payload", "message"]],
    contentPaths: [["content"], ["message", "content"], ["payload", "content"]],
    fallbackWorkingDir: (filePath) => codexTranscriptCwd(filePath) ?? null,
    targetKeyFor: (threadId, transcriptPath) => `codex:${threadId}:${transcriptPath}`,
    resumeTargetFor: (threadId, transcriptPath) => ({ provider: "codex", target: { threadId, transcriptPath } }),
  });
  if (!record) return null;
  const messages = dedupeCodexPairedAssistantMessages(record.messages);
  const normalizedRecord = messages.length === record.messages.length ? record : { ...record, messages };
  const sessionDir = findExistingAgentFrameworkSessionDirForTranscript({
    transcriptPath: filePath,
    projectDir: normalizedRecord.workingDir,
  });
  const toolCalls = hydrateCodexToolCalls(filePath, normalizedRecord.updatedAt, sessionDir);
  return toolCalls.length > 0 ? { ...normalizedRecord, toolCalls } : normalizedRecord;
}

function dedupeCodexPairedAssistantMessages(
  messages: readonly AdapterSessionHistoryMessage[]
): AdapterSessionHistoryMessage[] {
  const deduped: AdapterSessionHistoryMessage[] = [];
  for (const message of messages) {
    const previous = deduped.at(-1);
    if (previous && isDuplicateCodexAssistantPair(previous, message)) {
      deduped[deduped.length - 1] = message;
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}

function isDuplicateCodexAssistantPair(
  previous: AdapterSessionHistoryMessage,
  next: AdapterSessionHistoryMessage
): boolean {
  return previous.role === "assistant" &&
    next.role === "assistant" &&
    previous.text === next.text &&
    previous.createdAt === next.createdAt &&
    next.sequenceId === previous.sequenceId + 1;
}

function hydrateCodexToolCalls(
  filePath: string,
  fallbackTimestamp: string | undefined,
  sessionDir: string | null
): AiToolCall[] {
  const entries = readJsonlTail<JsonObject>(filePath, MANAGED_SESSION_MAX_FILE_BYTES);
  const toolCalls: AiToolCall[] = [];
  const toolsByCallId = new Map<string, AiToolCall>();
  const pendingOutputs = new Map<string, { output: AiToolOutputBlock[]; timestamp: string; error: AiErrorInfo | null }>();
  let turnIndex = 0;

  for (const raw of entries) {
    const payload = objectField(raw, "payload");
    if (!payload) continue;
    const type = trimmedStringField(payload, "type");
    const timestamp = entryTimestamp(raw, fallbackTimestamp);

    if (type === "function_call" || type === "custom_tool_call") {
      const callId = trimmedStringField(payload, "call_id");
      if (!callId || toolsByCallId.has(callId)) continue;

      const name = normalizeCodexToolName(payload);
      const input = parseCodexToolInput(payload);
      const toolLog = sessionDir ? findCodexToolLogEntry(sessionDir, callId, name, input) : null;
      const metadata = historicalToolMetadata(toolLog, sessionDir, callId);
      const terminalStatus = toolLogTerminalStatus(toolLog);
      const error = terminalStatus ? historicalToolError(toolLog, metadata) : null;
      const toolCall: AiToolCall = {
        id: callId,
        turnId: `history-turn-${++turnIndex}`,
        name,
        input: summarizeToolInputForUi(name, input),
        ...(metadata ? { metadata } : {}),
        status: terminalStatus ?? "completed",
        wait: null,
        output: [],
        result: terminalStatus
          ? { state: terminalStatus, output: [], error }
          : { state: "completed", output: [], error: null },
        processId: null,
        progress: null,
        elapsedMs: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      };
      const pendingOutput = pendingOutputs.get(callId);
      if (pendingOutput) {
        applyHistoricalToolOutput(toolCall, pendingOutput.output, pendingOutput.timestamp, pendingOutput.error);
        pendingOutputs.delete(callId);
      }
      toolsByCallId.set(callId, toolCall);
      toolCalls.push(toolCall);
      continue;
    }

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = trimmedStringField(payload, "call_id");
      if (!callId) continue;
      const { output, error: failedOutput } = interpretCodexToolOutputPayload(payload);
      const toolCall = toolsByCallId.get(callId);
      if (toolCall) {
        applyHistoricalToolOutput(toolCall, output, timestamp, failedOutput);
      } else {
        pendingOutputs.set(callId, { output, timestamp, error: failedOutput });
      }
    }
  }

  return toolCalls;
}

function applyHistoricalToolOutput(
  toolCall: AiToolCall,
  output: AiToolOutputBlock[],
  timestamp: string,
  outputError: AiErrorInfo | null = null
): void {
  const failedState = historicalFailedResultState(toolCall.status) ?? (outputError ? "failed" : null);
  if (failedState) toolCall.status = failedState;
  toolCall.output = output;
  toolCall.result = failedState
    ? { state: failedState, output, error: toolCall.result?.error ?? outputError }
    : { state: "completed", output, error: null };
  toolCall.updatedAt = timestamp;
  toolCall.completedAt = timestamp;
}

function historicalFailedResultState(status: AiToolStatus): "denied" | "failed" | null {
  if (status === "denied") return "denied";
  if (status === "failed") return "failed";
  return null;
}

function historicalToolMetadata(
  entry: ToolLogEntry | null,
  sessionDir: string | null,
  toolUseId: string
): AiMetadata | undefined {
  return enrichAgentFrameworkToolMetadata({
    metadata: entry ? codexToolLogMetadata(entry) : undefined,
    sessionDir,
    toolUseId: entry?.toolUseId ?? toolUseId,
  });
}

function historicalToolError(entry: ToolLogEntry | null, metadata: AiMetadata | undefined): AiErrorInfo | null {
  if (!entry) return null;
  return toolLogRuntimeError(entry, metadata);
}

function findCodexToolLogEntry(
  sessionDir: string,
  callId: string,
  toolName: string,
  input: unknown
): ToolLogEntry | null {
  return findRecentToolLogEntry(sessionDir, callId) ??
    findRecentCodexToolLogEntryByIdentity(sessionDir, toolName, input);
}

function findRecentCodexToolLogEntryByIdentity(
  sessionDir: string,
  toolName: string,
  input: unknown
): ToolLogEntry | null {
  return findRecentToolLogEntryMatching(sessionDir, (entry) => codexToolLogEntryMatches(entry, toolName, input));
}

function codexToolLogEntryMatches(entry: ToolLogEntry, toolName: string, input: unknown): boolean {
  return codexToolLogEntryMatchesToolCall(entry, toolName, input);
}

function entryTimestamp(raw: JsonObject, fallbackTimestamp: string | undefined): string {
  return stringAt(raw, ["timestamp"])
    ?? stringAt(raw, ["created_at"])
    ?? stringAt(raw, ["createdAt"])
    ?? fallbackTimestamp
    ?? new Date(0).toISOString();
}

function objectField(raw: JsonObject, key: string): JsonObject | null {
  const value = raw[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
