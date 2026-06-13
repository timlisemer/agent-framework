/**
 * Justfile/Makefile introspection for context-aware blacklist messages.
 *
 * Detects whether a project has a Justfile or Makefile with a "check" target,
 * extracts the target body, and produces 4-tier error messages based on
 * whether the blocked command is covered by the check target.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckTargetContext {
  /** Which runner was detected, null if no file found */
  runner: "just" | "make" | null;
  /** Whether the file contains a "check" target/recipe */
  hasCheckTarget: boolean;
  /** Extracted body of the check target (empty string if none) */
  checkBody: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const contextCache = new Map<string, CheckTargetContext>();

export function clearCheckTargetCache(): void {
  contextCache.clear();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const BUILD_FILES: { name: string; runner: "just" | "make" }[] = [
  { name: "Justfile", runner: "just" },
  { name: "justfile", runner: "just" },
  { name: "Makefile", runner: "make" },
];

/**
 * Extract the body of the "check" recipe/target from file content.
 *
 * - Justfile: recipe starts with `check` (possibly `@check`) at column 0,
 *   body is subsequent indented lines until the next unindented non-empty line.
 * - Makefile: target starts with `check:` at column 0,
 *   body is subsequent tab-indented lines.
 */
export function extractCheckBody(content: string, format: "just" | "make"): string | null {
  const lines = content.split("\n");
  const headerPattern = format === "just" ? /^@?check\b/ : /^check\s*:/;

  let inBody = false;
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (!inBody) {
      if (headerPattern.test(line)) {
        inBody = true;
      }
      continue;
    }

    // Justfile: any indented line (spaces or tabs) is part of the body
    // Makefile: only tab-indented lines are part of the body
    const isBodyLine = format === "just"
      ? /^\s+/.test(line)
      : line.startsWith("\t");

    if (isBodyLine || line.trim() === "") {
      bodyLines.push(line);
    } else {
      break;
    }
  }

  return bodyLines.length > 0 ? bodyLines.join("\n") : null;
}

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

export function getCheckTargetContext(workingDir: string): CheckTargetContext {
  const cached = contextCache.get(workingDir);
  if (cached) return cached;

  for (const { name, runner } of BUILD_FILES) {
    const filePath = path.join(workingDir, name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const checkBody = extractCheckBody(content, runner === "just" ? "just" : "make");
    const ctx: CheckTargetContext = {
      runner,
      hasCheckTarget: checkBody !== null,
      checkBody: checkBody ?? "",
    };
    contextCache.set(workingDir, ctx);
    return ctx;
  }

  const ctx: CheckTargetContext = { runner: null, hasCheckTarget: false, checkBody: "" };
  contextCache.set(workingDir, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// Message resolution
// ---------------------------------------------------------------------------

import { renderCheckMcpAction } from "./policy-message-rendering.js";

function getAction(): string {
  return renderCheckMcpAction();
}

function isDirectCheckRunnerCommand(patternName: string): boolean {
  return patternName === "just check" || patternName === "make check";
}

/**
 * Produce a context-aware error message for a blocked command.
 *
 * Four tiers based on what was found in the project:
 * 1. No Justfile/Makefile found
 * 2. File found but no check target
 * 3. Check target exists but doesn't cover the command
 * 4. Check target covers the command (via an equivalent)
 */
export function resolveCheckMessage(
  patternName: string,
  equivalents: string[],
  workingDir: string,
): string {
  const ctx = getCheckTargetContext(workingDir);

  const action = getAction();

  if (!ctx.runner) {
    return `${patternName} is check-routed. No Justfile/Makefile found. ${action}`;
  }

  if (!ctx.hasCheckTarget) {
    return `${patternName} is check-routed. ${ctx.runner === "just" ? "Justfile" : "Makefile"} found but no check target. ${action}`;
  }

  if (isDirectCheckRunnerCommand(patternName)) {
    return `${patternName} shell command is blocked. ${action}`;
  }

  const body = ctx.checkBody.toLowerCase();
  const matched = equivalents.find((eq) => body.includes(eq.toLowerCase()));

  if (!matched) {
    return `${patternName} is not covered by the detected check target. ${action}`;
  }

  return `${patternName} is covered by the agent-framework check MCP (matched check target entry: ${matched}). ${action}`;
}
