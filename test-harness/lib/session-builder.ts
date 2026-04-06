/**
 * Session directory builder for the test harness.
 *
 * Creates a fully populated session directory with all state files
 * in the CacheState wrapper format expected by the framework.
 *
 * @module test-harness/lib/session-builder
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { CacheState, SessionState, defaultSessionState } from "./types.js";

// Import getSessionDir from the compiled dist — no production code changes
import { getSessionDir } from "../../dist/utils/cache-manager.js";

/**
 * Reconstruct tool-log.jsonl entries from prior tool_use/tool_result pairs
 * in the transcript prefix.
 */
function reconstructToolLog(lines: string[]): string {
  const logLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    // Look for tool_use blocks
    const content = parsed.content ?? parsed.message?.content;
    const toolUses: Array<{ name: string; input: unknown; id: string }> = [];

    if (parsed.type === "tool_use") {
      toolUses.push({
        name: parsed.name as string,
        input: parsed.input,
        id: parsed.id as string,
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
          toolUses.push({
            name: block.name ?? "unknown",
            input: block.input,
            id: block.id ?? "unknown",
          });
        }
      }
    }

    for (const tu of toolUses) {
      const input = tu.input as Record<string, unknown> | undefined;

      logLines.push(
        JSON.stringify({
          ts: Date.now() - (lines.length - i) * 1000,
          tool: tu.name,
          path: input?.file_path ?? undefined,
          cmd: tu.name === "Bash" ? input?.command ?? undefined : undefined,
          status: "allowed",
          gate: "harness-replay",
          reason: "reconstructed from transcript",
          ms: 0,
        })
      );
    }
  }

  return logLines.join("\n") + (logLines.length > 0 ? "\n" : "");
}

/**
 * Build a summary.md template from the first user message in the transcript.
 */
function buildSummaryTemplate(lines: string[]): string {
  let userIntent = "(No intent captured yet)";

  for (let i = 0; i < lines.length; i++) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (parsed.role === "user" || parsed.type === "human") {
      const content = parsed.content ?? parsed.message?.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        const textBlock = (content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === "text"
        );
        if (textBlock?.text) text = textBlock.text;
      }
      if (text) {
        userIntent = text.length > 500 ? text.slice(0, 500) + "..." : text;
        break;
      }
    }
  }

  return [
    "## User Intent",
    "",
    userIntent,
    "",
    "## User Approvals",
    "",
    "(No approvals yet)",
    "",
    "## AI Actions",
    "",
    "(No actions recorded yet)",
    "",
    "## Flagged Misalignments",
    "",
    "(No misalignments detected)",
    "",
  ].join("\n");
}

/**
 * Build a fully populated session directory for a test execution.
 *
 * Sets CLAUDE_PROJECT_DIR, calls getSessionDir to auto-create the session dir,
 * then populates all required state files in CacheState wrapper format.
 *
 * @returns The session directory path and generated session ID
 */
export function buildSession(
  tempTranscriptPath: string,
  transcriptLines: string[],
  options: {
    cwd: string;
    editIntent?: boolean | null;
    toolCallCount?: number;
    lastUserMessageHash?: string;
  }
): { sessionDir: string; sessionId: string } {
  // CLAUDE_PROJECT_DIR must already be set before this call
  const sessionDir = getSessionDir(tempTranscriptPath);
  const sessionId = "harness-" + crypto.randomUUID();

  const toolCallCount = options.toolCallCount ?? 10;

  // 1. state.json
  const stateData: SessionState = defaultSessionState({
    toolCallCount,
    toolCallsSinceUpdate: toolCallCount,
    currentEditIntent: options.editIntent ?? null,
    lastUserMessageHash: options.lastUserMessageHash ?? "",
  });
  const stateWrapper: CacheState<SessionState> = {
    sessionId,
    data: stateData,
  };
  fs.writeFileSync(
    path.join(sessionDir, "state.json"),
    JSON.stringify(stateWrapper)
  );

  // 2. tool-log.jsonl — reconstructed from prior tool_use pairs
  const toolLogContent = reconstructToolLog(transcriptLines);
  fs.writeFileSync(path.join(sessionDir, "tool-log.jsonl"), toolLogContent);

  // 3. summary.md
  const summaryContent = buildSummaryTemplate(transcriptLines);
  fs.writeFileSync(path.join(sessionDir, "summary.md"), summaryContent);

  // 4. gate-reasoning.json
  writeWrapped(sessionDir, "gate-reasoning.json", sessionId, { entries: [], condensedHistory: "" });

  // 5. prediction-cache.json
  writeWrapped(sessionDir, "prediction-cache.json", sessionId, {});

  // 6. correction-cache.json
  writeWrapped(sessionDir, "correction-cache.json", sessionId, []);

  // 7. hook-denials.json
  writeWrapped(sessionDir, "hook-denials.json", sessionId, {});

  // 8. rewind-cache.json
  writeWrapped(sessionDir, "rewind-cache.json", sessionId, {});

  // 9. active-subagents.json
  writeWrapped(sessionDir, "active-subagents.json", sessionId, { count: 0 });

  return { sessionDir, sessionId };
}

/**
 * Write a file in CacheState wrapper format.
 */
function writeWrapped(
  sessionDir: string,
  filename: string,
  sessionId: string,
  data: unknown
): void {
  const wrapper: CacheState<unknown> = { sessionId, data };
  fs.writeFileSync(
    path.join(sessionDir, filename),
    JSON.stringify(wrapper)
  );
}
