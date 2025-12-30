import { type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { approveTool } from '../agents/tool-approve.js';
import { appealDenial } from '../agents/tool-appeal.js';
import { validatePlanIntent } from '../agents/plan-validate.js';
import { checkErrorAcknowledgment } from '../agents/error-acknowledge.js';
import { logToHomeAssistant } from '../utils/logger.js';
import {
  readTranscript,
  hasErrorPatterns,
  TranscriptFilter,
  MessageLimit,
  type ErrorCheckOptions,
} from '../utils/transcript.js';

// Retry tracking for workaround detection
const DENIAL_CACHE_FILE = '/tmp/claude-hook-denials.json';
const MAX_SIMILAR_DENIALS = 3;
const DENIAL_EXPIRY_MS = 60 * 1000; // 1 minute

interface DenialCache {
  [pattern: string]: { count: number; timestamp: number };
}

const WORKAROUND_PATTERNS: Record<string, string[]> = {
  'type-check': [
    'make check',
    'tsc',
    'npx tsc',
    'npm run check',
    'cargo check',
  ],
  build: ['make build', 'npm run build', 'cargo build'],
  lint: ['eslint', 'prettier', 'npm run lint'],
};

function detectWorkaroundPattern(
  toolName: string,
  toolInput: unknown
): string | null {
  if (toolName !== 'Bash') return null;
  const command = (toolInput as { command?: string }).command || '';

  for (const [pattern, variants] of Object.entries(WORKAROUND_PATTERNS)) {
    if (variants.some((v) => command.includes(v))) {
      return pattern;
    }
  }
  return null;
}

function loadDenials(): DenialCache {
  try {
    if (fs.existsSync(DENIAL_CACHE_FILE)) {
      const data = fs.readFileSync(DENIAL_CACHE_FILE, 'utf-8');
      const cache: DenialCache = JSON.parse(data);
      // Clean expired entries
      const now = Date.now();
      for (const key of Object.keys(cache)) {
        if (now - cache[key].timestamp > DENIAL_EXPIRY_MS) {
          delete cache[key];
        }
      }
      return cache;
    }
  } catch {
    // Ignore errors, return empty cache
  }
  return {};
}

function saveDenials(cache: DenialCache): void {
  try {
    fs.writeFileSync(DENIAL_CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Ignore write errors
  }
}

// File tools that benefit from path-based risk classification
const FILE_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit'];

// Sensitive file patterns - always require LLM approval
const SENSITIVE_PATTERNS = [
  '.env',
  'credentials',
  '.ssh',
  '.aws',
  'secrets',
  '.key',
  '.pem',
  'password',
];

function isPathInDirectory(filePath: string, dirPath: string): boolean {
  const resolved = path.resolve(filePath);
  const dirResolved = path.resolve(dirPath);
  return (
    resolved.startsWith(dirResolved + path.sep) || resolved === dirResolved
  );
}

function isTrustedPath(filePath: string, projectDir: string): boolean {
  const claudeDir = path.join(os.homedir(), '.claude');
  return (
    isPathInDirectory(filePath, projectDir) ||
    isPathInDirectory(filePath, claudeDir)
  );
}

function isSensitivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}


async function main() {
  const input: PreToolUseHookInput = await new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(JSON.parse(data)));
  });

  // Block confirm tool from Claude Code - requires explicit user approval
  // Internal agents (like commit) call runConfirmAgent() directly, bypassing this hook
  if (input.tool_name === 'mcp__agent-framework__confirm') {
    const transcript = await readTranscript(input.transcript_path, {
      filter: TranscriptFilter.BOTH,
      limit: MessageLimit.FIVE,
    });
    const appeal = await appealDenial(
      input.tool_name,
      input.tool_input,
      transcript,
      'Confirm requires explicit user approval. Use /commit or explicitly request confirm.'
    );

    if (appeal.approved) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        })
      );
      process.exit(0);
    }

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'Confirm requires explicit user approval. Use /commit or explicitly request confirm.',
        },
      })
    );
    process.exit(0);
  }

  // Auto-approve low-risk tools and ALL MCP tools
  // These tools are read-only or have no filesystem/system impact
  const LOW_RISK_TOOLS = [
    // Read-only search/navigation
    'LSP', // Language server protocol queries
    'Grep', // File content search
    'Glob', // File pattern matching
    'WebSearch', // Web search
    'WebFetch', // Fetch web content

    // MCP resource reading (read-only)
    'ListMcpResources', // List available MCP resources
    'ReadMcpResource', // Read an MCP resource

    // Internal/meta tools (low impact)
    'TodoWrite', // Task list management (internal to Claude)
    'TaskOutput', // Read output from background tasks
    'AskUserQuestion', // Prompts user for input (safe)
    'ExitPlanMode', // Exit plan mode (internal to Claude)
    'EnterPlanMode', // Enter plan mode (internal to Claude)
    'Skill', // Invoke skills like /commit (user-initiated)
  ];
  if (
    LOW_RISK_TOOLS.includes(input.tool_name) ||
    input.tool_name.startsWith('mcp__')
  ) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      })
    );
    process.exit(0);
  }

  // Error acknowledgment check - detect if AI is ignoring errors
  // Step 1: Quick pattern check (TypeScript only, no LLM)
  const errorCheckTranscript = await readTranscript(input.transcript_path, {
    filter: TranscriptFilter.BOTH_WITH_TOOLS,
    limit: MessageLimit.FIVE,
    trimToolOutput: true,
    maxToolOutputLines: 20,
    excludeToolNames: ['Task', 'Agent', 'TaskOutput'], // Exclude sub-agent results to prevent cascade blocking
  });
  // Only check TOOL_RESULT lines for error patterns to avoid false positives from Read tool (source code)
  const quickCheck = hasErrorPatterns(errorCheckTranscript, { toolResultsOnly: true });

  if (quickCheck.needsCheck) {
    // Step 2: Only call Haiku if error/directive patterns detected
    const ackResult = await checkErrorAcknowledgment(
      errorCheckTranscript,
      input.tool_name,
      input.tool_input
    );
    if (ackResult.startsWith('BLOCK:')) {
      const reason = ackResult.substring(7).trim();
      logToHomeAssistant({
        agent: 'pre-tool-use-hook',
        level: 'decision',
        problem: `${input.tool_name} blocked for ignoring errors`,
        answer: reason,
      });
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Error acknowledgment required: ${reason}`,
          },
        })
      );
      process.exit(0);
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
      const plansDir = path.join(os.homedir(), '.claude', 'plans');
      if (
        (input.tool_name === 'Write' || input.tool_name === 'Edit') &&
        isPathInDirectory(filePath, plansDir)
      ) {
        // Write uses 'content', Edit uses 'new_string'
        const content =
          input.tool_name === 'Write'
            ? (input.tool_input as { content?: string }).content
            : (input.tool_input as { new_string?: string }).new_string;
        if (content) {
          const userMessages = await readTranscript(input.transcript_path, {
            filter: TranscriptFilter.USER_ONLY,
            limit: MessageLimit.TEN,
          });
          const validation = await validatePlanIntent(content, userMessages);

          if (!validation.approved) {
            logToHomeAssistant({
              agent: 'pre-tool-use-hook',
              level: 'decision',
              problem: `Plan ${input.tool_name.toLowerCase()} to ${filePath}`,
              answer: `DRIFT: ${validation.reason}`,
            });
            console.log(
              JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: `Plan drift detected: ${validation.reason}`,
                },
              })
            );
            process.exit(0);
          }
        }
        // Plan validated - allow write
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          })
        );
        process.exit(0);
      }

      const trusted = isTrustedPath(filePath, projectDir);
      const sensitive = isSensitivePath(filePath);

      if (trusted && !sensitive) {
        // Low risk - auto-approve
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          })
        );
        process.exit(0);
      }
      // High risk - fall through to LLM approval
    }
  }

  const decision = await approveTool(
    input.tool_name,
    input.tool_input,
    projectDir
  );

  const toolDescription = `${input.tool_name} with ${JSON.stringify(
    input.tool_input
  )}`;

  logToHomeAssistant({
    agent: 'pre-tool-use-hook',
    level: 'decision',
    problem: toolDescription,
    answer: decision.approved ? 'ALLOWED' : `DENIED: ${decision.reason}`,
  });

  if (!decision.approved) {
    // Layer 2: Appeal with transcript context
    const transcript = await readTranscript(input.transcript_path, {
      filter: TranscriptFilter.BOTH,
      limit: MessageLimit.TEN,
    });
    const appeal = await appealDenial(
      input.tool_name,
      input.tool_input,
      transcript,
      decision.reason || 'No reason provided'
    );

    if (appeal.approved) {
      logToHomeAssistant({
        agent: 'pre-tool-use-hook',
        level: 'decision',
        problem: toolDescription,
        answer: 'APPEALED',
      });
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        })
      );
      process.exit(0); // Allow on successful appeal
    }

    // Track workaround patterns for escalation
    let finalReason = appeal.reason ?? decision.reason;
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
          agent: 'pre-tool-use-hook',
          level: 'escalation',
          problem: `Repeated workaround attempts: ${pattern}`,
          answer: `Count: ${denials[pattern].count}`,
        });
      }
    }

    // Output structured JSON to deny and provide feedback to Claude
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: finalReason,
        },
      })
    );
    process.exit(0);
  }

  // Explicitly allow approved tools
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    })
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
