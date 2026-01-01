import "../utils/load-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheckAgent } from "../agents/mcp/check.js";
import { runConfirmAgent } from "../agents/mcp/confirm.js";
import { runCommitAgent } from "../agents/mcp/commit.js";
import { runPushAgent } from "../agents/mcp/push.js";
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
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)")
    }
  },
  async (args) => {
    const result = await runCheckAgent(args.working_dir || process.cwd());
    return { content: [{ type: "text", text: result }] };
  }
);

server.registerTool(
  "confirm",
  {
    title: "Confirm",
    description: "Binary code quality gate. Analyzes git diff and returns CONFIRMED or DECLINED. Cannot ask questions or request context.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)")
    }
  },
  async (args) => {
    const result = await runConfirmAgent(args.working_dir || process.cwd());
    return { content: [{ type: "text", text: result }] };
  }
);

server.registerTool(
  "commit",
  {
    title: "Commit",
    description: "Generate minimal commit message based on diff and execute git commit (no push).",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)")
    }
  },
  async (args) => {
    const result = await runCommitAgent(args.working_dir || process.cwd());
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running on stdio");
