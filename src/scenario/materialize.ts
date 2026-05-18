/**
 * Materialize — reconstruct a v2 Scenario from a capture pointer.
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
import { combineInjectionMessages, loadSessionInjectionsBySeq, shortContentHash } from "../utils/session-injections.js";
import { activeSpec, adapterSpecByName } from "../adapter/spec.js";
import type { ContentBlock, TranscriptEntry } from "../adapter/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readToolLogEntriesThroughOffset(
  sessionDir: string,
  offset: number,
): ToolLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionToolLogFile(sessionDir), "utf-8");
  } catch {
    return [];
  }

  const bounded = raw.slice(0, Math.max(0, Math.min(offset, raw.length)));
  const entries: ToolLogEntry[] = [];
  for (const line of bounded.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ToolLogEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
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

function lineContainsToolUseId(line: Record<string, unknown>, toolUseId: string): boolean {
  const message = line.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((raw) => {
    const block = raw as Record<string, unknown>;
    return block.type === "tool_use" && block.id === toolUseId;
  });
}

function entryContainsToolUseId(entry: TranscriptEntry | null, toolUseId: string): boolean {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "tool_use" && block.id === toolUseId);
}

function sliceLinesForCapture(
  lines: Record<string, unknown>[],
  event: string,
  toolUseId: string | undefined,
): Record<string, unknown>[] {
  if ((event !== "PreToolUse" && event !== "PostToolUse") || !toolUseId) {
    return lines;
  }

  const idx = lines.findIndex((line) => lineContainsToolUseId(line, toolUseId));
  if (idx === -1) return lines;
  return lines.slice(0, idx + 1);
}

function sliceEntriesForCapture(
  entries: readonly (TranscriptEntry | null)[],
  event: string,
  toolUseId: string | undefined,
): readonly (TranscriptEntry | null)[] {
  if ((event !== "PreToolUse" && event !== "PostToolUse") || !toolUseId) {
    return entries;
  }

  const idx = entries.findIndex((entry) => entryContainsToolUseId(entry, toolUseId));
  if (idx === -1) return entries;
  return entries.slice(0, idx + 1);
}

function blocksFromContent(content: unknown): ScenarioBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ScenarioBlock[] = [];
  for (const raw of content) {
    const b = raw as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      out.push({ type: "thinking", thinking: b.thinking });
    } else if (b.type === "tool_use") {
      out.push({
        type: "tool_use",
        id: b.id as string | undefined,
        name: b.name as string,
        input: (b.input ?? {}) as Record<string, unknown>,
      });
    } else if (b.type === "tool_result") {
      out.push({
        type: "tool_result",
        tool_use_id: b.tool_use_id as string,
        content: b.content as string | unknown[],
        is_error: b.is_error as boolean | undefined,
      });
    }
  }
  return out;
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
        content: block.content ?? "",
        is_error: block.is_error,
      });
    }
  }
  return out;
}

/**
 * Project a JSONL transcript slice (lines anchored at anchorUuid or from
 * the beginning) into ScenarioEntry[]. Returns entries in chronological order.
 */
function projectTranscriptToEntries(
  lines: Record<string, unknown>[],
  anchorUuid: string | null,
): ScenarioEntry[] {
  let startIdx = 0;
  if (anchorUuid) {
    const idx = lines.findIndex((l) => l.uuid === anchorUuid);
    if (idx !== -1) startIdx = idx;
  }

  const entries: ScenarioEntry[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const type = line.type as string | undefined;
    const message = line.message as Record<string, unknown> | undefined;

    if (type === "user" && message) {
      const content = message.content;
      const entry: ScenarioUserEntry = {
        role: "user",
        content:
          typeof content === "string"
            ? content
            : blocksFromContent(content),
        isMeta: line.isMeta === true ? true : undefined,
      };
      entries.push(entry);
    } else if (type === "assistant" && message) {
      const blocks = blocksFromContent(message.content);
      if (blocks.length > 0) {
        const entry: ScenarioAssistantEntry = {
          role: "assistant",
          content: blocks,
        };
        entries.push(entry);
      }
    }
    // Skip other line types (tool_result lines are embedded in user content blocks).
  }
  return entries;
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

function inferAdapterNameFromTranscriptPath(transcriptPath: string): string | null {
  if (transcriptPath.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  if (transcriptPath.includes(`${path.sep}.claude${path.sep}`)) return "claude";
  return null;
}

function rawAnchorStartIndex(
  rawLines: readonly Record<string, unknown>[],
  anchorUuid: string | null,
): number {
  if (!anchorUuid) return 0;
  const idx = rawLines.findIndex((line) => line.uuid === anchorUuid);
  return idx === -1 ? 0 : idx;
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
  const spec = adapterSpecByName(adapterName);
  const rawTranscriptLines = fs.readFileSync(transcriptPath, "utf-8").split("\n").filter((line) => line.trim());
  const rawJsonLines = rawTranscriptLines.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  const anchorUuid = pointer.transcript_anchor_uuid ?? epoch?.anchor_uuid ?? null;
  const rawStartIdx = rawAnchorStartIndex(rawJsonLines, anchorUuid);
  const anchoredRawTranscriptLines = rawTranscriptLines.slice(rawStartIdx);
  const anchoredRawJsonLines = rawJsonLines.slice(rawStartIdx);
  const parsedEntries = sliceEntriesForCapture(
    spec.parseTranscript(anchoredRawTranscriptLines),
    pointer.event,
    pointer.tool_use_id,
  );
  const lines = sliceLinesForCapture(
    anchoredRawJsonLines,
    pointer.event,
    pointer.tool_use_id,
  );
  const entries = projectCanonicalTranscriptToEntries(
    parsedEntries,
    rawStartIdx === 0 ? anchorUuid : null,
  );
  const fallbackEntries = entries.length > 0 ? entries : projectTranscriptToEntries(lines, anchorUuid);

  if (fallbackEntries.length === 0) {
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
    transcript: fallbackEntries,
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
      currentPrediction: state.currentPrediction ?? {
        mood: "neutral",
        trust: "normal",
        intent: "",
        blockedIntent: "",
        explicitlyAllowedTools: [],
        explicitlyBlockedSubstrings: [],
        userMessageSnippet: "",
      },
      forceCheckPending: state.forceCheckPending,
      frustrationStreak: state.frustrationStreak,
      currentWindowSize: state.currentWindowSize,
      ...(toolLog.length > 0 ? { toolLog } : {}),
    },
  };

  return scenario;
}
