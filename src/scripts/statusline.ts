#!/usr/bin/env node
// agent-framework-style-drift-ignore-file
/**
 * StatusLine Script for the host agent
 *
 * This script is called by the host agent's statusLine feature.
 * It reads the recent decision state and outputs formatted text.
 *
 * Input (stdin): JSON with conversation context including transcript_path and cwd
 * Output (stdout): Formatted statusline text
 *
 * Format: 📁 folder-name  branch ║ 🔄 Agent (Tool) │ ✓ Agent [latency]
 *
 * Usage in claude/settings.json:
 * {
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node $AGENT_FRAMEWORK_ROOT/dist/scripts/statusline.js"
 *   }
 * }
 *
 * @module scripts/statusline
 */

import { execSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "node:url";
import { createAgentFrameworkScenarioRuntime } from "../effects/scenario-runtime-factory.js";
import { canonicalHookRunId } from "../entrypoints/host-run-id.js";
import { activeSpec } from "../adapter/spec.js";
import {
  canonicalRuleStatusLineEntries,
  filterRuleStatusLineEntries,
  type CanonicalRuleStatusLineEntry,
} from "./statusline-projection.js";

/**
 * JSON input structure from the host agent's statusLine.
 */
export interface StatusLineInput {
  transcript_path: string;
  cwd: string;
}

// Visual symbols
const SYMBOLS = {
  folder: "📁",
  gitBranch: "", // Nerd font git branch icon
  sectionDivider: "║",
  entryDivider: "│",
  running: "🔄",
  approved: "✓",
  denied: "✗",
} as const;

/**
 * Agent display names - proper capitalization for readability.
 */
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  "tool-approve": "Tool Approve",
  "tool-appeal": "Tool Appeal",
  "response-align": "Response Align",
  "response-align-stop": "Response Align (Stop)",
  "plan-validate": "Plan Validate",
  "question-validate": "Question Validate",
  "claude-md-validate": "Claude MD Check",
  "validate-intent": "Intent Validate",
  "sentiment": "Sentiment",
  "rule-gate": "Rule Gate",
  "prediction-context": "Prediction Context",
  "recent-messages": "Recent Messages",
  "reasoning-history": "Reasoning History",
  "edit-intent-context": "Edit Intent Context",
  "plan-mode-context": "Plan Mode Context",
  "intent-fulfillment-context": "Intent Fulfillment Context",
  "plan-mode-step-context": "Plan Mode Step Context",
  "error-acknowledge": "Error Ack",
  check: "Check",
  confirm: "Confirm",
  fullconfirm: "FullConfirm",
  commit: "Commit",
};

/**
 * Get display name for an agent.
 */
function getAgentDisplayName(agent: string): string {
  const canonicalName = agent.replace(/^agent-framework\.rule\./, "");
  return AGENT_DISPLAY_NAMES[canonicalName] || capitalizeWords(canonicalName);
}

/**
 * Capitalize each word in a hyphenated string.
 */
function capitalizeWords(str: string): string {
  return str
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Get decision symbol based on decision type.
 */
function getDecisionSymbol(decision: string | undefined): string {
  if (!decision) return SYMBOLS.running;

  switch (decision) {
    case "APPROVE":
    case "SUCCESS":
    case "CONTINUE":
    case "CONFIRM":
      return SYMBOLS.approved;
    case "DENY":
    case "ERROR":
      return SYMBOLS.denied;
    default:
      return SYMBOLS.approved;
  }
}

/**
 * Format latency for display.
 */
function formatLatency(latencyMs: number | undefined): string {
  if (latencyMs === undefined || latencyMs === 0) {
    return "fast";
  }
  if (latencyMs < 1000) {
    return `${latencyMs}ms`;
  }
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

/**
 * Get git branch name from the working directory.
 */
function getGitBranch(cwd: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Get folder name from path.
 */
function getFolderName(cwd: string): string {
  return path.basename(cwd) || cwd;
}

/**
 * Format a single entry for statusline display.
 */
export function formatStatusLineEntry(entry: CanonicalRuleStatusLineEntry): string {
  const agentName = getAgentDisplayName(entry.agent);

  if (entry.status === "running") {
    // Running: 🔄 Agent Name (Tool)
    return `${SYMBOLS.running} ${agentName} (${entry.toolName})`;
  }

  // Completed: ✓ Agent Name [latency] or ✗ Agent Name [latency]
  const symbol = getDecisionSymbol(entry.decision);
  const latency = formatLatency(entry.latencyMs);
  return `${symbol} ${agentName} [${latency}]`;
}

/** How long to show older completed entries before they fade out (ms) */
const COMPLETED_FADE_MS = 5000;

/**
 * Filter entries to show: all running (except orphaned) + recent completed.
 *
 * Supersession: A terminal record hides only the running row for the same
 * canonical evaluation identity. Older evaluations never hide newer work.
 *
 * Fade out: Each completed entry fades out 5 seconds after completion.
 */
function filterEntries(entries: CanonicalRuleStatusLineEntry[]): CanonicalRuleStatusLineEntry[] {
  return filterRuleStatusLineEntries(entries, Date.now(), COMPLETED_FADE_MS);
}

export async function readCanonicalStatusLineEntries(
  transcriptPath: string,
): Promise<CanonicalRuleStatusLineEntry[]> {
  try {
    const runId = canonicalHookRunId(activeSpec().name, transcriptPath);
    const records = await createAgentFrameworkScenarioRuntime().recordsAfter(runId, 0);
    return canonicalRuleStatusLineEntries(records);
  } catch {
    return [];
  }
}

/**
 * Read JSON from stdin.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      return;
    }

    process.stdout.write(await renderStatusLine(JSON.parse(raw) as StatusLineInput));
  } catch {
    // On error, output nothing (don't break statusLine)
  }
}

/** Render the stable folder/branch prefix even when canonical activity is unavailable. */
export async function renderStatusLine(input: StatusLineInput): Promise<string> {
  if (!input.cwd) return "";
  const folderName = getFolderName(input.cwd);
  const gitBranch = getGitBranch(input.cwd);
  let leftSide = `${SYMBOLS.folder} ${folderName}`;
  if (gitBranch) leftSide += ` ${SYMBOLS.gitBranch} ${gitBranch}`;

  const entries = input.transcript_path
    ? await readCanonicalStatusLineEntries(input.transcript_path)
    : [];
  const filtered = filterEntries(entries);
  const runningSide = filtered
    .filter((entry) => entry.status === "running")
    .map(formatStatusLineEntry)
    .join(` ${SYMBOLS.entryDivider} `);
  const completedSide = filtered
    .filter((entry) => entry.status === "completed")
    .map(formatStatusLineEntry)
    .join(` ${SYMBOLS.entryDivider} `);
  const rightSide = runningSide && completedSide
    ? `${runningSide} ${SYMBOLS.sectionDivider} ${completedSide}`
    : runningSide || completedSide;
  return rightSide ? `${leftSide} ${SYMBOLS.sectionDivider} ${rightSide}` : leftSide;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
