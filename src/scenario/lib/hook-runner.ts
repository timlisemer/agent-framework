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
import { readJsonl } from "../../utils/file-io.js";
import { sessionToolLogFile, sessionStateFile, agentFrameworkRoot, distAdapterHookScript, packageJsonPath } from "../../utils/paths.js";
import type {
  ReasonMustExpectation,
  ReasonMustResult,
  RichExpectation,
} from "./replay-types.js";
import type { HookRunResult } from "./harness.js";
import {
  decidePrediction,
  type PredictionDecision,
  type ToolPrediction,
} from "../../utils/prediction-types.js";

/**
 * Absolute path to the repo root.
 * Delegates to paths.agentFrameworkRoot() which uses AGENT_FRAMEWORK_ROOT env
 * or climbs from import.meta.url.
 */
export const REPO_ROOT = agentFrameworkRoot();

/**
 * Build-version string used by both replay.ts and scenario.ts reports.
 * Reads package.json + dist/version-data.json relative to REPO_ROOT.
 */
export function getVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(packageJsonPath(), "utf-8"),
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
 * Resolve the absolute path to a compiled adapter hook script.
 * When `adapter` is omitted, defaults to the Claude adapter.
 */
export function hookScript(name: string, adapter?: string): string {
  return distAdapterHookScript(name, adapter);
}

/**
 * Build the environment hooks expect when spawned by the harness.
 *
 * `extra` merges additional env vars on top of the defaults — used by
 * scenario.ts to plumb `AGENT_FRAMEWORK_LLM_STUBS` into the hook process so
 * agent-runner can stub LLM calls deterministically.
 *
 * When `adapter` is provided it is forwarded as `AGENT_FRAMEWORK_ADAPTER`
 * so the hook subprocess uses the correct adapter.
 */
export function buildEnv(
  sessionDir: string,
  cwd: string,
  extra?: Record<string, string>,
  adapter?: string,
): Record<string, string> {
  void sessionDir;
  return {
    AGENT_FRAMEWORK_ROOT: REPO_ROOT,
    CLAUDE_PROJECT_DIR: cwd,
    ...(adapter ? { AGENT_FRAMEWORK_ADAPTER: adapter } : {}),
    ...(extra ?? {}),
  };
}

/**
 * Read the most recent entry from the session's tool-log.jsonl. Returns
 * gate + reason or empty when the file doesn't exist / has no entries yet.
 */
