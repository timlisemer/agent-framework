#!/usr/bin/env npx tsx
/**
 * Transcript Replay — full session replay through the real hook system.
 *
 * Reads a JSONL transcript, creates a test-run session directory,
 * fires session-start, then walks each line firing the appropriate
 * hook. State accumulates naturally across calls.
 *
 * Usage:
 *   npx tsx test-harness/replay.ts --transcript <path.jsonl> [--expect '<json>'] [--cwd <dir>] [--timeout 60000]
 *
 * Exit codes: 0 = all scored passed (or no expectations), 1 = any scored failed, 2 = error
 *
 * @module test-harness/replay
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { ReplayEvent, ReplaySummary, ReplayExpectations, ReplayArgs } from "./lib/types.js";
import { classifyLine, extractCwd } from "./lib/classifier.js";
import { runHook, cleanupBackgroundProcesses } from "./lib/harness.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BASE_DIR = path.join(os.homedir(), ".agent-framework");
const TEST_RUNS_DIR = path.join(BASE_DIR, "test-runs");
const MIN_PREFIX_LENGTH = 12;

// ─── Arg Parsing ────────────────────────────────────────────────────────────

function parseArgs(): ReplayArgs {
  const args = process.argv.slice(2);

  function getArg(name: string, required: boolean = false): string | undefined {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= args.length) {
      if (required) {
        console.error(`Error: --${name} is required`);
        process.exit(2);
      }
      return undefined;
    }
    return args[idx + 1];
  }

  const list = args.includes("--list");
  const expand = getArg("expand");
  const depthRaw = getArg("depth");
  const depth = depthRaw ? parseInt(depthRaw, 10) : 1;
  const transcript = getArg("transcript", true)!;
  const timeoutRaw = getArg("timeout");
  const timeout = timeoutRaw ? parseInt(timeoutRaw, 10) : 60000;
  const cwd = getArg("cwd");

  let expect: ReplayExpectations | undefined;
  const expectRaw = getArg("expect");
  if (expectRaw) {
    try {
      // Try as inline JSON first
      expect = JSON.parse(expectRaw);
    } catch {
      // Try as file path
      try {
        const fileContent = fs.readFileSync(expectRaw, "utf-8");
        expect = JSON.parse(fileContent);
      } catch {
        console.error("Error: --expect must be valid JSON string or path to a .json file");
        process.exit(2);
      }
    }
  }

  return { transcript, expect, cwd, timeout, list, expand, depth };
}

// ─── Expectation Matching ───────────────────────────────────────────────────

function matchExpectation(
  expectations: ReplayExpectations | undefined,
  key: string,
): string | undefined {
  if (!expectations) return undefined;

  // Exact match first
  if (expectations[key] !== undefined) return expectations[key];

  // Prefix match for tool_use_ids (minimum 12 chars)
  for (const [prefix, value] of Object.entries(expectations)) {
    if (prefix.length >= MIN_PREFIX_LENGTH && key.startsWith(prefix)) {
      return value;
    }
  }

  return undefined;
}

// ─── Tool Log Reader ────────────────────────────────────────────────────────

function readLastToolLogEntry(sessionDir: string): { gate?: string; reason?: string } {
  const toolLogPath = path.join(sessionDir, "tool-log.jsonl");
  try {
    const content = fs.readFileSync(toolLogPath, "utf-8");
    const logLines = content.split("\n").filter(Boolean);
    if (logLines.length > 0) {
      const lastEntry = JSON.parse(logLines[logLines.length - 1]);
      return { gate: lastEntry.gate, reason: lastEntry.reason };
    }
  } catch {
    // No tool-log yet
  }
  return {};
}

// ─── Stale Sweep ────────────────────────────────────────────────────────────

function sweepStaleTestRuns(): void {
  try {
    const entries = fs.readdirSync(TEST_RUNS_DIR);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const entry of entries) {
      const runDir = path.join(TEST_RUNS_DIR, entry);
      try {
        const stat = fs.statSync(runDir);
        if (stat.mtimeMs > oneHourAgo) continue;

        // Check if replay.pid exists and process is alive
        const pidFile = path.join(runDir, "replay.pid");
        try {
          const pidContent = fs.readFileSync(pidFile, "utf-8").trim();
          const pid = parseInt(pidContent, 10);
          if (!isNaN(pid)) {
            try {
              process.kill(pid, 0);
              // Process is alive — skip this dir
              continue;
            } catch {
              // Process is dead — safe to remove
            }
          }
        } catch {
          // No replay.pid — safe to remove
        }

        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // No test-runs dir yet
  }
}

// ─── Hook Spawning Helpers ──────────────────────────────────────────────────

function hookScript(name: string): string {
  return path.join(REPO_ROOT, "dist", "hooks", `${name}.js`);
}

function buildEnv(sessionDir: string, cwd: string): Record<string, string> {
  return {
    AGENT_FRAMEWORK_ROOT: REPO_ROOT,
    CLAUDE_PROJECT_DIR: cwd,
    AGENT_FRAMEWORK_SESSION_DIR: sessionDir,
  };
}

// ─── List Mode ─────────────────────────────────────────────────────────────

/**
 * Find the next real user prompt after a given line index.
 * Skips tool_result messages and system-injected (isMeta) messages.
 * Returns the prompt text (truncated to 200 chars) or undefined.
 */
