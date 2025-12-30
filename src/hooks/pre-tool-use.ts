import { type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { approveTool } from '../agents/tool-approve.js';
import { appealDenial } from '../agents/tool-appeal.js';
import { validatePlanIntent } from '../agents/plan-validate.js';
import { logToHomeAssistant } from '../utils/logger.js';

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

async function readRecentTranscript(
  transcriptPath: string,
  lines: number
): Promise<string> {
  const content = await fs.promises.readFile(transcriptPath, 'utf-8');
  const entries = content.trim().split('\n').slice(-lines);

  return entries
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.role === 'user' && entry.message?.content) {
          const text =
            typeof entry.message.content === 'string'
              ? entry.message.content
              : JSON.stringify(entry.message.content);
          return `USER: ${text}`;
        }
        if (entry.message?.role === 'assistant' && entry.message?.content) {
          const textBlocks = entry.message.content
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join(' ');
          if (textBlocks) return `ASSISTANT: ${textBlocks}`;
        }
        return null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .join('\n');
}

async function readRecentUserMessages(
  transcriptPath: string,
  lines: number
): Promise<string> {
  const content = await fs.promises.readFile(transcriptPath, 'utf-8');
  const entries = content.trim().split('\n').slice(-lines);

  return entries
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.role === 'user' && entry.message?.content) {
          let text = '';
          if (typeof entry.message.content === 'string') {
            text = entry.message.content;
          } else if (Array.isArray(entry.message.content)) {
            const textBlocks = entry.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text);
            text = textBlocks.join('\n');
          }
          // Skip tool results and system messages
          if (text.trim() && !text.startsWith('<system-reminder>')) {
            return `USER: ${text.trim()}`;
          }
        }
        return null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .join('\n\n');
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
    const transcript = await readRecentTranscript(input.transcript_path, 50);
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
        input.tool_name === 'Write' &&
        isPathInDirectory(filePath, plansDir)
      ) {
        const content = (input.tool_input as { content?: string }).content;
        if (content) {
          const userMessages = await readRecentUserMessages(
            input.transcript_path,
            50
          );
          const validation = await validatePlanIntent(content, userMessages);

          if (!validation.approved) {
            logToHomeAssistant({
              agent: 'pre-tool-use-hook',
              level: 'decision',
              problem: `Plan write to ${filePath}`,
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
    const transcript = await readRecentTranscript(input.transcript_path, 50);
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

    // Output structured JSON to deny and provide feedback to Claude
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: appeal.reason ?? decision.reason,
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