export function readLastToolLogEntry(
  sessionDir: string,
): { gate?: string; reason?: string } {
  const entries = readJsonl<{ gate?: string; reason?: string }>(
    sessionToolLogFile(sessionDir),
    { tail: 1 },
  );
  return entries.length > 0 ? { gate: entries[0].gate, reason: entries[0].reason } : {};
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
  const entries = readJsonl<{ gate?: string; reason?: string }>(
    sessionToolLogFile(sessionDir),
    { byteOffset },
  );
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    return { gate: last.gate, reason: last.reason };
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
): { decision: string; reason?: string; error?: string } {
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
  const statePath = sessionStateFile(sessionDir);
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
  const statePath = sessionStateFile(sessionDir);
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
 * Optional context passed into scoreRichExpectation. The prediction-verdict
 * branch already gates on `ctx?` truthiness, so making sessionDir/toolName/
 * toolInput optional keeps that branch's behavior unchanged while allowing
 * Stop-hook scoring to pass `actualReason` alone (no tool info available).
 */
export interface ScoreContext {
  sessionDir?: string;
  toolName?: string;
  toolInput?: unknown;
  /**
   * Hook's raw reason string verbatim, used by the `reason_must` scoring
   * branch. PreToolUse/PostToolUse callers pass the gate-attributed reason
   * from `tool-log.jsonl`; Stop callers pass the reason from the hook's
   * stdout JSON.
   */
  actualReason?: string;
}

/**
 * Evaluate a `reason_must` block against the hook's raw reason text. Iterates
 * clauses in fixed order: contains, not_contains, matches, not_matches.
 * Within each array, iterates entries left-to-right. Returns one
 * ReasonMustResult per clause checked, stopping on the first failure (so the
 * array contains all-passed clauses up to and including the failing entry).
 * On full success, returns one entry per clause checked, all `pass: true`.
 *
 * `undefined` reason is treated as the empty string for matching purposes.
 * `matches` / `not_matches` regex sources are unanchored — `re.test(reason)`
 * is substring-match-like.
 */
export function evaluateReasonMust(
  reason: string | undefined,
  exp: ReasonMustExpectation,
): ReasonMustResult[] {
  const text = reason ?? "";
  const out: ReasonMustResult[] = [];
  if (exp.contains) {
    for (const pattern of exp.contains) {
      const pass = text.includes(pattern);
      out.push({ kind: "contains", pattern, pass });
      if (!pass) return out;
    }
  }
  if (exp.not_contains) {
    for (const pattern of exp.not_contains) {
      const pass = !text.includes(pattern);
      out.push({ kind: "not_contains", pattern, pass });
      if (!pass) return out;
    }
  }
  if (exp.matches) {
    for (const pattern of exp.matches) {
      const pass = new RegExp(pattern).test(text);
      out.push({ kind: "matches", pattern, pass });
      if (!pass) return out;
    }
  }
  if (exp.not_matches) {
    for (const pattern of exp.not_matches) {
      const pass = !new RegExp(pattern).test(text);
      out.push({ kind: "not_matches", pattern, pass });
      if (!pass) return out;
    }
  }
  return out;
}

/**
 * Format a single failed ReasonMustResult into a human-readable scoring
 * message. Matches the strings called out in the plan so failure reports
 * unambiguously identify which clause violated.
 */
export function formatReasonMustFailure(result: ReasonMustResult): string {
  switch (result.kind) {
    case "contains":
      return `reason missing required substring "${result.pattern}"`;
    case "not_contains":
      return `reason contains forbidden substring "${result.pattern}"`;
    case "matches":
      return `reason did not match required regex /${result.pattern}/`;
    case "not_matches":
      return `reason matched forbidden regex /${result.pattern}/`;
  }
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
): { pass: boolean; reason?: string; reason_must_results?: ReasonMustResult[] } {
  const decisionOk = decision === exp.expected;
  const gateOk = !exp.by || exp.by === gate;
  if (decisionOk && gateOk) {
    // Decision + gate matched. Reason-text scoring runs strictly inside this
    // branch, so a wrong rule or wrong decision is reported by the existing
    // checks below first — reason_must never conflates "wrong rule" with
    // "right rule, wrong message".
    if (exp.reason_must) {
      const reasonMustResults = evaluateReasonMust(
        ctx?.actualReason,
        exp.reason_must,
      );
      const firstFailure = reasonMustResults.find((r) => !r.pass);
      if (firstFailure) {
        return {
          pass: false,
          reason: formatReasonMustFailure(firstFailure),
          reason_must_results: reasonMustResults,
        };
      }
    }
    // Decision and gate matched. Now apply prediction-verdict scoring.
    // Prediction-verdict scoring requires sessionDir/toolName/toolInput;
    // when any are missing (Stop-hook callers, or callers that pass only
    // actualReason for reason_must) the prediction branch is skipped.
    if (
      exp.prediction &&
      ctx &&
      ctx.sessionDir !== undefined &&
      ctx.toolName !== undefined
    ) {
      const sessionDir = ctx.sessionDir;
      const toolName = ctx.toolName;
      const toolInput = ctx.toolInput;
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
          sessionDir,
          toolName,
          toolInput,
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
          sessionDir,
          toolName,
          toolInput,
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
          sessionDir,
          toolName,
          toolInput,
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
          sessionDir,
          toolName,
          toolInput,
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
