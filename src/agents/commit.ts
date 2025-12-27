import { query } from "@anthropic-ai/claude-agent-sdk";
import { getModelId } from "../types.js";

export async function runCommitAgent(workingDir: string): Promise<string> {
  let output = "";

  const q = query({
    prompt: `1. Run \`git diff HEAD\` to see changes
2. Run \`git diff --stat HEAD\` for overview
3. Generate an appropriate commit message
4. Execute \`git add -A && git commit -m "..."\`
5. Return the commit hash`,
    options: {
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

After committing, output only the commit hash.`
    }
  });

  for await (const message of q) {
    if (message.type === "result" && message.subtype === "success") {
      output = message.result;
    }
  }

  return output.trim();
}
