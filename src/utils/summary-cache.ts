/**
 * Summary document management, JSONL tool log, and session state.
 *
 * Manages per-session summary markdown files, structured tool logs in
 * JSONL format, and session state via CacheManager. All files live in
 * the unified session directory under ~/.agent-framework/.
 *
 * @module summary-cache
 */

import * as fs from "fs";
import * as path from "path";
import {
  CacheManager,
  getSessionDir as getSessionDirFromCacheManager,
} from "./cache-manager.js";
import { readMarkdownSection } from "./markdown-parser.js";

export interface SummaryDocument {
  userIntent: string;
  userApprovals: string;
  aiActions: string;
  flaggedMisalignments: string;
}

export interface ToolLogEntry {
  ts: number;
  tool: string;
  path?: string;
  cmd?: string;
  status: string;
  gate: string;
  reason?: string;
  ms: number;
}

export interface SessionState {
  lastUserMessageHash: string;
  summaryVersion: number;
  toolCallCount: number;
  toolCallsSinceUpdate: number;
  lastUpdated: number;
  currentEditIntent: boolean | null;
  previousEditIntent: boolean | null;
  editIntentTimestamp: number;
  editIntentOverturnCount: number;
}

type SessionStateManager = CacheManager<SessionState>;

const EMPTY_SUMMARY_TEMPLATE = `## User Intent

(No intent captured yet)

## User Approvals

(No approvals yet)

## AI Actions

(No actions recorded yet)

## Flagged Misalignments

(No misalignments detected)
`;

/**
 * Resolve the summary file path for a given transcript.
 * Uses a hardcoded "summary.md" name, consistent with all other session files.
 * Includes one-time migration for old slug/hash-named .md files.
 */
export function getSummaryPath(transcriptPath: string): string {
  const sessionDir = getSessionDir(transcriptPath);
  const summaryPath = path.join(sessionDir, "summary.md");

  if (!fs.existsSync(summaryPath)) {
    // Migrate: rename any existing .md file from old slug/hash naming
    try {
      const entries = fs.readdirSync(sessionDir);
      const oldMd = entries.filter((e) => e.endsWith(".md") && e !== "summary.md")[0];
      if (oldMd) {
        fs.renameSync(path.join(sessionDir, oldMd), summaryPath);
      }
    } catch {
      // Migration is best-effort
    }
  }

  return summaryPath;
}

/**
 * Re-export getSessionDir from cache-manager.
 * All session files live under ~/.agent-framework/sessions/{project}/{hash}/.
 */
export function getSessionDir(transcriptPath: string): string {
  return getSessionDirFromCacheManager(transcriptPath);
}

/**
 * Read a single markdown section from a summary file.
 */
export async function readSection(summaryPath: string, sectionName: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(summaryPath, "utf-8");
    return readMarkdownSection(content, sectionName);
  } catch {
    return "";
  }
}

/**
 * Read a full summary file into a SummaryDocument.
 */
export async function readSummary(summaryPath: string): Promise<SummaryDocument> {
  const content = await fs.promises.readFile(summaryPath, "utf-8");
  return {
    userIntent: readMarkdownSection(content, "User Intent"),
    userApprovals: readMarkdownSection(content, "User Approvals"),
    aiActions: readMarkdownSection(content, "AI Actions"),
    flaggedMisalignments: readMarkdownSection(content, "Flagged Misalignments"),
  };
}

/**
 * Acquire a simple file lock for summary file writes.
 * Uses exclusive file creation (wx flag) with stale lock cleanup after 1s.
 */
async function acquireSummaryLock(lockPath: string): Promise<void> {
  const maxAttempts = 10;
  const retryDelay = 10;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fs.promises.writeFile(lockPath, String(process.pid), { flag: "wx" });
      return;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        try {
          const stat = await fs.promises.stat(lockPath);
          if (Date.now() - stat.mtimeMs > 1000) {
            const tempPath = `${lockPath}.${process.pid}.stale`;
            try {
              await fs.promises.rename(lockPath, tempPath);
              await fs.promises.unlink(tempPath);
            } catch {
              // Another process removed the stale lock
            }
            continue;
          }
        } catch {
          continue;
        }
        await new Promise((r) => setTimeout(r, retryDelay));
        continue;
      }
      return;
    }
  }
}

/**
 * Release a summary file lock.
 */
async function releaseSummaryLock(lockPath: string): Promise<void> {
  try {
    await fs.promises.unlink(lockPath);
  } catch {
    // Ignore - lock may not exist
  }
}

/**
 * Update a single section in a summary file.
 * Uses file locking for concurrency safety.
 */