function findNextUserReaction(lines: Record<string, unknown>[], afterIndex: number): string | undefined {
  for (let j = afterIndex + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.type !== "user" || line.isMeta === true) continue;

    const message = line.message as Record<string, unknown> | undefined;
    const content = message?.content;

    // Skip tool_result messages
    if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (block: Record<string, unknown>) => block.type === "tool_result"
      );
      if (hasToolResult) continue;

      const textBlocks = content.filter(
        (block: Record<string, unknown>) => block.type === "text"
      );
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b: Record<string, unknown>) => b.text as string).join("\n");
        return text.slice(0, 200);
      }
    }

    if (typeof content === "string" && content.length > 0) {
      return content.slice(0, 200);
    }
  }
  return undefined;
}

/**
 * Summarize a transcript line into a compact context entry.
 */
function summarizeLine(lines: Record<string, unknown>[], index: number): Record<string, unknown> | null {
  const line = lines[index];
  const type = line.type as string | undefined;
  if (!type) return null;

  const classification = classifyLine(line, lines, index);
  const message = line.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if (classification.kind === "pre-tool-use") {
    return {
      line: index,
      role: "assistant",
      type: "tool_use",
      tools: classification.blocks.map((b) => ({ tool: b.name, id: b.id })),
    };
  }

  if (classification.kind === "stop-response-check") {
    let text: string | undefined;
    if (Array.isArray(content)) {
      const textBlocks = content.filter((b: Record<string, unknown>) => b.type === "text");
      if (textBlocks.length > 0) {
        text = textBlocks.map((b: Record<string, unknown>) => b.text as string).join("\n").slice(0, 300);
      }
    }
    return { line: index, role: "assistant", type: "stop", text };
  }

  if (classification.kind === "post-tool-use") {
    return {
      line: index,
      role: "tool_result",
      type: "tool_result",
      tool_use_ids: classification.results.map((r) => r.tool_use_id),
    };
  }

  if (classification.kind === "user-prompt-submit") {
    return { line: index, role: "user", type: "prompt", text: classification.prompt.slice(0, 300) };
  }

  // For assistant lines that aren't tool_use or stop (e.g. thinking, streaming chunks)
  if (type === "assistant") {
    let text: string | undefined;
    if (Array.isArray(content)) {
      const textBlocks = content.filter((b: Record<string, unknown>) => b.type === "text");
      if (textBlocks.length > 0) {
        text = textBlocks.map((b: Record<string, unknown>) => b.text as string).join("\n").slice(0, 300);
      }
    }
    if (text) return { line: index, role: "assistant", type: "text", text };
  }

  return null;
}

/**
 * List all tool calls and stop points with the next user reaction.
 */
