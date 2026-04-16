/**
 * Shared runtime helpers for firing a single hook and scoring its result.
 *
 * Extracted from test-harness/replay.ts so both the full-transcript replay
 * path and the scenario (synthetic transcript) path use the same code to:
 *
 * - resolve the hook script file
 * - build the hook process environment
 * - read gate/reason from tool-log.jsonl
 * - parse the raw hook output into a decision string
 * - score a decision against a RichExpectation
 *
 * @module test-harness/lib/hook-runner
 */

import * as fs from "fs";
import * as path from "path";
import type { RichExpectation } from "./types.js";
import type { HookRunResult } from "./harness.js";
import {
  getAllPredictions,
  globMatch,
  matchBlockedToolFromAll,
  toolNameMatches,
  type BlockedTool,
  type ToolPrediction,
} from "../../src/utils/prediction-cache.js";

/**
 * Absolute path to the repo root. This module lives at
 * `test-harness/lib/hook-runner.ts`, so climb two levels to reach the root.
 */
export const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

/**
 * Build-version string used by both replay.ts and scenario.ts reports.
 * Reads package.json + dist/version-data.json relative to REPO_ROOT.
 */
export function getVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
    );
    const [major, minor] = pkg.version.split(".");
    const data = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "dist", "version-data.json"),
        "utf-8",
      ),
    );
    return `${major}.${minor}.${data.commitCount}`;
  } catch {
    return "unknown";
  }
}

/**
 * Resolve the absolute path to a compiled hook script under dist/hooks/.
 */
export function hookScript(name: string): string {
  return path.join(REPO_ROOT, "dist", "hooks", `${name}.js`);
}

/**
 * Build the environment Claude Code hooks expect when spawned by the harness.
 */
export function buildEnv(
  sessionDir: string,
  cwd: string,
): Record<string, string> {
  return {
    AGENT_FRAMEWORK_ROOT: REPO_ROOT,
    CLAUDE_PROJECT_DIR: cwd,
    AGENT_FRAMEWORK_SESSION_DIR: sessionDir,
  };
}

/**
 * Read the most recent entry from the session's tool-log.jsonl. Returns
 * gate + reason or empty when the file doesn't exist / has no entries yet.
 */
export function readLastToolLogEntry(
  sessionDir: string,
): { gate?: string; reason?: string } {
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

/**
 * Read tool-log.jsonl starting at `byteOffset` and return the gate/reason of
 * the last entry in that slice. Used by scenario.ts so the session-start
 * preamble doesn't leak gate entries into the target hook's scoring.
 *
 * Today `src/hooks/session-start.ts` does not append to tool-log.jsonl, so
 * this degrades to `readLastToolLogEntry` (offset is 0). The helper exists
 * as defensive future-proofing against any future session-start edit.
 */
export function readToolLogEntriesAfterOffset(
  sessionDir: string,
  byteOffset: number,
): { gate?: string; reason?: string } {
  const toolLogPath = path.join(sessionDir, "tool-log.jsonl");
  try {
    const fd = fs.openSync(toolLogPath, "r");
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size <= byteOffset) return {};
      const len = stat.size - byteOffset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, byteOffset);
      const slice = buf.toString("utf-8");
      const logLines = slice.split("\n").filter(Boolean);
      if (logLines.length > 0) {
        const lastEntry = JSON.parse(logLines[logLines.length - 1]);
        return { gate: lastEntry.gate, reason: lastEntry.reason };
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No tool-log yet or read failure — fall through
  }
  return {};
}

// ─── Decision parsers ──────────────────────────────────────────────────────

/**
 * Parse the raw hook result of a PreToolUse invocation into a decision
 * string. Matches the branches in the original inline block at the
 * `pre-tool-use` scoring site:
 *
 * - `timedOut` → "timeout"
 * - `exitCode === 1` → "error"
 * - JSON parse success: `hookSpecificOutput?.permissionDecision === "allow"`
 *   → "allow", otherwise "deny"
 * - JSON parse failure with empty stdout → "allow"
 * - JSON parse failure with non-empty stdout → "error"
 */
