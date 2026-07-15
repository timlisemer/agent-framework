/**
 * Materialize - reconstruct a v2 Scenario from a capture pointer.
 *
 * Loads the capture pointer + its epoch + a transcript slice + the
 * corresponding state snapshot, then projects the on-disk JSONL lines back
 * to a v2 Scenario shape that can be passed to the scenario runner.
 *
 * Round-trip caveat: UUIDs are NOT preserved. The JSONL transcript uses
 * crypto.randomUUID() during materialization; the Scenario returned here
 * re-synthesizes ids from scratch. A replay of the materialized scenario
 * will have different UUIDs than the original session.
 *
 * @module scenario/materialize
 */

import * as fs from "fs";
import * as path from "path";
import type { Scenario, ScenarioEntry, ScenarioBlock, ScenarioUserEntry, ScenarioAssistantEntry } from "./types.js";
import { loadCapturePointer } from "./capture.js";
import { loadCurrentEpoch } from "./epoch.js";
import { loadStateSnapshot } from "./snapshot.js";
import { sessionToolLogFile } from "../utils/paths.js";
import type { ToolLogEntry } from "../utils/session-store.js";
import { combineInjectionMessages, loadSessionInjectionsBySeq } from "../utils/session-injections.js";
import { shortContentHash } from "../utils/hash-utils.js";
import { activeSpec } from "../adapter/spec.js";
import type { ContentBlock, TranscriptEntry } from "../adapter/types.js";
import type { ToolPrediction } from "../utils/prediction-types.js";
import { readJsonlThroughByteOffset } from "../utils/file-io.js";
import {
  parseCanonicalTranscriptLines,
  rawAnchorStartIndex,
  sliceCanonicalEntriesForCapture,
  sliceRawTranscriptForCapture,
} from "../utils/canonical-transcript.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readToolLogEntriesThroughOffset(
  sessionDir: string,
  offset: number,
): ToolLogEntry[] {
  return readJsonlThroughByteOffset<ToolLogEntry>(
    sessionToolLogFile(sessionDir),
    offset,
  );
}

function dropTargetPreToolUseLogEntry(
  entries: ToolLogEntry[],
  toolUseId: string | undefined,
): ToolLogEntry[] {
  if (!toolUseId || entries.length === 0) return entries;
  const last = entries[entries.length - 1];
  if (last.toolUseId !== toolUseId) return entries;
  return entries.slice(0, -1);
}

function scenarioBlocksFromCanonicalContent(content: string | ContentBlock[]): ScenarioBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  const out: ScenarioBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.text === "string") {
      out.push({ type: "thinking", thinking: block.text });
    } else if (block.type === "thinking" && typeof (block as unknown as { thinking?: unknown }).thinking === "string") {
      out.push({ type: "thinking", thinking: (block as unknown as { thinking: string }).thinking });
    } else if (block.type === "tool_use") {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name ?? "unknown",
        input: block.input ?? {},
      });
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      out.push({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: scenarioToolResultContent(block.content),
        is_error: block.is_error,
      });
    }
  }
  return out;
}

