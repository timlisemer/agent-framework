import { execSync } from "child_process";
import { getModelId } from "../../types.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import { runAgentQuery } from "../../utils/agent-query.js";
import { runConfirmAgent } from "./confirm.js";

export async function runCommitAgent(workingDir: string): Promise<string> {
  // Pre-check: skip LLM call if nothing to commit
  const status = execSync("git status --porcelain", { cwd: workingDir, encoding: "utf-8" });
  if (!status.trim()) {
    logToHomeAssistant({
      agent: 'commit',
      level: 'info',
      problem: workingDir,
      answer: 'SKIPPED: nothing to commit',
    });
    return "SKIPPED: nothing to commit";
  }

  // Confirm changes before generating commit message
  const confirmResult = await runConfirmAgent(workingDir);
  if (confirmResult.startsWith("DECLINED")) {
    logToHomeAssistant({
      agent: 'commit',
      level: 'info',
      problem: workingDir,
      answer: confirmResult,
    });
    return confirmResult;
  }

  const result = await runAgentQuery(
    'commit',
    `1. Run \`git diff HEAD\` to see changes
2. Run \`git diff --stat HEAD\` for overview
3. Generate an appropriate commit message
4. Execute \`git add -A && git commit -m "..."\`
5. Return the commit hash`,
    {
      cwd: workingDir,
      model: getModelId("sonnet"),
      allowedTools: ["Bash"],
      systemPrompt: `You are a commit message generator following minimal commit conventions.

MESSAGE FORMAT by change size:

Small (1-3 files, <50 lines): Single lowercase line, no period
  "fix typo in readme"
  "add null check"
  "update dependency"

Medium (4-10 files, 50-200 lines): Single line with scope
  "auth: add jwt refresh"
  "api: handle rate limits"
  "db: add migration for users table"

Large (10+ files or 200+ lines): Title + bullet body
  "refactor: extract validation module

  - Move validators to dedicated directory
  - Add unit tests for email validation
  - Update imports across codebase"

RULES:
- Never use vague messages ("various fixes", "updates", "changes")
- Never include file names unless critical
- Never push (only commit)
- Always use \`git add -A\` to stage all changes

After committing, output ONLY this format on two lines:
<first line of commit message>
<commit hash>

Example:
fix typo in readme
abc123def`
    }
  );

  logToHomeAssistant({
    agent: 'commit',
    level: 'info',
    problem: workingDir,
    answer: result.output,
  });

  return result.output;
}
