import { activeSpec, adapterSpecByName } from "../adapter/spec.js";
import type { ContentBlock, TranscriptEntry } from "../adapter/types.js";

export type ParsedTranscriptEntry = TranscriptEntry | null;

export interface AssistantGroup {
  msgId: string;
  indices: number[];
  lastIndex: number;
  text: string;
  hasThinking: boolean;
  hasToolUse: boolean;
  toolUseIds: string[];
  entryCount: number;
}

export type AssistantGroupBoundaryPolicy = "human-user-text" | "user-text-or-tool-result";

export function parseCanonicalTranscriptLines(input: {
  rawLines: readonly string[];
  transcriptPath: string;
  adapterName?: string;
  startLine?: number;
}): ParsedTranscriptEntry[] {
  const spec = input.adapterName ? adapterSpecByName(input.adapterName) : activeSpec();
  return [
    ...spec.parseTranscript(input.rawLines, {
      startLine: input.startLine ?? 1,
      transcriptPath: input.transcriptPath,
    }),
  ];
}

export function parseActiveTranscriptLines(
  rawLines: readonly string[],
  transcriptPath: string,
): ParsedTranscriptEntry[] {
  return parseCanonicalTranscriptLines({ rawLines, transcriptPath });
}

export function userEntryHasHumanText(entry: TranscriptEntry): boolean {
  if (entry.message?.role !== "user" || entry.isMeta === true) return false;

  const content = entry.message.content;
  if (typeof content === "string") {
    return content.length > 0;
  }
  if (!Array.isArray(content)) return false;

  return content.some((block) => block.type === "text" && (block.text ?? "").length > 0);
}

export function userEntryHasToolResult(entry: TranscriptEntry): boolean {
  if (entry.message?.role !== "user" || entry.isMeta === true) return false;

  const content = entry.message.content;
  if (!Array.isArray(content)) return false;

  return content.some((block) => block.type === "tool_result");
}

export function buildAssistantGroups(
  parsedEntries: readonly ParsedTranscriptEntry[],
  boundaryPolicy: AssistantGroupBoundaryPolicy = "human-user-text",
  messageGroupKey?: (entry: TranscriptEntry) => string | null,
): Map<number, AssistantGroup> {
  const byIndex = new Map<number, AssistantGroup>();
  let activeGroup: AssistantGroup | undefined;
  let activeGroupKey: string | null | undefined;

  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];

    if (!entry || !entry.message) continue;

    if (entry.message.role !== "assistant") {
      if (userEntryResetsAssistantGroup(entry, boundaryPolicy)) {
        activeGroup = undefined;
        activeGroupKey = undefined;
      }
      continue;
    }

    if (entry.isMeta === true) continue;

    const entryGroupKey = messageGroupKey?.(entry) ?? null;
    if (!activeGroup || (messageGroupKey !== undefined && entryGroupKey !== activeGroupKey)) {
      activeGroup = {
        msgId: entry.message.id ?? `__assistant_run_${i}`,
        indices: [],
        lastIndex: i,
        text: "",
        hasThinking: false,
        hasToolUse: false,
        toolUseIds: [],
        entryCount: 0,
      };
      activeGroupKey = entryGroupKey;
    }

    addAssistantEntryToGroup(activeGroup, entry, i);
    byIndex.set(i, activeGroup);
  }

  return byIndex;
}

export function collectAssistantTextCandidates(
  parsedEntries: readonly ParsedTranscriptEntry[],
  maxAssistantEntries: number,
): string[] {
  const candidates: string[] = [];
  let assistantEntriesSeen = 0;

  for (let i = parsedEntries.length - 1; i >= 0; i--) {
    const entry = parsedEntries[i];
    if (!entry?.message || entry.isMeta === true || entry.message.role !== "assistant") {
      continue;
    }

    assistantEntriesSeen++;
    const content = entry.message.content;
    if (Array.isArray(content)) {
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block.type === "text" && block.text?.trim()) {
          candidates.push(block.text);
        }
      }
    } else if (typeof content === "string" && content.trim()) {
      candidates.push(content);
    }

    if (assistantEntriesSeen >= maxAssistantEntries) break;
  }

  return candidates;
}

export function entryContainsToolUseId(entry: ParsedTranscriptEntry, toolUseId: string): boolean {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "tool_use" && block.id === toolUseId);
}

export function sliceCanonicalEntriesForCapture(input: {
  entries: readonly ParsedTranscriptEntry[];
  event: string;
  toolUseId?: string;
}): readonly ParsedTranscriptEntry[] {
  if ((input.event !== "PreToolUse" && input.event !== "PostToolUse") || !input.toolUseId) {
    return input.entries;
  }

  const idx = input.entries.findIndex((entry) => entryContainsToolUseId(entry, input.toolUseId!));
  if (idx === -1) return input.entries;
  return input.entries.slice(0, idx + 1);
}

export function rawAnchorStartIndex(
  rawLines: readonly Record<string, unknown>[],
  anchorUuid: string | null,
): number {
  if (!anchorUuid) return 0;
  const idx = rawLines.findIndex((line) => line.uuid === anchorUuid);
  return idx === -1 ? 0 : idx;
}

export function sliceRawTranscriptForCapture(input: {
  rawTranscriptLines: readonly string[];
  rawJsonLines: readonly Record<string, unknown>[];
  event: string;
  captureTs: number;
}): { rawTranscriptLines: string[]; rawJsonLines: Record<string, unknown>[] } {
  if (input.event !== "Stop") {
    return {
      rawTranscriptLines: [...input.rawTranscriptLines],
      rawJsonLines: [...input.rawJsonLines],
    };
  }

  let endIdx = input.rawJsonLines.length;
  for (let i = 0; i < input.rawJsonLines.length; i++) {
    const millis = timestampMillis(input.rawJsonLines[i]);
    if (millis !== null && millis > input.captureTs) {
      endIdx = i;
      break;
    }
  }

  return {
    rawTranscriptLines: input.rawTranscriptLines.slice(0, endIdx),
    rawJsonLines: input.rawJsonLines.slice(0, endIdx),
  };
}

function userEntryResetsAssistantGroup(
  entry: TranscriptEntry,
  policy: AssistantGroupBoundaryPolicy,
): boolean {
  if (policy === "human-user-text") {
    return userEntryHasHumanText(entry);
  }
  return userEntryHasHumanText(entry) || userEntryHasToolResult(entry);
}

function addAssistantEntryToGroup(
  group: AssistantGroup,
  entry: TranscriptEntry,
  index: number,
): void {
  group.indices.push(index);
  group.entryCount++;
  if (index > group.lastIndex) group.lastIndex = index;

  const content = entry.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text) {
        appendAssistantText(group, block.text);
      } else if (block.type === "thinking") {
        group.hasThinking = true;
      } else if (block.type === "tool_use") {
        group.hasToolUse = true;
        if (block.id) group.toolUseIds.push(block.id);
      }
    }
  } else if (typeof content === "string" && content) {
    appendAssistantText(group, content);
  }
}

function appendAssistantText(group: AssistantGroup, text: string): void {
  if (!text) return;
  if (group.text === text) return;

  const existingParts = group.text.split("\n").map((part) => part.trim()).filter(Boolean);
  if (existingParts.includes(text.trim())) return;

  group.text = group.text ? `${group.text} ${text}` : text;
}

function timestampMillis(rawLine: Record<string, unknown>): number | null {
  const timestamp = rawLine.timestamp;
  if (typeof timestamp !== "string") return null;
  const millis = Date.parse(timestamp);
  return Number.isFinite(millis) ? millis : null;
}

export type { ContentBlock, TranscriptEntry };