export function parsePreToolUseDecision(
  hookResult: HookRunResult,
  timeoutMs: number,
): { decision: string; error?: string } {
  if (hookResult.timedOut) {
    return { decision: "timeout", error: `Hook timed out after ${timeoutMs}ms` };
  }
  if (hookResult.exitCode === 1) {
    return { decision: "error", error: hookResult.stderr.slice(0, 500) };
  }
  let decision = "allow";
  try {
    const output = JSON.parse(hookResult.stdout);
    const hookOutput = output.hookSpecificOutput ?? output;
    decision = hookOutput.permissionDecision === "allow" ? "allow" : "deny";
  } catch {
    decision = hookResult.stdout.trim() === "" ? "allow" : "error";
  }
  return { decision };
}

/**
 * Parse the raw hook result of a Stop invocation into a decision string
 * and optional reason. Stop does NOT have an exit-code error branch.
 *
 * - `timedOut` → "timeout"
 * - empty stdout → "pass"
 * - JSON parse success: `decision === "block"` → "block" else "pass"
 * - JSON parse failure → "pass"
 */
export function parseStopDecision(
  hookResult: HookRunResult,
  timeoutMs: number,
): { decision: string; reason?: string; error?: string } {
  if (hookResult.timedOut) {
    return { decision: "timeout", error: `Hook timed out after ${timeoutMs}ms` };
  }
  let decision = "pass";
  let reason: string | undefined;
  if (hookResult.stdout.trim() !== "") {
    try {
      const output = JSON.parse(hookResult.stdout);
      decision = output.decision === "block" ? "block" : "pass";
      reason = output.reason;
    } catch {
      decision = "pass";
    }
  }
  return { decision, reason };
}

/**
 * Parse the raw hook result of a PostToolUse / UserPromptSubmit /
 * SessionStart invocation. These hooks don't emit `permissionDecision`
 * JSON — success/failure is signaled purely by exit code.
 */
export function parseExitCodeDecision(
  hookResult: HookRunResult,
  timeoutMs: number,
): { decision: string; error?: string } {
  if (hookResult.timedOut) {
    return { decision: "timeout", error: `Hook timed out after ${timeoutMs}ms` };
  }
  if (hookResult.exitCode === 0) {
    return { decision: "ok" };
  }
  return { decision: "error", error: hookResult.stderr.slice(0, 500) };
}

// ─── Prediction lookup helpers ────────────────────────────────────────────

/**
 * Look up the active prediction (if any) whose blockedTools matches the
 * given tool invocation. Uses the canonical `getAllPredictions` accessor so
 * expiry / max-entries semantics match production. Returns null when no
 * active prediction matches.
 */
export async function findActivePredictionMatching(
  sessionDir: string,
  toolName: string,
  toolInput: unknown,
): Promise<{ prediction: ToolPrediction; blocked: BlockedTool } | null> {
  const predictions = await getAllPredictions(sessionDir);
  return matchBlockedToolFromAll(toolName, toolInput, predictions);
}

/**
 * Synchronous variant — re-implements getAllPredictions inline by reading
 * the cache JSON. Used by callers that cannot await (the per-event scoring
 * loop). Applies the same expiry / max-entries semantics.
 */
export function findActivePredictionMatchingSync(
  sessionDir: string,
  toolName: string,
  toolInput: unknown,
): { prediction: ToolPrediction; blocked: BlockedTool } | null {
  const filePath = path.join(sessionDir, "prediction-cache.json");
  let entries: ToolPrediction[];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const state = JSON.parse(raw) as { data?: { entries?: ToolPrediction[] } };
    entries = state.data?.entries ?? [];
  } catch {
    return null;
  }
  // Mirror CacheManager.load() semantics: expiry (10 min) + max 20 entries.
  const expiryMs = 10 * 60 * 1000;
  const maxEntries = 20;
  const now = Date.now();
  let filtered = entries.filter((e) => now - e.timestamp < expiryMs);
  if (filtered.length > maxEntries) {
    filtered = filtered.slice(-maxEntries);
  }
  const active = filtered.filter((e) => e.active === true);
  return matchBlockedToolFromAll(toolName, toolInput, active);
}

