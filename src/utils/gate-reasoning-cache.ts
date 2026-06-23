/**
 * Gate reasoning persistent memory for tool-approve/tool-appeal decision history.
 * Tracks ALLOWED/DENIED decisions with optional LLM notes and deterministic
 * pattern warnings. Maintains a condensed history of evicted high-priority
 * entries for long-term context retention.
 */

import * as path from "path";
import { CacheManager } from "./cache-manager.js";
import { readJsonl } from "./file-io.js";
import { sessionGateReasoningFile, sessionToolLogFile } from "./paths.js";
import { isTextEditToolName } from "./edit-tools.js";

const NORMAL_PRIORITY_LIMIT = 8;
const HIGH_PRIORITY_LIMIT = 12;
const CONDENSED_HISTORY_MAX_CHARS = 500;
const DEFAULT_RECENT_COUNT = 8;

export interface GateReasoningEntry {
  toolCallIndex: number;
  timestamp: number;
  toolName: string;
  toolTarget: string;
  decision: "ALLOWED" | "DENIED";
  note?: string;
  warnings: string[];
  appealOutcome?: string;
  priority: "normal" | "high";
}

export interface GateReasoningData {
  entries: GateReasoningEntry[];
  condensedHistory: string;
}

let cacheManager: CacheManager<GateReasoningData> | null = null;

function getManager(sessionDir: string): CacheManager<GateReasoningData> {
  if (!cacheManager) {
    initGateReasoningSession(sessionDir);
  }
  return cacheManager!;
}

/**
 * Initialize the gate reasoning cache for a session directory.
 * Sets the CacheManager file path to {sessionDir}/gate-reasoning.json.
 */
export function initGateReasoningSession(sessionDir: string): void {
  cacheManager = new CacheManager<GateReasoningData>({
    filePath: sessionGateReasoningFile(sessionDir),
    defaultData: () => ({ entries: [], condensedHistory: "" }),
  });
}

/**
 * Clear all gate reasoning entries and condensed history.
 * Called on plan approval (ExitPlanMode) to give the implementation phase a clean slate.
 */
export async function clearGateReasoning(sessionDir: string): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.clear();
}

function truncateCondensedHistory(text: string): string {
  if (text.length <= CONDENSED_HISTORY_MAX_CHARS) {
    return text;
  }
  return text.slice(0, CONDENSED_HISTORY_MAX_CHARS - 3) + "...";
}

function extractTextForCondensing(entry: GateReasoningEntry): string {
  const parts: string[] = [];
  if (entry.note) {
    parts.push(`NOTE: ${entry.note}`);
  }
  for (const warning of entry.warnings) {
    parts.push(warning);
  }
  return parts.join("; ");
}

/**
 * Add a new entry to the gate reasoning cache.
 * Evicts normal-priority entries if > 8, high-priority if > 12.
 * Evicted high-priority entries have their NOTE/WARNING text condensed.
 */
export async function addEntry(sessionDir: string, entry: GateReasoningEntry): Promise<void> {
  const manager = getManager(sessionDir);

  await manager.update((data) => {
    const updated = { ...data, entries: [...data.entries, entry] };

    const normalEntries = updated.entries.filter((e) => e.priority === "normal");
    const highEntries = updated.entries.filter((e) => e.priority === "high");

    // Evict normal-priority entries beyond the limit (oldest first)
    if (normalEntries.length > NORMAL_PRIORITY_LIMIT) {
      const toEvict = normalEntries.length - NORMAL_PRIORITY_LIMIT;
      let evicted = 0;
      updated.entries = updated.entries.filter((e) => {
        if (e.priority === "normal" && evicted < toEvict) {
          evicted++;
          return false;
        }
        return true;
      });
    }

    // Evict high-priority entries beyond the limit (oldest first)
    if (highEntries.length > HIGH_PRIORITY_LIMIT) {
      const toEvict = highEntries.length - HIGH_PRIORITY_LIMIT;
      let evicted = 0;
      const condensedParts: string[] = [];

      updated.entries = updated.entries.filter((e) => {
        if (e.priority === "high" && evicted < toEvict) {
          evicted++;
          const text = extractTextForCondensing(e);
          if (text) {
            condensedParts.push(text);
          }
          return false;
        }
        return true;
      });

      if (condensedParts.length > 0) {
        const newCondensed = updated.condensedHistory
          ? `${updated.condensedHistory}; ${condensedParts.join("; ")}`
          : condensedParts.join("; ");
        updated.condensedHistory = truncateCondensedHistory(newCondensed);
      }
    }

    return updated;
  });
}

/**
 * Get the last N entries from the gate reasoning cache.
 */
export async function getRecentEntries(
  sessionDir: string,
  count: number = DEFAULT_RECENT_COUNT
): Promise<GateReasoningEntry[]> {
  const manager = getManager(sessionDir);
  const data = await manager.load();
  return data.entries.slice(-count);
}

/**
 * Get the condensed history string from evicted high-priority entries.
 */
export async function getCondensedHistory(sessionDir: string): Promise<string> {
  const manager = getManager(sessionDir);
  const data = await manager.load();
  return data.condensedHistory;
}

