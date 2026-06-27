import fs from "node:fs";
import type {
  ContentBlock,
  TranscriptEntry,
  TranscriptSource,
} from "../adapter/types.js";
import {
  type AiErrorInfo,
  type AiMetadata,
  type AiProviderMetadataState,
  type AiTimelineSeq,
  type AiToolCall,
  type AiTranscriptEntry,
  type TokenUsage,
  type TurnId,
} from "../ai-protocol/index.js";
import { AGENT_FRAMEWORK_METADATA_KEYS } from "../utils/agent-framework-metadata.js";
import { hashSha256Prefix, stableJsonStringify } from "../utils/hash-utils.js";
import { summarizeToolInputForUi } from "../utils/tool-input-summary.js";
import {
  applyToolLogMetadata,
  enrichAgentFrameworkToolMetadata,
  toolLogRuntimeError,
  toolLogTerminalStatus,
} from "../utils/agent-framework-tool-log.js";
import { readToolLogEntries, type ToolLogEntry } from "../utils/session-store.js";
import { parseCanonicalTranscriptLines } from "../utils/canonical-transcript.js";
import { adapterSpecByName } from "../adapter/spec.js";
import { isRecord, outputBlocks } from "../utils/output.js";
import { mergeProviderMetadata } from "./provider-metadata.js";
import { safeTimelineId } from "./timeline-id.js";
import { resolveTranscriptProjectionSessionDir } from "./transcript-session-dir.js";

export type TranscriptProjection = {
  transcript: AiTranscriptEntry[];
  toolCalls: AiToolCall[];
  providerPatch: Partial<AiProviderMetadataState>;
  digest: string;
  agentFrameworkSessionDir: string | null;
};

type VisibleRow =
  | { kind: "message"; entry: AiTranscriptEntry }
  | { kind: "tool"; tool: AiToolCall };

type PendingTool = {
  tool: AiToolCall;
  rawInput: unknown;
};

type TranscriptMessageGroup = {
  key: string;
  entry: AiTranscriptEntry;
  turnId: TurnId;
};

type ProjectionToolLogContext = {
  adapterName?: string;
  sessionDir: string | null;
  toolLogEntries: readonly ToolLogEntry[];
  sameNameToolCount?: number;
  sameIdentityToolCount?: number;
};

export function projectTranscriptFile(input: {
  adapterName: string;
  transcriptPath: string;
  workingDir?: string | null;
  sessionDir?: string | null;
}): TranscriptProjection {
  const rawLines = readRawTranscriptLines(input.transcriptPath);
  const sessionDir = input.sessionDir ?? resolveTranscriptProjectionSessionDir({
    transcriptPath: input.transcriptPath,
    workingDir: input.workingDir,
    create: true,
  });
  const toolLogEntries = sessionDir ? readToolLogEntries(sessionDir, 1000) : [];
  return projectTranscriptLines({
    adapterName: input.adapterName,
    transcriptPath: input.transcriptPath,
    workingDir: input.workingDir,
    sessionDir,
    rawLines,
    toolLogEntries,
  });
}

export function projectTranscriptLines(input: {
  adapterName: string;
  transcriptPath?: string;
  workingDir?: string | null;
  sessionDir?: string | null;
  rawLines: readonly string[];
  toolLogEntries?: readonly ToolLogEntry[];
}): TranscriptProjection {
  const entries = parseCanonicalTranscriptLines({
    adapterName: input.adapterName,
    rawLines: input.rawLines,
    transcriptPath: input.transcriptPath ?? "",
    startLine: 1,
  }).filter((entry): entry is TranscriptEntry => Boolean(entry));
  const materialized = materializeCanonicalEntries({
    entries,
    adapterName: input.adapterName,
    sessionDir: input.sessionDir ?? null,
    toolLogEntries: input.toolLogEntries ?? [],
  });
  const providerPatch = mergeProviderMetadata(
    materialized.providerPatch,
    adapterProviderMetadataPatch(input.adapterName, {
      rawLines: input.rawLines,
      transcriptPath: input.transcriptPath,
    })
  );
  return {
    transcript: materialized.transcript,
    toolCalls: materialized.toolCalls,
    providerPatch,
    digest: stableJsonStringify({
      transcript: materialized.transcript,
      toolCalls: materialized.toolCalls,
      providerPatch,
    }),
    agentFrameworkSessionDir: input.sessionDir ?? null,
  };
}

