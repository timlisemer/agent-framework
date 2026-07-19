import fs from "node:fs";
import type { PlanModeDetection, TranscriptEntry } from "../adapter/types.js";
import { adapterSpecByName } from "../adapter/spec.js";
import {
  buildAssistantGroups,
  type AssistantGroup,
  parseCanonicalTranscriptLines,
} from "../utils/canonical-transcript.js";
import { isMissingFileError } from "../utils/filesystem-errors.js";
import { readValidatedTextFileCancellable } from "../utils/file-io.js";
import { isRecord } from "../utils/output.js";
import { toJsonValue as jsonValue, type JsonValue } from "../scenario/protocol/common.js";
import { digestScenarioValue } from "../scenario/protocol/digest.js";
import {
  detectParallelBatchFromEntries,
  extractActionableToolResultFeedback,
  getMostRecentMessage,
  readTranscriptExactFromEntries,
  recentUserMessagesFromEntries,
  resolveActiveSlashCommandAllowedToolsFromEntries,
  userTurnFollowedByCompletedToolRoundtripFromEntries,
  type ParallelBatchInfo,
} from "../utils/transcript.js";
import type { PriorErrorContext } from "../utils/prior-error-context.js";
import { FIRST_RESPONSE_STOP_COUNTS } from "../utils/transcript-presets.js";

export type CanonicalNativeTranscriptObservation = {
  availability: "present" | "missing";
  data: JsonValue;
  metadata: CanonicalNativeTranscriptMetadata;
};

export type CanonicalNativeTranscriptMetadata = {
  planModeDetection: PlanModeDetection;
  recentUserMessages: string[];
  cachedSnippetSideTaskDischarged: boolean;
  slashCommandAllowedTools: readonly string[] | null;
  parallelBatch: ParallelBatchInfo | null;
  stop: {
    assistantTextCandidates: string[];
    latestAssistantText: string | null;
    latestUserText: string | null;
    priorErrorContext: PriorErrorContext[];
  };
};

const MAXIMUM_NATIVE_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * Import adapter-native history without consulting tool logs or session
 * sidecars. The result is canonical command data; only ScenarioRuntime may
 * turn it into records and snapshot state.
 */
export async function canonicalNativeTranscriptObservation(input: {
  adapterName: string;
  transcriptPath: string;
  permissionMode?: string;
  collaborationMode?: string;
  toolUseId?: string;
  cachedUserMessage?: string;
}): Promise<CanonicalNativeTranscriptObservation> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await readRawTranscript(input.transcriptPath);
    if (before.availability === "missing") {
      const observation = canonicalNativeTranscriptObservationFromLines(
        input.adapterName,
        input.transcriptPath,
        [],
        input,
        "missing",
      );
      const after = await readRawTranscript(input.transcriptPath);
      if (after.availability === "missing") return observation;
      continue;
    }
    const observation = canonicalNativeTranscriptObservationFromLines(
      input.adapterName,
      input.transcriptPath,
      before.lines,
      input,
      "present",
    );
    const after = await readRawTranscript(input.transcriptPath);
    if (after.availability === "present" && before.raw === after.raw) return observation;
  }
  throw new Error("Native transcript did not stabilize after repeated reads");
}