function listToolCalls(lines: Record<string, unknown>[]): void {
  for (let i = 0; i < lines.length; i++) {
    const classification = classifyLine(lines[i], lines, i);

    if (classification.kind === "pre-tool-use") {
      const reaction = findNextUserReaction(lines, i);
      for (const block of classification.blocks) {
        const entry: Record<string, unknown> = {
          line: i,
          type: "tool_use",
          tool: block.name,
          id: block.id,
        };
        if (reaction) entry.user_reaction = reaction;
        console.log(JSON.stringify(entry));
      }
    }

    if (classification.kind === "stop-response-check") {
      const reaction = findNextUserReaction(lines, i);
      const entry: Record<string, unknown> = {
        line: i,
        type: "stop",
        key: `stop:${i}`,
      };
      if (reaction) entry.user_reaction = reaction;
      console.log(JSON.stringify(entry));
    }
  }
}

/**
 * Expand context around a specific tool_use_id or stop key.
 * Shows ±(3 * depth) summarized messages around the target line.
 */
function expandContext(
  lines: Record<string, unknown>[],
  target: string,
  depth: number,
): void {
  // Find the target line
  let targetLine = -1;

  if (target.startsWith("stop:")) {
    targetLine = parseInt(target.slice(5), 10);
  } else {
    // Search for tool_use_id
    for (let i = 0; i < lines.length; i++) {
      const classification = classifyLine(lines[i], lines, i);
      if (classification.kind === "pre-tool-use") {
        for (const block of classification.blocks) {
          if (block.id === target || block.id.startsWith(target)) {
            targetLine = i;
            break;
          }
        }
      }
      if (targetLine !== -1) break;
    }
  }

  if (targetLine === -1) {
    console.error(JSON.stringify({ error: `Target "${target}" not found in transcript` }));
    process.exit(2);
  }

  const radius = 3 * depth;
  const startLine = Math.max(0, targetLine - radius);
  const endLine = Math.min(lines.length - 1, targetLine + radius);

  const context: Record<string, unknown>[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const summary = summarizeLine(lines, i);
    if (summary) {
      if (i === targetLine) {
        summary.target = true;
      }
      context.push(summary);
    }
  }

  console.log(JSON.stringify({
    target,
    target_line: targetLine,
    depth,
    range: [startLine, endLine],
    context,
  }));
}

