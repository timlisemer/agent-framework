import "../utils/load-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheckAgent } from "../agents/mcp/check.js";
import { runConfirmAgent } from "../agents/mcp/confirm.js";
import { runCommitAgent } from "../agents/mcp/commit.js";
import { runPushAgent } from "../agents/mcp/push.js";
import { runValidateIntentAgent } from "../agents/mcp/validate-intent.js";
import { getRepoInfo } from "../utils/git-utils.js";
import { initializeTelemetry } from "../telemetry/index.js";

// Ensure PATH includes standard locations for subprocess spawning
// Required for Claude Agent SDK to find node when running in Docker via `docker exec`
const requiredPaths = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin'];
const currentPath = process.env.PATH || '';
const pathParts = currentPath.split(':').filter(Boolean);
for (const p of requiredPaths) {
  if (!pathParts.includes(p)) {
    pathParts.push(p);
  }
}
process.env.PATH = pathParts.join(':');

initializeTelemetry();

const server = new McpServer({
  name: "agent-framework",
  version: "1.0.0"
});

server.registerTool(
  "check",
  {
    title: "Check",
    description: "Run linter and make check, return summarized results with warning recommendations. Does not access source code.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine")
    }
  },
  async (args) => {
    const result = await runCheckAgent(args.working_dir || process.cwd(), args.transcript_path);
    return { content: [{ type: "text", text: result }] };
  }
);

server.registerTool(
  "confirm",
  {
    title: "Confirm",
    description: "Binary code quality gate. Analyzes git diff and returns CONFIRMED or DECLINED. Cannot ask questions or request context.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Model tier for evaluation (default: opus)"),
      extra_context: z.string().optional().describe("Additional instructions or areas to focus on"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine")
    }
  },
  async (args) => {
    const result = await runConfirmAgent(
      args.working_dir || process.cwd(),
      args.model_tier,
      args.extra_context,
      args.transcript_path
    );
    return { content: [{ type: "text", text: result }] };
  }
);

server.registerTool(
  "commit",
  {
    title: "Commit",
    description: "Generate minimal commit message based on diff and execute git commit (no push).",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Passed to confirm agent (default: opus)"),
      extra_context: z.string().optional().describe("Passed to confirm agent"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine")
    }
  },
  async (args) => {
    const result = await runCommitAgent(
      args.working_dir || process.cwd(),
      args.model_tier,
      args.extra_context,
      args.transcript_path
    );
    return { content: [{ type: "text", text: result }] };
  }
);

server.registerTool(
  "push",
  {
    title: "Push",
    description: "Push committed changes to remote repository.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)")
    }
  },
  async (args) => {
    const result = await runPushAgent(args.working_dir || process.cwd());
    return { content: [{ type: "text", text: result }] };
  }
);

server.registerTool(
  "list_repos",
  {
    title: "List Repos",
    description: "List all git repositories (main + submodules) and their uncommitted change status. Use this before commit/confirm/push to detect which repos have changes.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)")
    }
  },
  async (args) => {
    const info = getRepoInfo(args.working_dir || process.cwd());
    const lines: string[] = [];

    lines.push(`MAIN REPO: ${info.mainRepo}`);
    lines.push(`  Name: ${info.mainRepoName}`);
    lines.push(`  Has changes: ${info.mainRepoHasChanges ? "YES" : "NO"}`);

    if (info.submodules.length > 0) {
      lines.push("");
      lines.push("SUBMODULES:");
      for (const sub of info.submodules) {
        lines.push(`  - ${sub.path}`);
        lines.push(`    Absolute path: ${sub.absolutePath}`);
        lines.push(`    Has changes: ${sub.hasChanges ? "YES" : "NO"}`);
      }
    } else {
      lines.push("");
      lines.push("SUBMODULES: none");
    }

    lines.push("");
    if (info.reposWithChanges.length > 0) {
      lines.push("REPOS WITH UNCOMMITTED CHANGES:");
      for (const repo of info.reposWithChanges) {
        lines.push(`  - ${repo.name}: ${repo.path}`);
      }
    } else {
      lines.push("REPOS WITH UNCOMMITTED CHANGES: none");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "validate_intent",
  {
    title: "Validate Intent",
    description: "Check if AI followed user intentions. Analyzes conversation, code changes, and plan file. Returns ALIGNED or DRIFTED with reason.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      transcript_path: z.string().describe("Path to the conversation transcript file")
    }
  },
  async (args) => {
    const result = await runValidateIntentAgent(
      args.working_dir || process.cwd(),
      args.transcript_path
    );
    return { content: [{ type: "text", text: result }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running on stdio");