function canonicalNativeTranscriptObservationFromLines(
  adapterName: string,
  transcriptPath: string,
  rawLines: readonly string[],
  context: {
    permissionMode?: string;
    collaborationMode?: string;
    toolUseId?: string;
    cachedUserMessage?: string;
  },
  availability: CanonicalNativeTranscriptObservation["availability"],
): CanonicalNativeTranscriptObservation {
  const entries = parseCanonicalTranscriptLines({
    adapterName,
    transcriptPath,
    rawLines: [...rawLines],
  });
  const spec = adapterSpecByName(adapterName);
  const messageGroupKey = spec.transcriptMessageGroupKey;
  const assistantGroups = messageGroupKey === undefined
    ? new Map<number, AssistantGroup>()
    : buildAssistantGroups(entries, "human-user-text", messageGroupKey);
  const messages: Array<Record<string, JsonValue>> = [];
  const tools = new Map<string, Record<string, JsonValue>>();
  for (const [index, entry] of entries.entries()) {
    if (!entry?.message) continue;
    const message = entry.message!;
    const sourceLine = entry.source?.startLine ?? index + 1;
    const assistantGroup = message.role === "assistant" && entry.isMeta !== true
      ? assistantGroups.get(index)
      : undefined;
    const groupFirstEntry = assistantGroup === undefined
      ? undefined
      : entries[assistantGroup.indices[0] ?? index];
    const turnId = groupFirstEntry?.source?.nativeId ?? entry.source?.nativeId ??
      message.id ?? `native-turn-${sourceLine}`;
    const blocks = typeof message.content === "string" ? [] : message.content;
    const visible = assistantGroup === undefined
      ? visibleMessageContent(message.content)
      : index === assistantGroup.lastIndex ? assistantGroup.text : "";
    if (visible && ["user", "assistant", "system"].includes(message.role)) {
      const id = groupFirstEntry?.message?.id ?? message.id ?? `native-message:${adapterName}:${sourceLine}`;
      const usage = assistantGroup === undefined
        ? entry.usage
        : latestAssistantGroupUsage(assistantGroup, entries);
      messages.push({
        id,
        turnId,
        role: entry.isMeta || message.role === "system" ? "synthetic" : message.role,
        content: visible,
        contentDigest: digestScenarioValue(visible),
        status: "completed",
        ...(usage === undefined ? {} : { usage: jsonValue(usage) }),
      });
    }
    for (const block of blocks) {
      if (block.type === "tool_use") {
        const id = block.id ?? block.tool_use_id ?? `native-tool:${adapterName}:${sourceLine}`;
        const canonicalTool = spec.canonicalizeToolCall(block.name ?? "tool", block.input ?? {});
        const toolInput = jsonValue(canonicalTool.toolInput);
        tools.set(id, {
          id,
          turnId,
          name: canonicalTool.toolName,
          input: toolInput,
          inputDigest: digestScenarioValue(toolInput),
          status: "running",
          output: [],
          error: null,
        });
      }
      if (block.type === "tool_result" && block.tool_use_id) {
        const tool = tools.get(block.tool_use_id);
        if (!tool) continue;
        tool.status = block.is_error ? "failed" : "completed";
        tool.output = toolResultValues(block.content);
        tool.error = block.is_error ? "Native transcript reported a tool error" : null;
      }
    }
  }
  const data = jsonValue({ messages, tools: [...tools.values()] });
  const stopTranscript = readTranscriptExactFromEntries(entries, FIRST_RESPONSE_STOP_COUNTS, spec);
  const assistantTextCandidates = [
    ...(stopTranscript.assistantTextCandidates ?? []),
    ...[...stopTranscript.assistant]
      .sort((left, right) => right.index - left.index)
      .map((message) => message.content),
  ];
  const slashCommandAllowedTools = resolveActiveSlashCommandAllowedToolsFromEntries(entries, spec);
  return {
    availability,
    data,
    metadata: {
      planModeDetection: spec.detectPlanMode({
        permissionMode: context.permissionMode,
        collaborationMode: context.collaborationMode,
        transcriptLines: rawLines,
      }),
      recentUserMessages: recentUserMessagesFromEntries(entries, 5, { stripQuoted: false }, spec),
      cachedSnippetSideTaskDischarged: context.cachedUserMessage
        ? userTurnFollowedByCompletedToolRoundtripFromEntries(entries, context.cachedUserMessage, spec)
        : false,
      slashCommandAllowedTools: slashCommandAllowedTools ? [...slashCommandAllowedTools] : null,
      parallelBatch: context.toolUseId
        ? detectParallelBatchFromEntries(entries, context.toolUseId, spec)
        : null,
      stop: {
        assistantTextCandidates,
        latestAssistantText: stopTranscript.assistant.length > 0
          ? getMostRecentMessage(stopTranscript.assistant).content
          : null,
        latestUserText: stopTranscript.user.length > 0
          ? getMostRecentMessage(stopTranscript.user).content
          : null,
        priorErrorContext: extractActionableToolResultFeedback(stopTranscript.tool),
      },
    },
  };
}

function visibleMessageContent(
  content: NonNullable<TranscriptEntry["message"]>["content"],
): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => {
    if (typeof block.text === "string") return [block.text];
    if (typeof block.content === "string" && block.type !== "tool_result") return [block.content];
    return [];
  }).join("\n");
}

function latestAssistantGroupUsage(
  group: AssistantGroup,
  entries: readonly (TranscriptEntry | null)[],
): TranscriptEntry["usage"] | undefined {
  for (let index = group.indices.length - 1; index >= 0; index -= 1) {
    const usage = entries[group.indices[index] ?? -1]?.usage;
    if (usage !== undefined) return usage;
  }
  return undefined;
}

type RawTranscriptRead =
  | { availability: "present"; raw: string; lines: string[] }
  | { availability: "missing" };

async function readRawTranscript(transcriptPath: string): Promise<RawTranscriptRead> {
  try {
    const stats = await fs.promises.lstat(transcriptPath);
    if (!stats.isFile()) throw new Error(`Native transcript is not a regular file: ${transcriptPath}`);
    const raw = await readValidatedTextFileCancellable(transcriptPath, {
      maxBytes: MAXIMUM_NATIVE_TRANSCRIPT_BYTES,
    });
    if (raw === null) {
      throw new Error(
        `Native transcript must be readable UTF-8 text no larger than ${MAXIMUM_NATIVE_TRANSCRIPT_BYTES} bytes`,
      );
    }
    return {
      availability: "present",
      raw,
      lines: raw.split("\n").filter((line) => line.trim().length > 0),
    };
  } catch (error) {
    if (isMissingFileError(error)) return { availability: "missing" };
    throw error;
  }
}

function toolResultValues(content: unknown): JsonValue[] {
  if (!Array.isArray(content)) return [jsonValue(content)];
  return content.map((item) => {
    if (isRecord(item) && typeof item.text === "string") return item.text;
    return jsonValue(item);
  });
}