// ─── Main Replay ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  const config = parseArgs();

  // 1. Read all transcript lines
  const rawLines = fs.readFileSync(config.transcript, "utf-8").split("\n").filter(Boolean);
  const lines: Record<string, unknown>[] = rawLines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return {};
    }
  });

  // 1b. List mode — output tool calls and stop points, then exit
  if (config.list) {
    if (config.expand) {
      expandContext(lines, config.expand, config.depth);
    } else {
      listToolCalls(lines);
    }
    process.exit(0);
  }

  // 2. Determine cwd
  const cwd = config.cwd ?? extractCwd(lines) ?? process.cwd();

  // 3. Set environment
  process.env.CLAUDE_PROJECT_DIR = cwd;
  process.env.AGENT_FRAMEWORK_ROOT = REPO_ROOT;

  // 4. Create test-run directory
  const runId = crypto.randomUUID();
  const sessionDir = path.join(TEST_RUNS_DIR, runId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // 5. Write replay.pid
  const replayPidFile = path.join(sessionDir, "replay.pid");
  fs.writeFileSync(replayPidFile, String(process.pid));

  // 6. Set AGENT_FRAMEWORK_SESSION_DIR
  process.env.AGENT_FRAMEWORK_SESSION_DIR = sessionDir;

  // 7. Create empty temp transcript (filename must NOT start with "agent-")
  const transcriptPath = path.join(sessionDir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "");

  // 8. Generate session ID
  const sessionId = "replay-" + runId;

  const env = buildEnv(sessionDir, cwd);
  const results: ReplayEvent[] = [];
  const toolUseMap = new Map<string, { name: string; input: unknown }>();

  // 9. Fire session-start hook
  const sessionStartTime = Date.now();
  try {
    const sessionStartInput = JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
    });

    const sessionStartResult = await runHook({
      hookScript: hookScript("session-start"),
      inputJson: sessionStartInput,
      env,
      timeoutMs: config.timeout,
    });

    results.push({
      line: 0,
      hook: "session-start",
      decision: sessionStartResult.exitCode === 0 ? "ok" : "error",
      ms: Date.now() - sessionStartTime,
      ...(sessionStartResult.exitCode !== 0 && {
        error: sessionStartResult.stderr.slice(0, 500),
      }),
    });
  } catch (err) {
    results.push({
      line: 0,
      hook: "session-start",
      decision: "error",
      ms: Date.now() - sessionStartTime,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 10. Walk transcript lines
  for (let i = 0; i < lines.length; i++) {
    const parsed = lines[i];
    const rawLine = rawLines[i];

    // Append line to temp transcript
    fs.appendFileSync(transcriptPath, rawLine + "\n");

    // Classify the line
    const classification = classifyLine(parsed, lines, i);

    if (classification.kind === "skip") {
      continue;
    }

    if (classification.kind === "user-prompt-submit") {
      const hookStart = Date.now();
      try {
        const input = JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: classification.prompt,
          transcript_path: transcriptPath,
          session_id: sessionId,
          cwd,
        });

        const hookResult = await runHook({
          hookScript: hookScript("user-prompt-submit"),
          inputJson: input,
          env,
          timeoutMs: config.timeout,
        });

        results.push({
          line: i,
          hook: "user-prompt-submit",
          decision: hookResult.exitCode === 0 ? "ok" : "error",
          ms: Date.now() - hookStart,
          ...(hookResult.exitCode !== 0 && {
            error: hookResult.stderr.slice(0, 500),
          }),
        });
      } catch (err) {
        results.push({
          line: i,
          hook: "user-prompt-submit",
          decision: "error",
          ms: Date.now() - hookStart,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    if (classification.kind === "pre-tool-use") {
      for (const block of classification.blocks) {
        // Register in toolUseMap
        toolUseMap.set(block.id, { name: block.name, input: block.input });

        const hookStart = Date.now();
        try {
          const input = JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: sessionId,
            transcript_path: transcriptPath,
            cwd,
            tool_name: block.name,
            tool_input: block.input,
            tool_use_id: block.id,
          });

          const hookResult = await runHook({
            hookScript: hookScript("pre-tool-use"),
            inputJson: input,
            env,
            timeoutMs: config.timeout,
          });

          // Parse decision
          let decision = "allow";
          if (hookResult.timedOut) {
            decision = "timeout";
          } else if (hookResult.exitCode === 1) {
            decision = "error";
          } else {
            try {
              const output = JSON.parse(hookResult.stdout);
              const hookOutput = output.hookSpecificOutput ?? output;
              decision = hookOutput.permissionDecision === "allow" ? "allow" : "deny";
            } catch {
              decision = hookResult.stdout.trim() === "" ? "allow" : "error";
            }
          }

          // Read tool-log for diagnostics
          const { gate, reason } = readLastToolLogEntry(sessionDir);

          // Match against expectations
          const expectedDecision = matchExpectation(config.expect, block.id);

          const event: ReplayEvent = {
            line: i,
            hook: "pre-tool-use",
            tool: block.name,
            id: block.id.slice(0, 16),
            decision,
            ms: Date.now() - hookStart,
          };

          if (gate) event.gate = gate;
          if (reason) event.reason = reason;

          if (expectedDecision !== undefined) {
            event.expected = expectedDecision;
            event.pass = decision === expectedDecision;
          }

          if (hookResult.timedOut) {
            event.error = `Hook timed out after ${config.timeout}ms`;
          } else if (hookResult.exitCode === 1) {
            event.error = hookResult.stderr.slice(0, 500);
          }

          results.push(event);
        } catch (err) {
          results.push({
            line: i,
            hook: "pre-tool-use",
            tool: block.name,
            id: block.id.slice(0, 16),
            decision: "error",
            ms: Date.now() - hookStart,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }

    if (classification.kind === "post-tool-use") {
      for (const result of classification.results) {
        const toolInfo = toolUseMap.get(result.tool_use_id);
        const toolName = toolInfo?.name ?? "unknown";
        const toolInput = toolInfo?.input ?? {};

        // Stringify tool_response if it's an array
        let toolResponse: string;
        if (typeof result.content === "string") {
          toolResponse = result.content;
        } else if (Array.isArray(result.content)) {
          toolResponse = JSON.stringify(result.content);
        } else {
          toolResponse = String(result.content ?? "");
        }

        const hookStart = Date.now();
        try {
          const input = JSON.stringify({
            hook_event_name: "PostToolUse",
            session_id: sessionId,
            transcript_path: transcriptPath,
            cwd,
            tool_name: toolName,
            tool_input: toolInput,
            tool_use_id: result.tool_use_id,
            tool_response: toolResponse,
          });

          const hookResult = await runHook({
            hookScript: hookScript("post-tool-use"),
            inputJson: input,
            env,
            timeoutMs: config.timeout,
          });

          results.push({
            line: i,
            hook: "post-tool-use",
            tool: toolName,
            id: result.tool_use_id.slice(0, 16),
            decision: hookResult.exitCode === 0 ? "ok" : "error",
            ms: Date.now() - hookStart,
            ...(hookResult.exitCode !== 0 && {
              error: hookResult.stderr.slice(0, 500),
            }),
          });
        } catch (err) {
          results.push({
            line: i,
            hook: "post-tool-use",
            tool: toolName,
            id: result.tool_use_id.slice(0, 16),
            decision: "error",
            ms: Date.now() - hookStart,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }

    if (classification.kind === "stop-response-check") {
      const hookStart = Date.now();
      try {
        const input = JSON.stringify({
          hook_event_name: "Stop",
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd,
          stop_hook_active: true,
        });

        const hookResult = await runHook({
          hookScript: hookScript("stop-response-check"),
          inputJson: input,
          env,
          timeoutMs: config.timeout,
        });

        // Parse decision: empty stdout = pass, JSON with decision: "block" = block
        let decision = "pass";
        let reason: string | undefined;
        if (hookResult.timedOut) {
          decision = "timeout";
        } else if (hookResult.stdout.trim() !== "") {
          try {
            const output = JSON.parse(hookResult.stdout);
            decision = output.decision === "block" ? "block" : "pass";
            reason = output.reason;
          } catch {
            decision = "pass";
          }
        }

        // Match against expectations
        const stopKey = `stop:${i}`;
        const expectedDecision = matchExpectation(config.expect, stopKey);

        const event: ReplayEvent = {
          line: i,
          hook: "stop-response-check",
          decision,
          ms: Date.now() - hookStart,
        };

        if (reason) event.reason = reason;

        if (expectedDecision !== undefined) {
          event.expected = expectedDecision;
          event.pass = decision === expectedDecision;
        }

        if (hookResult.timedOut) {
          event.error = `Hook timed out after ${config.timeout}ms`;
        }

        results.push(event);
      } catch (err) {
        results.push({
          line: i,
          hook: "stop-response-check",
          decision: "error",
          ms: Date.now() - hookStart,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
  }

  // 11. Output results as JSONL
  for (const event of results) {
    console.log(JSON.stringify(event));
  }

  // 12. Compute and output summary
  const scored = results.filter((r) => r.pass !== undefined);
  const passed = scored.filter((r) => r.pass === true);
  const failed = scored.filter((r) => r.pass === false);
  const errors = results.filter((r) => r.decision === "error" || r.decision === "timeout");

  const summary: ReplaySummary = {
    type: "summary",
    total: results.length,
    scored: scored.length,
    passed: passed.length,
    failed: failed.length,
    errors: errors.length,
    ms: Date.now() - startTime,
  };
  console.log(JSON.stringify(summary));

  // 13. Cleanup
  await cleanupBackgroundProcesses(sessionDir);

  // Remove replay.pid
  try {
    fs.unlinkSync(replayPidFile);
  } catch {
    // Best-effort
  }

  // Remove test-run dir
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // Best-effort
  }

  // Sweep stale test-run dirs
  sweepStaleTestRuns();

  // Exit with appropriate code
  if (failed.length > 0) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
