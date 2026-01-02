import "../utils/load-env.js";
import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { approveTool } from "../agents/hooks/tool-approve.js";
import { appealDenial } from "../agents/hooks/tool-appeal.js";
import { validatePlanIntent } from "../agents/hooks/plan-validate.js";
import { checkErrorAcknowledgment } from "../agents/hooks/error-acknowledge.js";
import { validateClaudeMd } from "../agents/hooks/claude-md-validate.js";
import { checkStyleDrift } from "../agents/hooks/style-drift.js";
import { checkIntentAlignment } from "../agents/hooks/intent-align.js";
import { detectWorkaroundPattern } from "../utils/command-patterns.js";
import { logToHomeAssistant } from "../utils/logger.js";
import { markErrorAcknowledged, setSession, checkUserInteraction } from "../utils/ack-cache.js";
import {
  setRewindSession,
  detectRewind,
  recordUserMessage,
  isFirstResponseChecked,
  markFirstResponseChecked,
} from "../utils/rewind-cache.js";
import { readPlanContent } from "../utils/session-utils.js";
import { checkWithAppeal } from "../utils/pre-tool-use-utils.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
  hasErrorPatterns,
} from "../utils/transcript.js";
import {
  APPEAL_COUNTS,
  ERROR_CHECK_COUNTS,
  PLAN_VALIDATE_COUNTS,
  RECENT_TOOL_APPROVAL_COUNTS,
  STYLE_DRIFT_COUNTS,
} from "../utils/transcript-presets.js";

/**
 * Output structured JSON to allow the tool call and exit.
 */
function outputAllow(): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    })
  );
  process.exit(0);
}

/**
 * Output structured JSON to deny the tool call with a reason and exit.
 */
function outputDeny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

// Retry tracking for workaround detection
const DENIAL_CACHE_FILE = "/tmp/claude-hook-denials.json";
const MAX_SIMILAR_DENIALS = 3;
const DENIAL_EXPIRY_MS = 60 * 1000; // 1 minute

interface DenialEntry {
  count: number;
  timestamp: number;
}

interface DenialCache {
  sessionId?: string;
  denials: { [pattern: string]: DenialEntry };
}

let denialSessionId: string | undefined;

function setDenialSession(transcriptPath: string): void {
  denialSessionId = transcriptPath;
}

function loadDenials(): { [pattern: string]: DenialEntry } {
  try {
    if (fs.existsSync(DENIAL_CACHE_FILE)) {
      const data = fs.readFileSync(DENIAL_CACHE_FILE, "utf-8");
      const cache: DenialCache = JSON.parse(data);

      // Clear cache if session changed (new Claude Code session)
      if (denialSessionId && cache.sessionId && cache.sessionId !== denialSessionId) {
        return {};
      }

      // Clean expired entries
      const now = Date.now();
      const denials = cache.denials || {};
      for (const key of Object.keys(denials)) {
        if (now - denials[key].timestamp > DENIAL_EXPIRY_MS) {
          delete denials[key];
        }
      }
      return denials;
    }
  } catch {
    // Ignore errors, return empty cache
  }
  return {};
}