/**
 * Format condensed history and recent entries as readable text for agent prompt injection.
 */
export async function formatForPrompt(sessionDir: string): Promise<string> {
  const manager = getManager(sessionDir);
  const data = await manager.load();
  const recent = data.entries.slice(-DEFAULT_RECENT_COUNT);

  const parts: string[] = [];

  if (data.condensedHistory) {
    parts.push(`Condensed: ${data.condensedHistory}`);
  }

  if (recent.length > 0) {
    if (parts.length > 0) {
      parts.push("");
    }
    for (const entry of recent) {
      let line = `- [tool-${entry.toolCallIndex}] ${entry.decision} ${entry.toolName}`;
      if (entry.toolTarget) {
        line += `: ${entry.toolTarget}`;
      }
      if (entry.note) {
        line += `. NOTE: ${entry.note}`;
      }
      for (const warning of entry.warnings) {
        line += `. ${warning}`;
      }
      if (entry.appealOutcome) {
        line += `. APPEAL: ${entry.appealOutcome}`;
      }
      parts.push(line);
    }
  }

  return parts.join("\n");
}

interface ToolLogEntry {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function readToolLog(sessionDir: string): ToolLogEntry[] {
  return readJsonl<ToolLogEntry>(sessionToolLogFile(sessionDir));
}

/**
 * Deterministic pattern detection based on tool log history.
 * Returns an array of warning/note strings for the current tool call.
 */
export async function addPatternWarnings(
  toolName: string,
  toolInput: unknown,
  sessionDir: string
): Promise<string[]> {
  const warnings: string[] = [];
  const logEntries = readToolLog(sessionDir);

  // Git command counting
  const gitCommands = logEntries.filter((entry) => {
    if (entry.tool_name === "Bash") {
      const command = (entry.tool_input as { command?: string })?.command || "";
      return command.startsWith("git ") || command.includes("| git ");
    }
    return false;
  });
  if (gitCommands.length >= 2) {
    warnings.push(
      `WARNING: ${gitCommands.length} git commands recently. Block git writes unless user approves.`
    );
  }

  // Repeated file edits
  if (isTextEditToolName(toolName)) {
    const input = toolInput as { file_path?: string };
    const targetFile = input?.file_path;
    if (targetFile) {
      const editCount = logEntries.filter((entry) => {
        if (entry.tool_name && isTextEditToolName(entry.tool_name)) {
          return (entry.tool_input as { file_path?: string })?.file_path === targetFile;
        }
        return false;
      }).length;
      if (editCount >= 3) {
        warnings.push(
          `NOTE: Multiple edits to ${targetFile}. If AI attempts to edit other files, verify scope.`
        );
      }
    }
  }

  // Denial pattern similarity (with safeguards against feedback loops)
  const manager = getManager(sessionDir);
  const data = await manager.load();
  const now = Date.now();
  const DENIAL_TTL_MS = 120_000; // 2 minutes - stale denials are not relevant
  const deniedEntries = data.entries.filter((e) =>
    e.decision === "DENIED" &&
    e.appealOutcome !== "OVERTURNED" &&
    (now - e.timestamp) < DENIAL_TTL_MS
  );
  if (deniedEntries.length > 0) {
    const currentTarget = extractTarget(toolName, toolInput);
    // Require 2+ recent denials to same target before warning (one denial could be wrong)
    const similarDenials = deniedEntries.filter(
      (d) => d.toolTarget && currentTarget && isSimilarTarget(d.toolTarget, currentTarget)
    );
    if (similarDenials.length >= 2) {
      warnings.push(
        `WARNING: ${similarDenials.length} recent denials similar to this action. Possible workaround attempt.`
      );
    }
  }

  return warnings;
}

function extractTarget(toolName: string, toolInput: unknown): string {
  const input = toolInput as Record<string, unknown>;
  if (input?.file_path) return String(input.file_path);
  if (input?.command) return String(input.command);
  if (input?.path) return String(input.path);
  return toolName;
}

function isSimilarTarget(targetA: string, targetB: string): boolean {
  // Same file path
  if (targetA === targetB) return true;
  // Same directory
  const dirA = path.dirname(targetA);
  const dirB = path.dirname(targetB);
  if (dirA !== "." && dirB !== "." && dirA === dirB) return true;
  return false;
}

/**
 * Parse an optional NOTE line from agent output after an APPROVE/DENY decision.
 * Returns the text after "NOTE: " or undefined if no NOTE found.
 */
export function extractGateNote(agentOutput: string): string | undefined {
  const match = agentOutput.match(/^NOTE:\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * Find an entry by toolCallIndex and set its appealOutcome.
 */
export async function updateAppealOutcome(
  sessionDir: string,
  toolCallIndex: number,
  outcome: string
): Promise<void> {
  const manager = getManager(sessionDir);

  await manager.update((data) => {
    const entries = data.entries.map((entry) => {
      if (entry.toolCallIndex === toolCallIndex) {
        return { ...entry, appealOutcome: outcome };
      }
      return entry;
    });
    return { ...data, entries };
  });
}
