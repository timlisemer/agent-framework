/**
 * Transcript slicing and tool_use extraction.
 *
 * Reads JSONL transcripts, extracts tool_use entries for list mode,
 * and slices transcripts into temp copies for test execution.
 *
 * @module test-harness/lib/transcript-slicer
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolUseEntry } from "./types.js";

/**
 * Read all lines from a JSONL transcript file.
 */
export function readTranscriptLines(transcriptPath: string): string[] {
  const content = fs.readFileSync(transcriptPath, "utf-8");
  return content.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Extract the cwd from transcript line 0 metadata.
 * Line 0 typically contains session metadata with a `cwd` field.
 */
export function extractCwd(lines: string[]): string | undefined {
  if (lines.length === 0) return undefined;
  try {
    const meta = JSON.parse(lines[0]);
    return meta.cwd ?? meta.workingDirectory ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Slice transcript at a given line number and write to a temp file.
 * Preserves line 0 (session metadata) through line N (inclusive).
 *
 * Returns the path to the temp transcript file and its parent dir.
 */
export function sliceTranscript(
  lines: string[],
  targetLine: number
): { tempTranscriptPath: string; tempDir: string } {
  if (targetLine >= lines.length) {
    throw new Error(
      `Target line ${targetLine} exceeds transcript length (${lines.length} lines)`
    );
  }

  // Validate line 0 is not a subagent sidechain
  try {
    const meta = JSON.parse(lines[0]);
    if (meta.isSidechain === true) {
      throw new Error(
        "Transcript line 0 has isSidechain: true — this is a subagent transcript. " +
          "Use a main transcript instead."
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("isSidechain")) {
      throw err;
    }
    // Parse failure on line 0 is acceptable — metadata may be absent
  }

  const sliced = lines.slice(0, targetLine + 1);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
  // Filename must NOT start with "agent-" and must NOT be in a /subagents/ path
  const tempTranscriptPath = path.join(tempDir, "transcript.jsonl");
  fs.writeFileSync(tempTranscriptPath, sliced.join("\n") + "\n");

  return { tempTranscriptPath, tempDir };
}

/**
 * Find the tool_use content block at the given line number.
 * Scans the parsed JSON for content blocks with type "tool_use".
 */
export function extractToolUseAtLine(
  lines: string[],
  targetLine: number
): { toolName: string; toolInput: unknown; toolUseId: string } {
  if (targetLine >= lines.length) {
    throw new Error(
      `Target line ${targetLine} exceeds transcript length (${lines.length} lines)`
    );
  }

  const parsed = JSON.parse(lines[targetLine]);

  // The line itself might be the tool_use message or contain content blocks
  if (parsed.type === "tool_use") {
    return {
      toolName: parsed.name,
      toolInput: parsed.input,
      toolUseId: parsed.id,
    };
  }

  // Check content array for tool_use blocks
  const content = parsed.content ?? parsed.message?.content ?? [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "tool_use") {
        return {
          toolName: block.name,
          toolInput: block.input,
          toolUseId: block.id,
        };
      }
    }
  }

  throw new Error(
    `No tool_use block found at line ${targetLine}. ` +
      `Found type: ${parsed.type ?? parsed.role ?? "unknown"}`
  );
}

/**
 * Find the last user message text before the target line.
 */
export function findLastUserMessage(lines: string[], beforeLine: number): string {
  for (let i = beforeLine - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.role === "user" || parsed.type === "human") {
        const content = parsed.content ?? parsed.message?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const textBlock = content.find(
            (b: { type: string }) => b.type === "text"
          );
          if (textBlock) return textBlock.text;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  return "";
}

/**
 * Scan a transcript for all testable tool_use entries.
 * Tracks plan mode state via EnterPlanMode/ExitPlanMode markers.
 */
export function listToolUses(lines: string[]): ToolUseEntry[] {
  const entries: ToolUseEntry[] = [];
  let planModeActive = false;
  let lastUserMessage = "";

  for (let i = 0; i < lines.length; i++) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    // Track user messages
    if (parsed.role === "user" || parsed.type === "human") {
      const content = parsed.content ?? parsed.message?.content;
      if (typeof content === "string") {
        lastUserMessage = content;
      } else if (Array.isArray(content)) {
        const textBlock = (content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === "text"
        );
        if (textBlock?.text) lastUserMessage = textBlock.text;
      }
    }

    // Track plan mode transitions
    const content = parsed.content ?? parsed.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type: string; name?: string }>) {
        if (block.type === "tool_use") {
          if (block.name === "EnterPlanMode") planModeActive = true;
          if (block.name === "ExitPlanMode") planModeActive = false;
        }
      }
    }
    if (parsed.type === "tool_use") {
      if (parsed.name === "EnterPlanMode") planModeActive = true;
      if (parsed.name === "ExitPlanMode") planModeActive = false;
    }

    // Extract tool_use entries
    if (parsed.type === "tool_use") {
      entries.push({
        line: i,
        toolName: parsed.name as string,
        toolInput: parsed.input,
        toolUseId: parsed.id as string,
        planModeActive,
        precedingUserMessage: lastUserMessage.slice(0, 200),
      });
    }

    if (Array.isArray(content)) {
      for (const block of content as Array<{
        type: string;
        name?: string;
        input?: unknown;
        id?: string;
      }>) {
        if (block.type === "tool_use") {
          entries.push({
            line: i,
            toolName: block.name ?? "unknown",
            toolInput: block.input,
            toolUseId: block.id ?? "unknown",
            planModeActive,
            precedingUserMessage: lastUserMessage.slice(0, 200),
          });
        }
      }
    }
  }

  return entries;
}
