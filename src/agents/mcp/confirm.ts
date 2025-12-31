import * as fs from "fs";
import * as path from "path";
import { getModelId } from "../../types.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { runCommand } from "../../utils/command.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import { extractTextFromResponse } from "../../utils/response-parser.js";
import { runCheckAgent } from "./check.js";

const MAX_FILE_SIZE = 50000; // 50KB max per file
const MAX_TOTAL_SIZE = 200000; // 200KB total for all untracked files
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
]);

function getUntrackedFilesContent(gitStatusOutput: string, workingDir: string): string {
  if (!gitStatusOutput) return "";

  const lines = gitStatusOutput.split("\n").filter((line) => line.startsWith("??"));
  if (lines.length === 0) return "";

  const results: string[] = [];
  let totalSize = 0;

  for (const line of lines) {
    const filePath = line.slice(3).trim();
    const fullPath = path.join(workingDir, filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (BINARY_EXTENSIONS.has(ext)) {
      results.push(`--- ${filePath} ---\n(binary file, skipped)`);
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        const dirFiles = getFilesRecursively(fullPath, workingDir);
        for (const file of dirFiles) {
          const fileExt = path.extname(file).toLowerCase();
          if (BINARY_EXTENSIONS.has(fileExt)) {
            results.push(`--- ${file} ---\n(binary file, skipped)`);
            continue;
          }
          const content = readFileContent(path.join(workingDir, file), file, MAX_FILE_SIZE);
          if (totalSize + content.length > MAX_TOTAL_SIZE) {
            results.push(`--- ${file} ---\n(skipped: total size limit reached)`);
            continue;
          }
          totalSize += content.length;
          results.push(content);
        }
      } else {
        if (stat.size > MAX_FILE_SIZE) {
          results.push(`--- ${filePath} ---\n(file too large: ${stat.size} bytes, skipped)`);
          continue;
        }
        if (totalSize + stat.size > MAX_TOTAL_SIZE) {
          results.push(`--- ${filePath} ---\n(skipped: total size limit reached)`);
          continue;
        }
        const content = readFileContent(fullPath, filePath, MAX_FILE_SIZE);
        totalSize += content.length;
        results.push(content);
      }
    } catch {
      results.push(`--- ${filePath} ---\n(could not read file)`);
    }
  }

  return results.join("\n\n");
}

function getFilesRecursively(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      files.push(...getFilesRecursively(fullPath, baseDir));
    } else {
      files.push(relativePath);
    }
  }

  return files;
}

function readFileContent(fullPath: string, relativePath: string, maxSize: number): string {
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size > maxSize) {
      return `--- ${relativePath} ---\n(file too large: ${stat.size} bytes, skipped)`;
    }
    const content = fs.readFileSync(fullPath, "utf-8");
    return `--- ${relativePath} ---\n${content}`;
  } catch {
    return `--- ${relativePath} ---\n(could not read file)`;
  }
}

const SYSTEM_PROMPT = `You are a strict code quality gate. You have ONE job: evaluate changes and return a verdict.

The code has already passed linting and type checks. Now evaluate the changes against these 4 categories:

## CATEGORY 1: Files
Check for unwanted files in the git status. FAIL if you see:
- node_modules/, dist/, build/, out/, target/, vendor/, coverage/
- .env, .env.local, .env.* (environment files with secrets)
- *.log, *.tmp, *.cache, .DS_Store, Thumbs.db
- __pycache__/, *.pyc
- .idea/, .vscode/ with settings (unless intentional)

## CATEGORY 2: Code Quality
Evaluate the diff for:
- No obvious bugs or logic errors
- No debug code (console.log, print, dbg!, etc.)
- Changes are coherent and intentional
- Reasonable code style
- No unused code workarounds (renaming with _var, @ts-ignore, etc. - unused code must be deleted)

## CATEGORY 3: Security
Check for:
- No security vulnerabilities
- No hardcoded secrets or credentials

## CATEGORY 4: Documentation
- Verify documentation is updated if the changes require it
- Note what is missing if applicable

OUTPUT FORMAT:
Your response must follow this exact structure:

## Results
- Files: PASS or FAIL (<brief reason if FAIL>)
- Code Quality: PASS or FAIL (<brief reason if FAIL>)
- Security: PASS or FAIL (<brief reason if FAIL>)
- Documentation: PASS or FAIL (<brief reason if FAIL>)

## Summary
<2-4 sentences describing what the changes do conceptually>

## Verdict
CONFIRMED: <1-2 sentences explaining why the changes are acceptable>
or
DECLINED: <1-2 sentences explaining the specific issue>

RULES:
- You CANNOT ask questions or request more context
- You MUST decide based solely on the diff
- All 4 categories must PASS for CONFIRMED
- Any FAIL means DECLINED
- Small, obvious changes bias toward CONFIRMED

This is a gate, not a review.`;

export async function runConfirmAgent(workingDir: string): Promise<string> {
  // Step 1: Run check agent first
  const checkResult = await runCheckAgent(workingDir);

  // Step 2: Parse check results for errors
  const errorMatch = checkResult.match(/Errors:\s*(\d+)/i);
  const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  const statusMatch = checkResult.match(/Status:\s*(PASS|FAIL)/i);
  const checkStatus = statusMatch ? statusMatch[1].toUpperCase() : "UNKNOWN";

  // Step 3: If check failed, decline immediately
  if (checkStatus === "FAIL" || errorCount > 0) {
    const result = `## Results
- Files: SKIP
- Code Quality: SKIP
- Security: SKIP
- Documentation: SKIP

## Verdict
DECLINED: check failed with ${errorCount} error(s)`;
    logToHomeAssistant({
      agent: "confirm",
      level: "decision",
      problem: workingDir,
      answer: result,
    });
    return result;
  }

  // Step 4: Run git commands directly
  const gitStatus = runCommand("git status --porcelain", workingDir);
  const gitDiff = runCommand("git diff HEAD", workingDir);

  // Step 5: Get content of untracked files
  const untrackedContent = getUntrackedFilesContent(gitStatus.output, workingDir);

  // Step 6: Single API call to analyze
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: getModelId("opus"),
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Evaluate these code changes:

GIT STATUS (files changed):
${gitStatus.output || "(no changes)"}

GIT DIFF (tracked files):
${gitDiff.output || "(no diff)"}

UNTRACKED FILES CONTENT:
${untrackedContent || "(no untracked files)"}`,
      },
    ],
  });

  const output = extractTextFromResponse(response);

  logToHomeAssistant({
    agent: "confirm",
    level: "decision",
    problem: workingDir,
    answer: output,
  });

  return output;
}