export function materializeCanonicalEntries(input: {
  entries: readonly TranscriptEntry[];
  adapterName?: string;
  sessionDir?: string | null;
  toolLogEntries?: readonly ToolLogEntry[];
}): {
  transcript: AiTranscriptEntry[];
  toolCalls: AiToolCall[];
  providerPatch: Partial<AiProviderMetadataState>;
} {
  const rows: VisibleRow[] = [];
  const pendingTools = new Map<string, PendingTool>();
  const toolNameCounts = transcriptToolNameCounts(input.entries);
  const toolIdentityCounts = transcriptToolIdentityCounts(input.entries, input.adapterName);
  let timelineSeq = 0;
  let syntheticTurnIndex = 0;
  let latestUsage: TokenUsage | null = null;
  let messageGroup: TranscriptMessageGroup | null = null;

  const nextSeq = (): AiTimelineSeq => {
    timelineSeq += 1;
    return timelineSeq as AiTimelineSeq;
  };

  for (const entry of input.entries) {
    if (entry.usage) latestUsage = entry.usage;
    if (!entry.message) continue;
    const content = normalizeEntryContent(entry.message.content, entry.source);
    const entryTurnId = turnIdFor(entry, ++syntheticTurnIndex);
    const messageGroupKey = transcriptMessageGroupKey(input.adapterName, entry);
    if (
      !messageGroupKey ||
      (messageGroup && messageGroup.key !== messageGroupKey)
    ) {
      messageGroup = null;
    }
    const turnId: TurnId = messageGroupKey && messageGroup
      ? messageGroup.turnId
      : entryTurnId;

    const visibleText = textFromBlocks(content);
    const hasOnlyToolResults = content.length > 0 && content.every((block) => block.type === "tool_result");
    if (visibleText && !hasOnlyToolResults && isVisibleMessageRole(entry.message.role)) {
      const source = entry.source ?? firstBlockSource(content);
      const metadata = messageMetadata(entry, source, visibleText);
      const createdAt = createdAtFor(entry, source);
      if (messageGroupKey && messageGroup) {
        appendTextToMessageEntry(messageGroup.entry, {
          text: visibleText,
          updatedAt: createdAt,
          usage: entry.usage ?? null,
          metadata,
        });
      } else {
        const projectedEntry: AiTranscriptEntry = {
          id: publicMessageId(source, entry.message.id),
          sequenceId: nextSeq(),
          turnId,
          role: entry.message.role as AiTranscriptEntry["role"],
          content: [{ type: "text", text: visibleText }],
          status: "completed",
          ...(metadata ? { metadata } : {}),
          createdAt,
          updatedAt: createdAt,
          completedAt: createdAt,
          usage: entry.message.role === "assistant" ? entry.usage ?? null : null,
        };
        rows.push({
          kind: "message",
          entry: projectedEntry,
        });
        messageGroup = messageGroupKey
          ? { key: messageGroupKey, entry: projectedEntry, turnId }
          : null;
      }
    }

    for (const block of content) {
      if (block.type === "tool_use") {
        const tool = materializeToolUse(block, turnId, nextSeq(), {
          adapterName: input.adapterName,
          sessionDir: input.sessionDir ?? null,
          toolLogEntries: input.toolLogEntries ?? [],
          sameNameToolCount: toolNameCounts.get(block.name ?? "tool") ?? 1,
          sameIdentityToolCount: transcriptToolIdentityCount(
            input.adapterName,
            toolIdentityCounts,
            block.name ?? "tool",
            block.input ?? {}
          ),
        });
        pendingTools.set(toolKeyForBlock(block), { tool, rawInput: block.input ?? {} });
        rows.push({ kind: "tool", tool });
        continue;
      }
      if (block.type === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (!toolUseId) continue;
        const pending = pendingTools.get(toolUseId);
        if (!pending) continue;
        applyToolResult(pending.tool, block);
      }
    }
  }

  for (const pending of pendingTools.values()) {
    enrichProjectedTool(pending.tool, pending.rawInput, {
      adapterName: input.adapterName,
      sessionDir: input.sessionDir ?? null,
      toolLogEntries: input.toolLogEntries ?? [],
      sameNameToolCount: toolNameCounts.get(pending.tool.name) ?? 1,
      sameIdentityToolCount: transcriptToolIdentityCount(
        input.adapterName,
        toolIdentityCounts,
        pending.tool.name,
        pending.rawInput
      ),
    });
  }

  const transcript = rows
    .filter((row): row is Extract<VisibleRow, { kind: "message" }> => row.kind === "message")
    .map((row) => row.entry);
  const toolCalls = rows
    .filter((row): row is Extract<VisibleRow, { kind: "tool" }> => row.kind === "tool")
    .map((row) => row.tool);

  return {
    transcript,
    toolCalls,
    providerPatch: latestUsage ? { usage: latestUsage } : {},
  };
}

