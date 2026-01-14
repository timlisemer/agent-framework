#!/usr/bin/env node
/**
 * StatusLine Script for Claude Code
 *
 * This script is called by Claude Code's statusLine feature.
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
import {
  readStatusLineEntries,
  STATUSLINE_CONFIG,
  type StatusLineEntry,
} from "../utils/statusline-state.js";

/**
 * JSON input structure from Claude Code statusLine.
 */
interface StatusLineInput {
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
  "error-acknowledge": "Error Check",
  "error-ack": "Error Check",
  "response-align": "Response Align",
  "style-drift": "Style Drift",
  "plan-validate": "Plan Validate",
  "question-validate": "Question Validate",
  "intent-validate": "Intent Validate",
  "claude-md-validate": "Claude MD Check",
  "validate-intent": "Intent Validate",
  check: "Check",
  confirm: "Confirm",
  commit: "Commit",
};

/**
 * Get display name for an agent.
 */
function getAgentDisplayName(agent: string): string {
  return AGENT_DISPLAY_NAMES[agent] || capitalizeWords(agent);
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
function formatEntry(entry: StatusLineEntry): string {
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

/**
 * Filter entries to show: all running + last completed.
 */
function filterEntries(entries: StatusLineEntry[]): StatusLineEntry[] {
  const running = entries.filter((e) => e.status === "running");
  const completed = entries.filter((e) => e.status === "completed");

  // Get the most recent completed entry
  const lastCompleted = completed.length > 0 ? [completed[0]] : [];

  // Return all running + last completed
  return [...running, ...lastCompleted];
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

    const input: StatusLineInput = JSON.parse(raw);
    if (!input.cwd) {
      return;
    }

    // Build left side: 📁 folder-name  branch
    const folderName = getFolderName(input.cwd);
    const gitBranch = getGitBranch(input.cwd);

    let leftSide = `${SYMBOLS.folder} ${folderName}`;
    if (gitBranch) {
      leftSide += ` ${SYMBOLS.gitBranch} ${gitBranch}`;
    }

    // Build right side: agent activity
    let rightSide = "";
    if (input.transcript_path) {
      const entries = await readStatusLineEntries(
        input.transcript_path,
        STATUSLINE_CONFIG.displayCount
      );

      if (entries.length > 0) {
        const filtered = filterEntries(entries);
        if (filtered.length > 0) {
          rightSide = filtered.map(formatEntry).join(` ${SYMBOLS.entryDivider} `);
        }
      }
    }

    // Combine: left ║ right (or just left if no activity)
    if (rightSide) {
      process.stdout.write(`${leftSide} ${SYMBOLS.sectionDivider} ${rightSide}`);
    } else {
      process.stdout.write(leftSide);
    }
  } catch {
    // On error, output nothing (don't break statusLine)
  }
}

main();