function scenarioToolResultContent(content: unknown): string | unknown[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function projectCanonicalTranscriptToEntries(
  parsedEntries: readonly (TranscriptEntry | null)[],
  anchorUuid: string | null,
): ScenarioEntry[] {
  let startIdx = 0;
  if (anchorUuid) {
    const idx = parsedEntries.findIndex((entry) => entry?.message?.id === anchorUuid);
    if (idx !== -1) startIdx = idx;
  }

  const entries: ScenarioEntry[] = [];
  for (let i = startIdx; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    const message = entry?.message;
    if (!message) continue;

    if (message.role === "user") {
      const content = message.content;
      const userEntry: ScenarioUserEntry = {
        role: "user",
        content:
          typeof content === "string"
            ? content
            : scenarioBlocksFromCanonicalContent(content),
        isMeta: entry.isMeta === true ? true : undefined,
      };
      entries.push(userEntry);
    } else if (message.role === "assistant") {
      const blocks = scenarioBlocksFromCanonicalContent(message.content);
      if (blocks.length > 0) {
        const assistantEntry: ScenarioAssistantEntry = {
          role: "assistant",
          content: blocks,
        };
        entries.push(assistantEntry);
      }
    }
  }
  return entries;
}

function normalizeStopTranscriptEntries(entries: ScenarioEntry[]): ScenarioEntry[] {
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return entries;
  const entriesThroughStop = entries.slice(0, lastAssistantIdx + 1);
  const last = entriesThroughStop[entriesThroughStop.length - 1];
  if (!last || last.role !== "assistant") return entries;
  if (!Array.isArray(last.content)) return entries;

  let lastToolUseIdx = -1;
  for (let i = last.content.length - 1; i >= 0; i--) {
    if (last.content[i]?.type === "tool_use") {
      lastToolUseIdx = i;
      break;
    }
  }
  if (lastToolUseIdx === -1) return entriesThroughStop;

  let trailingStartIdx = last.content.length;
  while (
    trailingStartIdx > 0 &&
    (last.content[trailingStartIdx - 1]?.type === "text" ||
      last.content[trailingStartIdx - 1]?.type === "thinking")
  ) {
    trailingStartIdx -= 1;
  }
  if (trailingStartIdx <= lastToolUseIdx || trailingStartIdx === last.content.length) return entriesThroughStop;

  const trailingText = last.content.slice(trailingStartIdx);
  const prefixBlocks = last.content.slice(0, trailingStartIdx);
  const normalized = entriesThroughStop.slice(0, -1);
  if (prefixBlocks.length > 0) {
    normalized.push({ role: "assistant", content: prefixBlocks });
  }
  normalized.push({ role: "assistant", content: trailingText });
  return normalized;
}

function inferAdapterNameFromTranscriptPath(transcriptPath: string): string | null {
  if (transcriptPath.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  if (transcriptPath.includes(`${path.sep}.claude${path.sep}`)) return "claude";
  return null;
}

function seedCurrentPrediction(
  prediction: ToolPrediction | null,
): Scenario["seed_state"]["currentPrediction"] {
  const fallback: Scenario["seed_state"]["currentPrediction"] = {
    mood: "neutral",
    trust: "normal",
    intent: "",
    blockedIntent: "",
    explicitlyAllowedTools: [],
    explicitlyBlockedSubstrings: [],
    userMessageSnippet: "",
  };
  if (!prediction) return fallback;

  return {
    mood: prediction.mood,
    trust: prediction.trust,
    intent: prediction.intent,
    blockedIntent: prediction.blockedIntent,
    explicitlyAllowedTools: prediction.explicitlyAllowedTools,
    ...(prediction.explicitlyRequiredTools !== undefined
      ? { explicitlyRequiredTools: prediction.explicitlyRequiredTools }
      : {}),
    ...(prediction.nonBlockingTools !== undefined
      ? { nonBlockingTools: prediction.nonBlockingTools }
      : {}),
    explicitlyBlockedSubstrings: prediction.explicitlyBlockedSubstrings,
    userMessageSnippet: prediction.userMessageSnippet,
    ...(prediction.blockAllTools !== undefined ? { blockAllTools: prediction.blockAllTools } : {}),
    ...(prediction.timestamp !== undefined ? { timestamp: prediction.timestamp } : {}),
    ...(prediction.contextSwitch !== undefined ? { contextSwitch: prediction.contextSwitch } : {}),
    ...(prediction.questionIsStalling !== undefined
      ? { questionIsStalling: prediction.questionIsStalling }
      : {}),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reconstruct a v2 Scenario from a capture pointer.
 *
 * Steps:
 * 1. Load CapturePointer at captureSeq.
 * 2. Load corresponding StateSnapshot.
 * 3. Load current Epoch.
 * 4. Read the session's transcript JSONL (transcript-path.txt sidecar).
 * 5. Project lines → ScenarioEntry[].
 * 6. Assemble a v2 Scenario.
 *
 * Throws when any required piece is missing.
 */
export async function materializeScenario(
  sessionDir: string,
  captureSeq: number,
): Promise<Scenario> {
  const pointer = loadCapturePointer(sessionDir, captureSeq);
  if (!pointer) {
    throw new Error(`materializeScenario: capture seq ${captureSeq} not found in ${sessionDir}`);
  }

  const snapshot =
    pointer.state_snapshot_seq !== null
      ? loadStateSnapshot(sessionDir, pointer.state_snapshot_seq)
      : null;
  if (!snapshot) {
    throw new Error(
      `materializeScenario: state snapshot ${pointer.state_snapshot_seq} not found in ${sessionDir}`,
    );
  }

  const epoch = loadCurrentEpoch(sessionDir);

  // Resolve transcript path via sidecar.
  const sidecarPath = `${sessionDir}/transcript-path.txt`;
  let transcriptPath: string;
  try {
    transcriptPath = fs.readFileSync(sidecarPath, "utf-8").trim();
  } catch {
    throw new Error(
      `materializeScenario: transcript-path.txt sidecar not found in ${sessionDir}`,
    );
  }

  const adapterName = inferAdapterNameFromTranscriptPath(transcriptPath) ?? activeSpec().name;
  const rawTranscriptLines = fs.readFileSync(transcriptPath, "utf-8").split("\n").filter((line) => line.trim());
  const rawJsonLines = rawTranscriptLines.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  const boundedRaw = sliceRawTranscriptForCapture({
    rawTranscriptLines,
    rawJsonLines,
    event: pointer.event,
    captureTs: pointer.ts,
  });
  const anchorUuid = pointer.transcript_anchor_uuid ?? epoch?.anchor_uuid ?? null;
  const rawStartIdx = rawAnchorStartIndex(boundedRaw.rawJsonLines, anchorUuid);
  const anchoredRawTranscriptLines = boundedRaw.rawTranscriptLines.slice(rawStartIdx);
  const parsedEntries = sliceCanonicalEntriesForCapture({
    entries: parseCanonicalTranscriptLines({
      adapterName,
      rawLines: anchoredRawTranscriptLines,
      transcriptPath,
      startLine: rawStartIdx + 1,
    }),
    event: pointer.event,
    toolUseId: pointer.tool_use_id,
  });
  const entries = projectCanonicalTranscriptToEntries(parsedEntries, null);
  const scenarioEntries = pointer.event === "Stop"
    ? normalizeStopTranscriptEntries(entries)
    : entries;

  if (scenarioEntries.length === 0) {
    throw new Error(
      `materializeScenario: transcript slice produced no entries (anchorUuid=${anchorUuid})`,
    );
  }

  const state = snapshot.state;
  const injectionRecords = loadSessionInjectionsBySeq(sessionDir, pointer.injection_seqs ?? []);
  const setupFiles = new Map<string, string>();
  for (const record of injectionRecords) {
    if (record.source_file?.kind === "file") {
      const rel = path.isAbsolute(record.source_file.path)
        ? path.basename(record.source_file.path)
        : record.source_file.path;
      setupFiles.set(rel, record.source_file.content);
    }
  }
  const toolLog = pointer.event === "PreToolUse"
    ? dropTargetPreToolUseLogEntry(
        readToolLogEntriesThroughOffset(sessionDir, snapshot.tool_log_offset),
        pointer.tool_use_id,
      )
    : readToolLogEntriesThroughOffset(sessionDir, snapshot.tool_log_offset);

  const scenario: Scenario = {
    schema_version: 2,
    name: `materialized-seq-${captureSeq}`,
    description: `Materialized from capture seq ${captureSeq} (epoch ${pointer.epoch_id})`,
    transcript: scenarioEntries,
    target: {
      hook: pointer.event as Scenario["target"]["hook"],
      ...((pointer.event === "PreToolUse" || pointer.event === "PostToolUse") && pointer.tool_use_id
        ? { tool_use_ref: pointer.tool_use_id }
        : {}),
    },
    expect: {
      expected: pointer.decision,
      ...(injectionRecords.length > 0
        ? {
            injections: injectionRecords.map((record) => ({
              id: record.id,
              trigger: record.trigger,
              channel: record.channel,
              message_hash: record.message_hash,
              message: record.message,
            })),
            context_output_hash: shortContentHash(combineInjectionMessages(injectionRecords)),
          }
        : {}),
    },
    env: {
      permission_mode: (pointer.permission_mode ?? "default") as NonNullable<Scenario["env"]>["permission_mode"],
      adapter: adapterName,
      ...(pointer.event !== "SessionStart" ? { session_start_permission_mode: "default" as const } : {}),
      ...(adapterName === "codex" && pointer.plan_mode?.active
        ? { codex_collaboration_mode: "plan" as const }
        : {}),
    },
    ...(setupFiles.size > 0
      ? {
          setup_files: [...setupFiles.entries()].map(([setupPath, content]) => ({
            path: setupPath,
            content,
          })),
        }
      : {}),
    ...(pointer.plan_mode
      ? {
          seed_sidecars: {
            plan_mode_state: pointer.plan_mode.previous ?? snapshot.plan_mode_state,
          },
        }
      : {}),
    seed_state: {
      currentPrediction: seedCurrentPrediction(state.currentPrediction),
      frustrationStreak: state.frustrationStreak,
      currentWindowSize: state.currentWindowSize,
      ...(toolLog.length > 0 ? { toolLog } : {}),
    },
  };

  return scenario;
}