export function readRawTranscriptLines(transcriptPath: string): string[] {
  try {
    return fs.readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function materializeToolUse(
  block: ContentBlock,
  turnId: TurnId,
  sequenceId: AiTimelineSeq,
  context: ProjectionToolLogContext
): AiToolCall {
  const id = toolKeyForBlock(block);
  const name = block.name ?? "tool";
  const input = block.input ?? {};
  const createdAt = createdAtForBlock(block);
  const toolLog = matchingToolLog(context.toolLogEntries, id, {
    adapterName: context.adapterName,
    toolName: name,
    input,
    sameNameToolCount: context.sameNameToolCount,
    sameIdentityToolCount: context.sameIdentityToolCount,
  });
  const metadata = projectedToolMetadata(block, toolLog, context.sessionDir, id);
  const terminalStatus = toolLogTerminalStatus(toolLog);
  const error = terminalStatus && toolLog ? toolLogRuntimeError(toolLog, metadata) : null;
  return {
    id,
    sequenceId,
    turnId,
    name,
    input: summarizeToolInputForUi(name, input),
    ...(metadata ? { metadata } : {}),
    status: terminalStatus ?? "running",
    wait: null,
    output: [],
    result: terminalStatus
      ? { state: terminalStatus, output: [], error }
      : null,
    processId: null,
    progress: null,
    elapsedMs: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: terminalStatus ? createdAt : null,
  };
}

function enrichProjectedTool(
  tool: AiToolCall,
  rawInput: unknown,
  context: ProjectionToolLogContext
): void {
  const toolLog = matchingToolLog(context.toolLogEntries, tool.id, {
    adapterName: context.adapterName,
    toolName: tool.name,
    input: rawInput,
    sameNameToolCount: context.sameNameToolCount,
    sameIdentityToolCount: context.sameIdentityToolCount,
  });
  const terminalStatus = toolLogTerminalStatus(toolLog);
  const input = isRecord(rawInput) ? rawInput : {};
  if (toolLog) {
    const metadata = projectedToolMetadata({ id: tool.id, name: tool.name, input, type: "tool_use" }, toolLog, context.sessionDir, tool.id);
    if (metadata) tool.metadata = { ...(tool.metadata ?? {}), ...metadata };
  }
  if (tool.output.length > 0 && !terminalStatus && (!tool.result || tool.result.state === "completed")) {
    tool.status = "completed";
    tool.result = { state: "completed", output: tool.output, error: null };
    tool.completedAt = tool.updatedAt;
    return;
  }
  if (terminalStatus && toolLog) {
    const metadata = projectedToolMetadata({ id: tool.id, name: tool.name, input, type: "tool_use" }, toolLog, context.sessionDir, tool.id);
    const error = toolLogRuntimeError(toolLog, metadata);
    tool.status = terminalStatus;
    tool.result = { state: terminalStatus, output: tool.output, error };
    tool.completedAt = tool.updatedAt;
  }
}

function applyToolResult(tool: AiToolCall, block: ContentBlock): void {
  const output = outputBlocksForToolResultContent(block.content);
  tool.output = output;
  tool.updatedAt = createdAtForBlock(block);
  tool.completedAt = tool.updatedAt;
  if (block.is_error) {
    tool.status = "failed";
    tool.result = {
      state: "failed",
      output,
      error: toolResultError(output),
    };
    return;
  }
  if (!tool.result || tool.result.state === "completed") {
    tool.status = "completed";
    tool.result = {
      state: "completed",
      output,
      error: null,
    };
  } else {
    tool.result = { ...tool.result, output };
  }
}

function outputBlocksForToolResultContent(content: ContentBlock["content"]): AiToolCall["output"] {
  if (!Array.isArray(content)) return outputBlocks(content);
  const output: AiToolCall["output"] = [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      output.push({ type: "text", text: item.text });
      continue;
    }
    const record = item as unknown as Record<string, unknown>;
    if (record.type === "json" && "value" in record) {
      output.push({ type: "json", value: record.value });
      continue;
    }
    output.push({ type: "json", value: item });
  }
  return output;
}

function toolResultError(output: AiToolCall["output"]): AiErrorInfo {
  const message = output
    .map((block) => block.type === "text" ? block.text : stableJsonStringify(block.value))
    .join("\n")
    .trim()
    .slice(0, 4000) || "Tool execution failed.";
  return {
    code: "runtime_error",
    message,
    recoverable: false,
  };
}

function projectedToolMetadata(
  block: Pick<ContentBlock, "source" | "id" | "name" | "input" | "type">,
  toolLog: ToolLogEntry | null,
  sessionDir: string | null,
  toolUseId: string
): AiMetadata | undefined {
  const metadata: AiMetadata = {};
  if (block.source) applySourceMetadata(metadata, block.source);
  if (toolLog) applyToolLogMetadata(metadata, toolLog);
  const enriched = enrichAgentFrameworkToolMetadata({
    metadata,
    sessionDir,
    toolUseId: toolLog?.toolUseId ?? toolUseId,
  });
  return enriched && Object.keys(enriched).length > 0 ? enriched : undefined;
}

function messageMetadata(
  entry: TranscriptEntry,
  source: TranscriptSource | undefined,
  visibleText: string
): AiMetadata | undefined {
  const metadata: AiMetadata = { ...(entry.metadata ?? {}) };
  if (source) applySourceMetadata(metadata, source);
  const syntheticSource = syntheticSourceFor(entry, visibleText, metadata);
  if (syntheticSource) {
    metadata[AGENT_FRAMEWORK_METADATA_KEYS.messageKind] = "synthetic";
    metadata[AGENT_FRAMEWORK_METADATA_KEYS.syntheticSource] =
      metadataString(metadata, AGENT_FRAMEWORK_METADATA_KEYS.syntheticSource) ?? syntheticSource;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function syntheticSourceFor(
  entry: TranscriptEntry,
  visibleText: string,
  metadata: AiMetadata
): string | null {
  if (metadataString(metadata, AGENT_FRAMEWORK_METADATA_KEYS.messageKind) === "synthetic") {
    return metadataString(metadata, AGENT_FRAMEWORK_METADATA_KEYS.syntheticSource) ?? "agent-framework";
  }
  if (entry.isMeta) return "adapter-meta";
  if (isProviderInstructionText(visibleText)) return "provider-instructions";
  if (isEnvironmentContextText(visibleText)) return "environment-context";
  if (isAgentFrameworkSyntheticText(visibleText)) return "agent-framework";
  return null;
}

function isProviderInstructionText(text: string): boolean {
  const head = text.slice(0, 1000);
  return /(^|\n)#?\s*(AGENTS|CLAUDE)\.md instructions for\b/i.test(head);
}

function isAgentFrameworkSyntheticText(text: string): boolean {
  const trimmed = text.trimStart();
  return (/^<skill[\s>]/i.test(trimmed) && /<\/skill>/i.test(trimmed)) ||
    (/^<hook_prompt[\s>]/i.test(trimmed) && /<\/hook_prompt>/i.test(trimmed));
}

function isEnvironmentContextText(text: string): boolean {
  const trimmed = text.trimStart();
  return /^<environment_context[\s>]/i.test(trimmed) && /<\/environment_context>/i.test(trimmed);
}

function metadataString(metadata: AiMetadata, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function applySourceMetadata(metadata: AiMetadata, source: TranscriptSource): void {
  metadata[AGENT_FRAMEWORK_METADATA_KEYS.sourceKey] = source.sourceKey;
  metadata[AGENT_FRAMEWORK_METADATA_KEYS.sourceLine] = source.startLine;
  metadata[AGENT_FRAMEWORK_METADATA_KEYS.sourceEndLine] = source.endLine;
}

function matchingToolLog(
  entries: readonly ToolLogEntry[],
  toolUseId: string,
  fallback?: {
    adapterName?: string;
    toolName: string;
    input: unknown;
    sameNameToolCount?: number;
    sameIdentityToolCount?: number;
  }
): ToolLogEntry | null {
  const recent = [...entries].reverse();
  const exact = recent.find((entry) => entry.toolUseId === toolUseId);
  if (exact) return exact;
  if (!fallback?.adapterName) return null;
  const spec = adapterSpecByName(fallback.adapterName);
  const matcher = spec.toolLogEntryMatchesTranscriptTool;
  if (!matcher) return null;
  const matches = recent.filter((entry) => matcher(entry, fallback.toolName, fallback.input));
  if (matches.length === 0) return null;
  if (spec.transcriptToolLogMatchIsStable?.(fallback.toolName, fallback.input)) {
    const sameIdentityToolCount = fallback.sameIdentityToolCount ?? fallback.sameNameToolCount ?? 1;
    return sameIdentityToolCount === 1 && matches.length === 1 ? matches[0] ?? null : null;
  }
  if ((fallback.sameNameToolCount ?? 1) === 1 && matches.length === 1) return matches[0] ?? null;
  return null;
}

function normalizeEntryContent(
  content: string | ContentBlock[],
  source: TranscriptSource | undefined
): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content, ...(source ? { source } : {}) }] : [];
  return content.map((block) => block.source || !source ? block : { ...block, source });
}

function transcriptToolNameCounts(entries: readonly TranscriptEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const name = block.name ?? "tool";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

function transcriptToolIdentityCounts(
  entries: readonly TranscriptEntry[],
  adapterName: string | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!adapterName) return counts;
  const identityKey = adapterSpecByName(adapterName).transcriptToolLogIdentityKey;
  if (!identityKey) return counts;
  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const key = identityKey(block.name ?? "tool", block.input ?? {});
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function transcriptToolIdentityCount(
  adapterName: string | undefined,
  counts: ReadonlyMap<string, number>,
  toolName: string,
  input: unknown
): number | undefined {
  if (!adapterName) return undefined;
  const key = adapterSpecByName(adapterName).transcriptToolLogIdentityKey?.(toolName, input);
  return key ? counts.get(key) ?? 1 : undefined;
}

function textFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function isVisibleMessageRole(role: string): role is AiTranscriptEntry["role"] {
  return role === "user" || role === "assistant" || role === "system" || role === "tool";
}

function transcriptMessageGroupKey(adapterName: string | undefined, entry: TranscriptEntry): string | null {
  if (!adapterName) return null;
  return adapterSpecByName(adapterName).transcriptMessageGroupKey?.(entry) ?? null;
}

function appendTextToMessageEntry(
  entry: AiTranscriptEntry,
  input: {
    text: string;
    updatedAt: string;
    usage: TokenUsage | null;
    metadata?: AiMetadata;
  }
): void {
  const textBlock = entry.content.find(
    (block): block is Extract<AiTranscriptEntry["content"][number], { type: "text" }> => block.type === "text"
  );
  if (textBlock) {
    textBlock.text = textBlock.text ? `${textBlock.text}\n${input.text}` : input.text;
  } else {
    entry.content.push({ type: "text", text: input.text });
  }
  entry.updatedAt = input.updatedAt;
  entry.completedAt = input.updatedAt;
  if (input.usage) entry.usage = input.usage;
  if (input.metadata) entry.metadata = mergeMessageMetadata(entry.metadata, input.metadata);
}

function mergeMessageMetadata(existing: AiMetadata | undefined, incoming: AiMetadata): AiMetadata {
  const merged: AiMetadata = { ...(existing ?? {}), ...incoming };
  preserveExistingMetadataValue(merged, existing, AGENT_FRAMEWORK_METADATA_KEYS.sourceKey);
  mergeNumericMetadataValue(merged, existing, incoming, AGENT_FRAMEWORK_METADATA_KEYS.sourceLine, Math.min);
  mergeNumericMetadataValue(merged, existing, incoming, AGENT_FRAMEWORK_METADATA_KEYS.sourceEndLine, Math.max);
  return merged;
}

function preserveExistingMetadataValue(
  target: AiMetadata,
  existing: AiMetadata | undefined,
  key: string
): void {
  if (existing?.[key] !== undefined) target[key] = existing[key];
}

function mergeNumericMetadataValue(
  target: AiMetadata,
  existing: AiMetadata | undefined,
  incoming: AiMetadata,
  key: string,
  merge: (left: number, right: number) => number
): void {
  const left = existing?.[key];
  const right = incoming[key];
  if (typeof left === "number" && typeof right === "number") target[key] = merge(left, right);
}

function turnIdFor(entry: TranscriptEntry, fallbackIndex: number): TurnId {
  const key = entry.source?.sourceKey ?? `entry:${fallbackIndex}`;
  return `turn-${hashSha256Prefix(key, 12)}`;
}

function publicMessageId(source: TranscriptSource | undefined, nativeId: string | undefined): string {
  if (nativeId) return `message-${safeTimelineId(nativeId)}`;
  return `message-${hashSha256Prefix(source?.sourceKey ?? "message", 16)}`;
}

function toolKeyForBlock(block: ContentBlock): string {
  if (typeof block.id === "string" && block.id) return block.id;
  return `tool-${hashSha256Prefix(block.source?.sourceKey ?? stableJsonStringify(block), 16)}`;
}

function createdAtFor(entry: TranscriptEntry, source: TranscriptSource | undefined): string {
  return entry.createdAt ?? source?.createdAt ?? new Date(0).toISOString();
}

function createdAtForBlock(block: Pick<ContentBlock, "source">): string {
  return block.source?.createdAt ?? new Date(0).toISOString();
}

function firstBlockSource(blocks: readonly ContentBlock[]): TranscriptSource | undefined {
  return blocks.find((block) => block.source)?.source;
}

function adapterProviderMetadataPatch(
  adapterName: string,
  input: {
    rawLines: readonly string[];
    transcriptPath?: string;
  }
): Partial<AiProviderMetadataState> {
  return adapterSpecByName(adapterName).extractProviderMetadata?.(input) ?? {};
}
