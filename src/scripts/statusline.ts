#!/usr/bin/env node
/**
 * StatusLine Script for Claude Code
 *
 * This script is called by Claude Code's statusLine feature.
 * It reads the recent decision state and outputs formatted text.
 *
 * Input (stdin): JSON with conversation context including transcript_path
 * Output (stdout): Formatted statusline text
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
  // Other fields ignored
}

/**
 * Short agent names for compact display.
 */
const SHORT_AGENT_NAMES: Record<string, string> = {
  "tool-approve": "approve",
  "tool-appeal": "appeal",
  "error-acknowledge": "err-ack",
  "error-ack": "err-ack",
  "response-align": "align",
  "style-drift": "style",
  "question-validate": "q-valid",
  "plan-validate": "plan",
  "claude-md-validate": "md",
  "intent-validate": "intent",
  "lazy-validation": "lazy",
};

/**
 * Format agent name for compact display.
 */
function formatAgent(agent: string): string {
  return SHORT_AGENT_NAMES[agent] || agent;
}

/**
 * Format decision type for display.
 */
function formatDecision(decision: string): string {
  switch (decision) {
    case "APPROVE":
      return "OK";
    case "DENY":
      return "DENY";
    case "CONFIRM":
      return "CONF";
    case "CONTINUE":
      return "CONT";
    case "ERROR":
      return "ERR";
    case "SUCCESS":
      return "OK";
    default:
      return decision;
  }
}

/**
 * Format latency for display.
 */
function formatLatency(latencyMs: number): string {
  if (latencyMs === 0) {
    return "fast";
  }
  if (latencyMs < 1000) {
    return `${latencyMs}ms`;
  }
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

/**
 * Format a single entry for statusline display.
 * Format: agent:DECISION tool(latency)
 */
function formatEntry(entry: StatusLineEntry): string {
  const agent = formatAgent(entry.agent);
  const decision = formatDecision(entry.decision);
  const tool = entry.toolName;
  const latency = formatLatency(entry.latencyMs);

  return `${agent}:${decision} ${tool}(${latency})`;
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
    if (!input.transcript_path) {
      return;
    }

    const entries = await readStatusLineEntries(
      input.transcript_path,
      STATUSLINE_CONFIG.displayCount
    );

    if (entries.length === 0) {
      return;
    }

    const formatted = entries.map(formatEntry).join(" | ");
    process.stdout.write(`[AF] ${formatted}`);
  } catch {
    // On error, output nothing (don't break statusLine)
  }
}

main();