/**
 * Test whether a prediction's blockedTools entries would match a given
 * forbidden filter. The filter's `tool` is a LITERAL tool name (no regex
 * metachars); the prediction's `entry.toolName` IS often a regex. The
 * matcher asks: "would the prediction's regex match this literal forbidden
 * tool name?".
 */
export function blockedToolsContainsPattern(
  blockedTools: BlockedTool[],
  forbidden: { tool?: string; target_pattern?: string },
): boolean {
  return blockedTools.some((entry) => {
    // Tool match: forbidden.tool is literal, entry.toolName may be regex.
    // toolNameMatches(target, pattern) tests pattern against target.
    const toolMatch =
      forbidden.tool === undefined ||
      toolNameMatches(forbidden.tool, entry.toolName);
    if (!toolMatch) return false;

    if (forbidden.target_pattern === undefined) return true;
    if (entry.targetPattern === undefined) return true;
    return globMatch(forbidden.target_pattern, entry.targetPattern);
  });
}

// ─── Scoring ───────────────────────────────────────────────────────────────

/**
 * Optional context passed into scoreRichExpectation when the caller has
 * tool-name and input information. When omitted, prediction-verdict scoring
 * is skipped (Stop hooks have no tool info, so this degrades gracefully).
 */
export interface ScoreContext {
  sessionDir: string;
  toolName: string;
  toolInput: unknown;
}

/**
 * Score a hook decision against a RichExpectation. Compares decision
 * verbatim, plus (when `exp.by` is set) compares gate verbatim. Returns
 * a specific failure reason when the decision matched but the gate didn't.
 *
 * When `exp.prediction` is set AND `ctx` is provided, additionally scores
 * the prediction-verdict assertions described in
 * test-harness/lib/types.ts:PredictionAnnotation.
 */
export function scoreRichExpectation(
  decision: string,
  gate: string | undefined,
  exp: RichExpectation,
  ctx?: ScoreContext,
): { pass: boolean; reason?: string } {
  const decisionOk = decision === exp.expected;
  const gateOk = !exp.by || exp.by === gate;
  if (decisionOk && gateOk) {
    // Decision and gate matched. Now apply prediction-verdict scoring.
    if (exp.prediction && ctx) {
      const pred = exp.prediction;
      const verdict = pred.verdict;

      if (verdict === "wrong") {
        // The prediction should have been removed/narrowed entirely. If the
        // live decision is STILL deny via prediction-block (or batch-sibling
        // chained to one), we have a regression.
        if (
          decision === "deny" &&
          (gate === "prediction-block" || gate === "batch-sibling")
        ) {
          return {
            pass: false,
            reason: `regression: prediction labeled "wrong" but still blocked at this tool_use`,
          };
        }
      }

      if (verdict === "too_broad" && pred.forbidden_blocks?.length) {
        const livePred = findActivePredictionMatchingSync(
          ctx.sessionDir,
          ctx.toolName,
          ctx.toolInput,
        );
        if (livePred) {
          for (const forbidden of pred.forbidden_blocks) {
            const matches = blockedToolsContainsPattern(
              livePred.prediction.blockedTools,
              forbidden,
            );
            if (matches) {
              return {
                pass: false,
                reason: `regression: prediction still blocks forbidden pattern ${forbidden.tool ?? "*"}:${forbidden.target_pattern ?? "*"}`,
              };
            }
          }
        }
      }

      if (verdict === "correct" && pred.intent_must_contain) {
        const livePred = findActivePredictionMatchingSync(
          ctx.sessionDir,
          ctx.toolName,
          ctx.toolInput,
        );
        if (
          !livePred ||
          !livePred.prediction.blockedIntent.includes(pred.intent_must_contain)
        ) {
          return {
            pass: false,
            reason: `regression: live prediction's blockedIntent no longer contains "${pred.intent_must_contain}"`,
          };
        }
      }
    }
    return { pass: true };
  }
  if (decisionOk && !gateOk) {
    return {
      pass: false,
      reason: `decision matched (${decision}) but wrong rule: got ${JSON.stringify(gate ?? "")}, expected ${JSON.stringify(exp.by)}`,
    };
  }
  return { pass: false };
}
