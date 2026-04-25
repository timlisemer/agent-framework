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
  decidePrediction,
  type PredictionDecision,
  type ToolPrediction,
} from "../../src/utils/prediction-types.js";

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
 * Read the live `currentPrediction` from `state.json` and return both it and
 * the policy `decidePrediction` would render for the given tool. Returns null
 * when no prediction is active.
 *
 * Async variant for callers that can `await`.
 */
export async function findActivePredictionMatching(
  sessionDir: string,
  toolName: string,
  toolInput: unknown,
): Promise<{ prediction: ToolPrediction; decision: PredictionDecision } | null> {
  const statePath = path.join(sessionDir, "state.json");
  try {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      data?: {
        currentPrediction?: ToolPrediction | null;
        frustrationStreak?: number;
      };
    };
    const pred = parsed.data?.currentPrediction;
    if (!pred) return null;
    const decision = decidePrediction(
      pred,
      toolName,
      toolInput,
      parsed.data?.frustrationStreak ?? 0,
    );
    return { prediction: pred, decision };
  } catch {
    return null;
  }
}

/**
 * Synchronous variant — used by callers that cannot await (the per-event
 * scoring loop).
 */
export function findActivePredictionMatchingSync(
  sessionDir: string,
  toolName: string,
  toolInput: unknown,
): { prediction: ToolPrediction; decision: PredictionDecision } | null {
  const statePath = path.join(sessionDir, "state.json");
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      data?: {
        currentPrediction?: ToolPrediction | null;
        frustrationStreak?: number;
      };
    };
    const pred = parsed.data?.currentPrediction;
    if (!pred) return null;
    const decision = decidePrediction(
      pred,
      toolName,
      toolInput,
      parsed.data?.frustrationStreak ?? 0,
    );
    return { prediction: pred, decision };
  } catch {
    return null;
  }
}

/**
 * Test whether the live prediction's `explicitlyBlockedSubstrings` contains
 * an entry that would match a given forbidden filter. Both `tool` and
 * `target_pattern` are LITERAL strings — `target_pattern` is treated as a
 * substring matcher against the entry's `targetSubstring`.
 */
export function explicitlyBlockedContainsForbidden(
  blocks: ToolPrediction["explicitlyBlockedSubstrings"],
  forbidden: { tool?: string; target_pattern?: string },
): boolean {
  return blocks.some((entry) => {
    if (forbidden.tool !== undefined && entry.tool !== forbidden.tool) return false;
    if (forbidden.target_pattern === undefined) return true;
    if (entry.targetSubstring === undefined) return false;
    return entry.targetSubstring.includes(forbidden.target_pattern);
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
            const matches = explicitlyBlockedContainsForbidden(
              livePred.prediction.explicitlyBlockedSubstrings,
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
          !livePred.prediction.intent.includes(pred.intent_must_contain)
        ) {
          return {
            pass: false,
            reason: `regression: live prediction's intent no longer contains "${pred.intent_must_contain}"`,
          };
        }
      }

      if (pred.expected_mood !== undefined) {
        const livePred = findActivePredictionMatchingSync(
          ctx.sessionDir,
          ctx.toolName,
          ctx.toolInput,
        );
        if (!livePred || livePred.prediction.mood !== pred.expected_mood) {
          return {
            pass: false,
            reason: `regression: live prediction mood is ${livePred ? livePred.prediction.mood : "(none)"}, expected ${pred.expected_mood}`,
          };
        }
      }

      if (pred.expected_trust !== undefined) {
        const livePred = findActivePredictionMatchingSync(
          ctx.sessionDir,
          ctx.toolName,
          ctx.toolInput,
        );
        if (!livePred || livePred.prediction.trust !== pred.expected_trust) {
          return {
            pass: false,
            reason: `regression: live prediction trust is ${livePred ? livePred.prediction.trust : "(none)"}, expected ${pred.expected_trust}`,
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
