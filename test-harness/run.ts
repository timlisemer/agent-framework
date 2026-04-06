#!/usr/bin/env npx tsx
/**
 * Test Harness CLI — run a single hook test or list testable entries.
 *
 * Usage:
 *   npx tsx test-harness/run.ts --hook pre-tool-use --transcript <path> --line <N> --expect allow
 *   npx tsx test-harness/run.ts --hook stop-response-check --transcript <path> --line <N> --expect pass
 *   npx tsx test-harness/run.ts --list <path>
 *
 * Exit codes: 0 = pass, 1 = fail, 2 = error
 *
 * @module test-harness/run
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { TestResult, HarnessArgs } from "./lib/types.js";
import {
  readTranscriptLines,
  extractCwd,
  sliceTranscript,
  extractToolUseAtLine,
  findLastUserMessage,
  listToolUses,
} from "./lib/transcript-slicer.js";
import { buildSession } from "./lib/session-builder.js";
import { runHook, cleanupBackgroundProcesses, cleanupTempFiles } from "./lib/harness.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// ─── List Mode ───────────────────────────────────────────────────────────────

function handleListMode(transcriptPath: string): void {
  const lines = readTranscriptLines(transcriptPath);
  const entries = listToolUses(lines);

  if (entries.length === 0) {
    console.log("No tool_use entries found in transcript.");
    process.exit(0);
  }

  for (const entry of entries) {
    const inputStr = JSON.stringify(entry.toolInput);
    const truncatedInput = inputStr.length > 100 ? inputStr.slice(0, 100) + "..." : inputStr;
    const truncatedContext = entry.precedingUserMessage
      ? entry.precedingUserMessage.slice(0, 120)
      : "(none)";
    console.log(
      `line:${entry.line} tool:${entry.toolName} plan-mode:${entry.planModeActive ? "yes" : "no"} input:${truncatedInput} context:${truncatedContext}`
    );
  }
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): HarnessArgs | { list: string } {
  const args = process.argv.slice(2);

  // Check for list mode
  const listIdx = args.indexOf("--list");
  if (listIdx !== -1) {
    const listPath = args[listIdx + 1];
    if (!listPath) {
      console.error("Error: --list requires a transcript path");
      process.exit(2);
    }
    return { list: listPath };
  }

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

  const hook = getArg("hook", true) as "pre-tool-use" | "stop-response-check";
  if (hook !== "pre-tool-use" && hook !== "stop-response-check") {
    console.error("Error: --hook must be 'pre-tool-use' or 'stop-response-check'");
    process.exit(2);
  }

  const transcript = getArg("transcript", true)!;
  const lineStr = getArg("line", true)!;
  const expect = getArg("expect", true)!;

  const editIntentRaw = getArg("edit-intent");
  let editIntent: boolean | null | undefined;
  if (editIntentRaw === "true") editIntent = true;
  else if (editIntentRaw === "false") editIntent = false;
  else if (editIntentRaw === "null") editIntent = null;

  const toolCallCountRaw = getArg("tool-call-count");
  const toolCallCount = toolCallCountRaw ? parseInt(toolCallCountRaw, 10) : undefined;

  const timeoutRaw = getArg("timeout");
  const timeout = timeoutRaw ? parseInt(timeoutRaw, 10) : 60000;

  return {
    hook,
    transcript,
    line: parseInt(lineStr, 10),
    expect,
    expectAgent: getArg("expect-agent"),
    label: getArg("label"),
    cwd: getArg("cwd"),
    editIntent,
    toolCallCount,
    timeout,
  };
}

// ─── Test Mode ───────────────────────────────────────────────────────────────

async function runTest(args: HarnessArgs): Promise<void> {
  const startTime = Date.now();
  let sessionDir = "";
  let tempDir = "";

  try {
    // 1. Read transcript
    const lines = readTranscriptLines(args.transcript);

    // 2. Extract default cwd from line 0 metadata
    const cwd = args.cwd ?? extractCwd(lines) ?? process.cwd();

    // 3. Set CLAUDE_PROJECT_DIR BEFORE calling getSessionDir
    process.env.CLAUDE_PROJECT_DIR = cwd;

    // 4. Find target content block
    let toolName = "";
    let toolInput: unknown = {};
    let toolUseId = "";

    if (args.hook === "pre-tool-use") {
      const extracted = extractToolUseAtLine(lines, args.line);
      toolName = extracted.toolName;
      toolInput = extracted.toolInput;
      toolUseId = extracted.toolUseId;
    }

    // 5. Slice transcript into temp copy
    const sliced = sliceTranscript(lines, args.line);
    tempDir = sliced.tempDir;

    // 6. Get last user message hash for state
    const lastUserMsg = findLastUserMessage(lines, args.line);
    const lastUserMsgHash = lastUserMsg
      ? crypto.createHash("md5").update(lastUserMsg).digest("hex").slice(0, 8)
      : "";

    // 7. Build session directory with all state files
    const session = buildSession(sliced.tempTranscriptPath, lines.slice(0, args.line), {
      cwd,
      editIntent: args.editIntent,
      toolCallCount: args.toolCallCount,
      lastUserMessageHash: lastUserMsgHash,
    });
    sessionDir = session.sessionDir;

    // 8. Build hook input JSON
    let inputJson: Record<string, unknown>;

    if (args.hook === "pre-tool-use") {
      inputJson = {
        session_id: session.sessionId,
        transcript_path: sliced.tempTranscriptPath,
        cwd,
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: toolUseId,
      };
    } else {
      inputJson = {
        session_id: session.sessionId,
        transcript_path: sliced.tempTranscriptPath,
        cwd,
        stop_hook_active: true,
      };
    }

    // 9. Set env vars for spawned hook process
    const hookEnv: Record<string, string> = {
      AGENT_FRAMEWORK_ROOT: REPO_ROOT,
      CLAUDE_PROJECT_DIR: cwd,
    };

    // 10. Determine hook script path
    const hookScript = path.join(REPO_ROOT, "dist", "hooks", `${args.hook}.js`);

    // 11. Run the hook
    const result = await runHook({
      hookScript,
      inputJson: JSON.stringify(inputJson),
      env: hookEnv,
      timeoutMs: args.timeout,
    });

    if (result.timedOut) {
      emitResult({
        pass: false,
        hook: args.hook,
        decision: "timeout",
        expected: args.expect,
        label: args.label,
        ms: Date.now() - startTime,
        error: `Hook timed out after ${args.timeout}ms`,
      });
      await cleanup(tempDir, sessionDir);
      process.exit(1);
    }

    if (result.exitCode === 1) {
      // Hook's catch handler — may output deny JSON with error
      emitResult({
        pass: false,
        hook: args.hook,
        decision: "error",
        expected: args.expect,
        label: args.label,
        ms: Date.now() - startTime,
        error: `Hook exited with code 1. stderr: ${result.stderr.slice(0, 500)}`,
      });
      await cleanup(tempDir, sessionDir);
      process.exit(2);
    }

    // 12. Parse hook output
    let decision = "";
    let agent: string | undefined;
    let reason: string | undefined;

    if (args.hook === "pre-tool-use") {
      try {
        const output = JSON.parse(result.stdout);
        const hookOutput = output.hookSpecificOutput ?? output;
        decision = hookOutput.permissionDecision === "allow" ? "allow" : "deny";
      } catch {
        // If stdout is empty or unparseable for pre-tool-use, treat as allow
        decision = result.stdout.trim() === "" ? "allow" : "error";
      }
    } else {
      // stop-response-check: empty stdout = pass, JSON with decision: "block" = block
      if (result.stdout.trim() === "") {
        decision = "pass";
      } else {
        try {
          const output = JSON.parse(result.stdout);
          decision = output.decision === "block" ? "block" : "pass";
          reason = output.reason;
        } catch {
          decision = "pass";
        }
      }
    }

    // 13. Read last tool-log entry for diagnostics
    const toolLogPath = path.join(sessionDir, "tool-log.jsonl");
    try {
      const logContent = fs.readFileSync(toolLogPath, "utf-8");
      const logLines = logContent.split("\n").filter(Boolean);
      if (logLines.length > 0) {
        const lastEntry = JSON.parse(logLines[logLines.length - 1]);
        agent = lastEntry.gate ?? agent;
        reason = lastEntry.reason ?? reason;
      }
    } catch {
      // tool-log may not have new entries
    }

    // 14. Compare against expectations
    const pass =
      decision === args.expect &&
      (!args.expectAgent || agent === args.expectAgent);

    const testResult: TestResult = {
      pass,
      hook: args.hook,
      decision,
      expected: args.expect,
      agent,
      expectedAgent: args.expectAgent,
      reason,
      label: args.label,
      ms: Date.now() - startTime,
    };

    emitResult(testResult);
    await cleanup(tempDir, sessionDir);
    process.exit(pass ? 0 : 1);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitResult({
      pass: false,
      hook: args.hook,
      decision: "error",
      expected: args.expect,
      label: args.label,
      ms: Date.now() - startTime,
      error,
    });
    if (tempDir || sessionDir) {
      await cleanup(tempDir, sessionDir);
    }
    process.exit(2);
  }
}

// ─── Output & Cleanup ───────────────────────────────────────────────────────

function emitResult(result: TestResult): void {
  const json = JSON.stringify(result);
  console.log(json);

  // Append to results/log.jsonl
  const resultsDir = path.join(REPO_ROOT, "test-harness", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.appendFileSync(path.join(resultsDir, "log.jsonl"), json + "\n");
}

async function cleanup(tempDir: string, sessionDir: string): Promise<void> {
  if (sessionDir) {
    await cleanupBackgroundProcesses(sessionDir);
  }
  if (tempDir || sessionDir) {
    cleanupTempFiles(tempDir, sessionDir);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const parsed = parseArgs();

if ("list" in parsed) {
  handleListMode(parsed.list);
} else {
  runTest(parsed);
}