export async function updateSection(summaryPath: string, sectionName: string, content: string): Promise<void> {
  const lockPath = summaryPath + ".lock";
  await acquireSummaryLock(lockPath);
  try {
    if (!fs.existsSync(summaryPath)) {
      await createEmptySummary(summaryPath);
    }
    const fileContent = await fs.promises.readFile(summaryPath, "utf-8");
    const lines = fileContent.split("\n");
    const marker = `## ${sectionName}`;
    const result: string[] = [];
    let inside = false;
    let replaced = false;

    for (let i = 0; i < lines.length; i++) {
      if (!inside) {
        result.push(lines[i]);
        if (lines[i].trim() === marker) {
          inside = true;
          result.push("");
          result.push(content);
          replaced = true;
        }
      } else {
        if (lines[i].startsWith("## ")) {
          inside = false;
          result.push(lines[i]);
        }
        // Skip old section content
      }
    }

    if (!replaced) {
      result.push("");
      result.push(marker);
      result.push("");
      result.push(content);
    }

    await fs.promises.writeFile(summaryPath, result.join("\n"));
  } finally {
    await releaseSummaryLock(lockPath);
  }
}

/**
 * Append a tool log entry to the session's JSONL tool log.
 */
export function appendToolLog(sessionDir: string, entry: ToolLogEntry): void {
  fs.appendFileSync(path.join(sessionDir, "tool-log.jsonl"), JSON.stringify(entry) + "\n");
}

/**
 * Read the last N entries from the tool log as parsed ToolLogEntry objects.
 */
export function readToolLogEntries(sessionDir: string, count: number): ToolLogEntry[] {
  const logPath = path.join(sessionDir, "tool-log.jsonl");
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-count);
    const entries: ToolLogEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as ToolLogEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Read the last N entries from the tool log as readable text.
 */
export function readToolLogTail(sessionDir: string, count: number): string {
  const logPath = path.join(sessionDir, "tool-log.jsonl");
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-count);
    return tail
      .map((line) => {
        try {
          const entry: ToolLogEntry = JSON.parse(line);
          const detail = entry.path ?? entry.cmd ?? "";
          const reason = entry.reason ? ` (${entry.reason})` : "";
          return `[${new Date(entry.ts).toISOString()}] ${entry.tool} ${entry.status} ${entry.gate} ${detail}${reason} ${entry.ms}ms`;
        } catch {
          return line;
        }
      })
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Format a brief description of a tool call for logging.
 */
export function formatToolDetail(toolName: string, toolInput: unknown): string {
  const input = toolInput as Record<string, unknown>;
  switch (toolName) {
    case "Edit":
      return `Edit ${input?.file_path ?? "unknown"}`;
    case "Bash": {
      const cmd = String(input?.command ?? "");
      return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    case "Read":
      return `Read ${input?.file_path ?? "unknown"}`;
    case "Glob":
      return `Glob ${input?.pattern ?? "unknown"}`;
    case "Grep":
      return `Grep ${input?.pattern ?? "unknown"}`;
    case "Write":
      return `Write ${input?.file_path ?? "unknown"}`;
    default:
      return toolName;
  }
}

/**
 * Delete a summary file and clean up its session directory.
 * Since the summary now lives in the session dir, removing the dir handles both.
 */
export async function deleteSummary(transcriptPath: string): Promise<void> {
  const sessionDir = getSessionDir(transcriptPath);
  try {
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }
}

/**
 * Check if the summary is stale based on tool calls since last update.
 */
export async function isStaleSummary(sessionDir: string): Promise<boolean> {
  const manager = getSessionState(sessionDir);
  const state = await manager.load();
  return state.toolCallsSinceUpdate > 10;
}

/**
 * Forward-scan a transcript file starting from a given line number.
 */
export async function readTranscriptForward(filePath: string, fromLine: number): Promise<string> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  const lines = content.split("\n");
  return lines.slice(fromLine).join("\n");
}

/**
 * Get a CacheManager-based session state manager for the given session directory.
 */
export function getSessionState(sessionDir: string): SessionStateManager {
  return new CacheManager<SessionState>({
    filePath: path.join(sessionDir, "state.json"),
    defaultData: () => ({
      lastUserMessageHash: "",
      summaryVersion: 0,
      toolCallCount: 0,
      toolCallsSinceUpdate: 0,
      lastUpdated: Date.now(),
      currentEditIntent: null,
      previousEditIntent: null,
      editIntentTimestamp: 0,
      editIntentOverturnCount: 0,
    }),
  });
}

/**
 * Create a summary file with empty section headers.
 */
export async function createEmptySummary(summaryPath: string): Promise<void> {
  const dir = path.dirname(summaryPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(summaryPath)) {
    await fs.promises.writeFile(summaryPath, EMPTY_SUMMARY_TEMPLATE);
  }
}

// Active subagent counter — consolidated in subagent-detector.ts
export { getActiveSubagentCount, incrementActiveSubagents, decrementActiveSubagents } from "./subagent-detector.js";