function saveDenials(denials: { [pattern: string]: DenialEntry }): void {
  try {
    const cache: DenialCache = { sessionId: denialSessionId, denials };
    fs.writeFileSync(DENIAL_CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Ignore write errors
  }
}

// File tools that benefit from path-based risk classification
const FILE_TOOLS = ["Read", "Write", "Edit", "NotebookEdit"];

// Sensitive file patterns - always require LLM approval
const SENSITIVE_PATTERNS = [
  ".env",
  "credentials",
  ".ssh",
  ".aws",
  "secrets",
  ".key",
  ".pem",
  "password",
];

function isPathInDirectory(filePath: string, dirPath: string): boolean {
  const resolved = path.resolve(filePath);
  const dirResolved = path.resolve(dirPath);
  return (
    resolved.startsWith(dirResolved + path.sep) || resolved === dirResolved
  );
}

function isTrustedPath(filePath: string, projectDir: string): boolean {
  const claudeDir = path.join(os.homedir(), ".claude");
  return (
    isPathInDirectory(filePath, projectDir) ||
    isPathInDirectory(filePath, claudeDir)
  );
}

function isSensitivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Check if current tool call matches a suggested alternative from a previous denial.
 * Uses conservative exact matching.
 *
 * @param toolName - Current tool being called
 * @param transcript - Recent transcript with tool results
 * @returns true if tool matches a suggestion, skip error-ack check
 */
function matchesSuggestedAlternative(toolName: string, transcript: string): boolean {
  // Only check TOOL_RESULT lines for denied suggestions
  const toolResultLines = transcript
    .split("\n")
    .filter((l) => l.startsWith("TOOL_RESULT:"))
    .join("\n");

  // Conservative patterns - extract exact tool name
  const patterns = [
    /suggested alternative:\s*(?:use\s+)?["']?(\w+)["']?/gi,
    /use\s+["']?(\w+)["']?\s+(?:tool\s+)?instead/gi,
    /use\s+the\s+["']?(\w+)["']?\s+tool/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(toolResultLines)) !== null) {
      const suggested = match[1];
      // Exact match only (conservative)
      if (toolName === suggested) {
        return true;
      }
    }
  }
  return false;
}


async function main() {
  const input: PreToolUseHookInput = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(JSON.parse(data)));
  });

  // Set session ID for cache invalidation on new session
  setSession(input.transcript_path);
  setDenialSession(input.transcript_path);
  setRewindSession(input.transcript_path);

  // Detect rewind - if user rewound, clear all caches
  const rewound = await detectRewind(input.transcript_path);
  if (rewound) {
    logToHomeAssistant({
      agent: "pre-tool-use-hook",
      level: "info",
      problem: "Rewind detected",
      answer: "Cleared all caches, re-validating fresh",
    });
  }

  // Block confirm tool from Claude Code - requires explicit user approval
  // Internal agents (like commit) call runConfirmAgent() directly, bypassing this hook
  if (input.tool_name === "mcp__agent-framework__confirm") {
    const result = await readTranscriptExact(input.transcript_path, {
      counts: { user: 5, assistant: 5 },
    });
    const transcript = formatTranscriptResult(result);
    const toolDescription = `${input.tool_name} with ${JSON.stringify(input.tool_input).slice(0, 200)}`;
    const appeal = await appealDenial(
      toolDescription,
      transcript,
      "Confirm requires explicit user approval. Use /commit or explicitly request confirm."
    );

    if (appeal.approved) {
      outputAllow();
    }

    outputDeny(
      "Confirm requires explicit user approval. Use /commit or explicitly request confirm."
    );
  }

  // Auto-approve low-risk tools and ALL MCP tools
  // These tools are read-only or have no filesystem/system impact
  const LOW_RISK_TOOLS = [
    // Read-only search/navigation
    "LSP", // Language server protocol queries
    "Grep", // File content search
    "Glob", // File pattern matching
    "WebSearch", // Web search
    "WebFetch", // Fetch web content

    // MCP resource reading (read-only)
    "ListMcpResources", // List available MCP resources
    "ReadMcpResource", // Read an MCP resource

    // Internal/meta tools (low impact)
    "TodoWrite", // Task list management (internal to Claude)
    "TaskOutput", // Read output from background tasks
    "AskUserQuestion", // Prompts user for input (safe)
    "ExitPlanMode", // Exit plan mode (internal to Claude)
    "EnterPlanMode", // Enter plan mode (internal to Claude)
    "Skill", // Invoke skills like /commit (user-initiated)
  ];
  if (
    LOW_RISK_TOOLS.includes(input.tool_name) ||
    input.tool_name.startsWith("mcp__")
  ) {
    outputAllow();
  }

  // First-response intent check - detect if AI's first tool call ignores user question/request
  // Only check for action tools (Edit, Write, Bash, etc.) - investigation tools are fine
  // Gate: only run once per user turn (reset when user sends new message or rewinds)
  const ACTION_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash", "Agent", "Task"];
  if (ACTION_TOOLS.includes(input.tool_name) && !isFirstResponseChecked()) {
    const intentResult = await checkIntentAlignment(
      input.tool_name,
      input.tool_input,
      input.transcript_path
    );

    // Mark as checked so we don't run again for subsequent tool calls in same turn
    markFirstResponseChecked();

    if (!intentResult.approved) {
      // Appeal the denial
      const appealResult = await readTranscriptExact(input.transcript_path, APPEAL_COUNTS);
      const appealTranscript = formatTranscriptResult(appealResult);
      const appeal = await appealDenial(
        `${input.tool_name} as first response`,
        appealTranscript,
        intentResult.reason || "First action misaligned with user request"
      );

      if (!appeal.approved) {
        logToHomeAssistant({
          agent: "pre-tool-use-hook",
          level: "decision",
          problem: `First response: ${input.tool_name}`,
          answer: `BLOCKED: ${intentResult.reason}`,
        });
        outputDeny(
          `First response misalignment: ${intentResult.reason}. Please respond to the user's message first.`
        );
      }
      // Appeal passed - continue to other checks
      logToHomeAssistant({
        agent: "pre-tool-use-hook",
        level: "info",
        problem: `First response intent appealed: ${input.tool_name}`,
        answer: "APPEALED - continuing",
      });
    }
  }

  // Error acknowledgment check - detect if AI is ignoring errors
  // Step 1: Quick pattern check (TypeScript only, no LLM)
  const errorCheckResult = await readTranscriptExact(input.transcript_path, ERROR_CHECK_COUNTS);
  const errorCheckTranscript = formatTranscriptResult(errorCheckResult);

  // Clear ack cache if user has sent a new message (any user interaction = fresh start)
  const lastUserMessage = errorCheckResult.user[errorCheckResult.user.length - 1];
  if (lastUserMessage) {
    checkUserInteraction(lastUserMessage.content);
    // Record user message for rewind detection
    recordUserMessage(lastUserMessage.content, lastUserMessage.index);
  }

  // Only check TOOL_RESULT lines for error patterns to avoid false positives from Read tool (source code)
  const quickCheck = hasErrorPatterns(errorCheckTranscript, { toolResultsOnly: true });

  // Skip error-ack if tool matches suggested alternative (conservative exact match)
  if (quickCheck.needsCheck && matchesSuggestedAlternative(input.tool_name, errorCheckTranscript)) {
    logToHomeAssistant({
      agent: "pre-tool-use-hook",
      level: "info",
      problem: `${input.tool_name} matches suggested alternative`,
      answer: "Skipping error-ack check",
    });
    // Continue to next checks (don't require explicit ack)
  } else if (quickCheck.needsCheck) {
    // Step 2: Only call Haiku if error/directive patterns detected
    const ackResult = await checkErrorAcknowledgment(
      errorCheckTranscript,
      input.tool_name,
      input.tool_input
    );
    if (ackResult.startsWith("BLOCK:")) {
      const reason = ackResult.substring(7).trim();

      // Appeal the error-acknowledge denial
      const appealResult = await readTranscriptExact(input.transcript_path, APPEAL_COUNTS);
      const appealTranscript = formatTranscriptResult(appealResult);
      const errorToolDescription = `${input.tool_name} with ${JSON.stringify(input.tool_input).slice(0, 200)}`;
      const appeal = await appealDenial(
        errorToolDescription,
        appealTranscript,
        reason
      );

      if (appeal.approved) {
        // Mark error as acknowledged since appeal passed
        markErrorAcknowledged(reason);
        logToHomeAssistant({
          agent: "pre-tool-use-hook",
          level: "decision",
          problem: `${input.tool_name} error-acknowledge appealed`,
          answer: "APPEALED - continuing",
        });
        // Continue to next checks (don't exit)
      } else {
        const finalReason = appeal.reason ?? reason;
        logToHomeAssistant({
          agent: "pre-tool-use-hook",
          level: "decision",
          problem: `${input.tool_name} blocked for ignoring errors`,
          answer: finalReason,
        });
        outputDeny(`Error acknowledgment required: ${finalReason}`);
      }
    }
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Path-based risk classification for file tools
  // Low risk: inside project or ~/.claude, and not sensitive
  // High risk: outside trusted dirs or sensitive files
  if (FILE_TOOLS.includes(input.tool_name)) {
    const filePath =
      (input.tool_input as { file_path?: string }).file_path ||
      (input.tool_input as { path?: string }).path;
    if (filePath) {
      // Plan file drift detection - validate plan content against user intent
      const plansDir = path.join(os.homedir(), ".claude", "plans");
      if (
        (input.tool_name === "Write" || input.tool_name === "Edit") &&
        isPathInDirectory(filePath, plansDir)
      ) {
        // Skip validation if ExitPlanMode was recently approved
        // This means user approved the plan and AI is now writing it
        const recentContext = await readTranscriptExact(
          input.transcript_path,
          RECENT_TOOL_APPROVAL_COUNTS
        );
        const hasExitPlanModeApproval = recentContext.toolResult.some(
          (r) =>
            r.content.includes("ExitPlanMode") &&
            (r.content.includes("approved") || r.content.includes("allow"))
        );
        if (hasExitPlanModeApproval) {
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "info",
            problem: `Plan ${input.tool_name.toLowerCase()} to ${filePath}`,
            answer: "ExitPlanMode approved - skipping validation",
          });
          outputAllow();
        }

        // Get current plan and conversation context
        const currentPlan = readPlanContent(input.transcript_path);
        const planResult = await readTranscriptExact(input.transcript_path, PLAN_VALIDATE_COUNTS);
        const conversationContext = formatTranscriptResult(planResult);

        // Wrap plan validation with appeal
        const validation = await checkWithAppeal(
          () =>
            validatePlanIntent(
              currentPlan,
              input.tool_name as "Write" | "Edit",
              input.tool_input as { content?: string; old_string?: string; new_string?: string },
              conversationContext
            ),
          input.tool_name,
          input.tool_input,
          input.transcript_path,
          { appealContext: `Plan ${input.tool_name.toLowerCase()} to ${filePath}` }
        );

        if (!validation.approved) {
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "decision",
            problem: `Plan ${input.tool_name.toLowerCase()} to ${filePath}`,
            answer: `DRIFT: ${validation.reason}`,
          });
          outputDeny(`Plan drift detected: ${validation.reason}`);
        }
        // Plan validated - allow write
        outputAllow();
      }

      // CLAUDE.md validation - detect Write/Edit to any CLAUDE.md file
      if (
        (input.tool_name === "Write" || input.tool_name === "Edit") &&
        filePath.endsWith("CLAUDE.md")
      ) {
        // Get current file content (null if doesn't exist)
        let currentContent: string | null = null;
        try {
          currentContent = fs.readFileSync(filePath, "utf-8");
        } catch {
          // File doesn't exist - that's OK for new files
        }

        const validation = await checkWithAppeal(
          () =>
            validateClaudeMd(
              currentContent,
              input.tool_name as "Write" | "Edit",
              input.tool_input as { content?: string; old_string?: string; new_string?: string }
            ),
          input.tool_name,
          input.tool_input,
          input.transcript_path,
          {
            appealContext: `CLAUDE.md ${input.tool_name.toLowerCase()} to ${filePath}`,
          }
        );

        if (!validation.approved) {
          logToHomeAssistant({
            agent: "pre-tool-use-hook",
            level: "decision",
            problem: `CLAUDE.md ${input.tool_name.toLowerCase()} to ${filePath}`,
            answer: `REJECTED: ${(validation.reason ?? "").slice(0, 200)}`,
          });
          outputDeny(`CLAUDE.md validation failed: ${validation.reason}`);
        }
        // CLAUDE.md validated - allow write
        outputAllow();
      }

      const trusted = isTrustedPath(filePath, projectDir);
      const sensitive = isSensitivePath(filePath);

      if (trusted && !sensitive) {
        // Low risk path - but check for style drift on Edit tool
        // Edit has old_string/new_string for comparison; Write/NotebookEdit lack old content
        if (input.tool_name === "Edit") {
          // Get user messages to check if style change was requested
          const transcriptResult = await readTranscriptExact(
            input.transcript_path,
            STYLE_DRIFT_COUNTS
          );
          const userMessages = formatTranscriptResult(transcriptResult);

          // Check for style drift with automatic appeal on denial
          const styleDriftResult = await checkWithAppeal(
            () =>
              checkStyleDrift(
                input.tool_name,
                input.tool_input,
                projectDir,
                userMessages
              ),
            input.tool_name,
            input.tool_input,
            input.transcript_path
          );

          if (!styleDriftResult.approved) {
            logToHomeAssistant({
              agent: "pre-tool-use-hook",
              level: "decision",
              problem: `Edit ${filePath}`,
              answer: `STYLE DRIFT: ${styleDriftResult.reason}`,
            });
            outputDeny(`Style drift detected: ${styleDriftResult.reason}`);
          }
        }

        // Low risk - auto-approve (passed style-drift check or not applicable)
        outputAllow();
      }
      // High risk - fall through to LLM approval
    }
  }

  const toolDescription = `${input.tool_name} with ${JSON.stringify(
    input.tool_input
  )}`;

  // Tool approval with automatic appeal on denial
  const decision = await checkWithAppeal(
    () => approveTool(input.tool_name, input.tool_input, projectDir),
    input.tool_name,
    input.tool_input,
    input.transcript_path
  );

  logToHomeAssistant({
    agent: "pre-tool-use-hook",
    level: "decision",
    problem: toolDescription,
    answer: decision.approved ? "ALLOWED" : `DENIED: ${decision.reason}`,
  });

  if (!decision.approved) {
    // Track workaround patterns for escalation
    let finalReason = decision.reason;
    const pattern = detectWorkaroundPattern(input.tool_name, input.tool_input);
    if (pattern) {
      const denials = loadDenials();
      denials[pattern] = {
        count: (denials[pattern]?.count || 0) + 1,
        timestamp: Date.now(),
      };
      saveDenials(denials);

      if (denials[pattern].count >= MAX_SIMILAR_DENIALS) {
        finalReason += ` CRITICAL: You have attempted ${denials[pattern].count} similar workarounds for '${pattern}'. STOP trying alternatives. Either use the approved MCP tool, ask the user for guidance, or acknowledge that this action cannot be performed.`;
        logToHomeAssistant({
          agent: "pre-tool-use-hook",
          level: "escalation",
          problem: `Repeated workaround attempts: ${pattern}`,
          answer: `Count: ${denials[pattern].count}`,
        });
      }
    }

    // Output structured JSON to deny and provide feedback to Claude
    outputDeny(finalReason ?? "Tool denied");
  }

  // Explicitly allow approved tools
  outputAllow();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
