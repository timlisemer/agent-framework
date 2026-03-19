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
import {
  elicitRepoSelection,
  elicitPreferences,
  sortReposSubmodulesFirst,
  parseUncertainties,
  elicitUncertaintyClarification,
} from "../utils/elicitation.js";

// Ensure PATH includes standard locations for subprocess spawning
// Required for Claude Agent SDK to find node when running in Docker via `docker exec`
// Only applies to Unix-like systems (Linux/macOS) - Windows has its own PATH defaults
if (process.platform !== "win32") {
  const requiredPaths = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin'];
  const currentPath = process.env.PATH || '';
  const pathParts = currentPath.split(':').filter(Boolean);
  for (const p of requiredPaths) {
    if (!pathParts.includes(p)) {
      pathParts.push(p);
    }
  }
  process.env.PATH = pathParts.join(':');
}

initializeTelemetry();

const server = new McpServer({
  name: "agent-framework",
  version: "1.0.0"
});

server.registerTool(
  "check",
  {
    title: "Check",
    description: "Run linter and make/just check, return summarized results with warning recommendations. Does not access source code.",
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
    description: "Binary code quality gate. Detects repos with changes, asks user for preferences via form, then analyzes git diff. Returns CONFIRMED or DECLINED per repo.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Model tier for evaluation (default: opus)"),
      extra_context: z.string().optional().describe("Additional instructions or areas to focus on"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine"),
      skip_elicitation: z.boolean().optional().describe("Skip interactive questions, use defaults")
    }
  },
  async (args) => {
    const workingDir = args.working_dir || process.cwd();
    const repoInfo = getRepoInfo(workingDir);

    if (repoInfo.reposWithChanges.length === 0) {
      return { content: [{ type: "text", text: "No repositories with uncommitted changes found." }] };
    }

    // Non-interactive mode: validate required params instead of asking
    if (args.skip_elicitation && !args.model_tier) {
      return { content: [{ type: "text", text: "ERROR: model_tier is required when skip_elicitation is true." }] };
    }

    // Select repos (elicit if multiple, unless skipped)
    let selectedRepos = repoInfo.reposWithChanges;
    if (!args.skip_elicitation && repoInfo.reposWithChanges.length > 1) {
      selectedRepos = await elicitRepoSelection(server.server, repoInfo);
      if (selectedRepos.length === 0) {
        return { content: [{ type: "text", text: "No repositories selected." }] };
      }
    }
    selectedRepos = sortReposSubmodulesFirst(selectedRepos, repoInfo);

    const results: string[] = [];
    for (const repo of selectedRepos) {
      // Get preferences (elicit unless skipped or provided via args)
      let tier = args.model_tier;
      let extraContext = args.extra_context;
      if (!args.skip_elicitation && !args.model_tier) {
        const prefs = await elicitPreferences(server.server, repo.name);
        tier = prefs.modelTier;
        if (prefs.focus) {
          extraContext = extraContext ? `${extraContext}\nFocus: ${prefs.focus}` : `Focus: ${prefs.focus}`;
        }
      }

      // Multi-repo context
      if (selectedRepos.length > 1) {
        const repoNames = selectedRepos.map((r) => r.name).join(", ");
        const multiContext = `Note: This is part of a multi-repository confirm. Repos: ${repoNames}. Currently evaluating: ${repo.name}.`;
        extraContext = extraContext ? `${multiContext}\n${extraContext}` : multiContext;
      }

      let result = await runConfirmAgent(repo.path, tier, extraContext, args.transcript_path);

      // Phase 2: If DECLINED with uncertainties, elicit clarification and retry
      if (!args.skip_elicitation && result.includes("DECLINED")) {
        const uncertainties = parseUncertainties(result);
        if (uncertainties.length > 0) {
          const clarification = await elicitUncertaintyClarification(server.server, uncertainties);
          if (clarification) {
            const retryContext = extraContext ? `${extraContext}\n${clarification}` : clarification;
            result = await runConfirmAgent(repo.path, tier, retryContext, args.transcript_path);
          }
        }
      }

      if (selectedRepos.length > 1) {
        results.push(`=== ${repo.name} (${repo.path}) ===\n${result}`);
      } else {
        results.push(result);
      }
    }

    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }
);

server.registerTool(
  "commit",
  {
    title: "Commit",
    description: "Detect repos with changes, ask user for preferences via form, then generate commit message and execute git commit (no push).",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Passed to confirm agent (default: opus)"),
      extra_context: z.string().optional().describe("Passed to confirm agent"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine"),
      skip_elicitation: z.boolean().optional().describe("Skip interactive questions, use defaults")
    }
  },
  async (args) => {
    const workingDir = args.working_dir || process.cwd();
    const repoInfo = getRepoInfo(workingDir);

    if (repoInfo.reposWithChanges.length === 0) {
      return { content: [{ type: "text", text: "SKIPPED: No repositories with uncommitted changes found." }] };
    }

    // Non-interactive mode: validate required params instead of asking
    if (args.skip_elicitation && !args.model_tier) {
      return { content: [{ type: "text", text: "ERROR: model_tier is required when skip_elicitation is true." }] };
    }

    // Select repos (elicit if multiple, unless skipped)
    let selectedRepos = repoInfo.reposWithChanges;
    if (!args.skip_elicitation && repoInfo.reposWithChanges.length > 1) {
      selectedRepos = await elicitRepoSelection(server.server, repoInfo);
      if (selectedRepos.length === 0) {
        return { content: [{ type: "text", text: "No repositories selected." }] };
      }
    }
    selectedRepos = sortReposSubmodulesFirst(selectedRepos, repoInfo);

    const results: string[] = [];
    for (const repo of selectedRepos) {
      // Get preferences (elicit unless skipped or provided via args)
      let tier = args.model_tier;
      let extraContext = args.extra_context;
      if (!args.skip_elicitation && !args.model_tier) {
        const prefs = await elicitPreferences(server.server, repo.name);
        tier = prefs.modelTier;
        if (prefs.focus) {
          extraContext = extraContext ? `${extraContext}\nFocus: ${prefs.focus}` : `Focus: ${prefs.focus}`;
        }
      }

      // Multi-repo context
      if (selectedRepos.length > 1) {
        const repoNames = selectedRepos.map((r) => r.name).join(", ");
        const multiContext = `Note: This is part of a multi-repository commit. Repos: ${repoNames}. Currently evaluating: ${repo.name}.`;
        extraContext = extraContext ? `${multiContext}\n${extraContext}` : multiContext;
      }

      const result = await runCommitAgent(repo.path, tier, extraContext, args.transcript_path);

      if (selectedRepos.length > 1) {
        results.push(`=== ${repo.name} (${repo.path}) ===\n${result}`);
      } else {
        results.push(result);
      }
    }

    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }
);

server.registerTool(
  "push",
  {
    title: "Push",
    description: "Push committed changes to remote repository. Detects repos and asks which to push if multiple exist.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      skip_elicitation: z.boolean().optional().describe("Skip interactive questions, push all repos")
    }
  },
  async (args) => {
    const workingDir = args.working_dir || process.cwd();
    const repoInfo = getRepoInfo(workingDir);

    // For push, we push all repos (or let user select)
    // Use reposWithChanges as a starting point, but push can also push repos without uncommitted changes
    // that have committed but unpushed changes. For simplicity, push all detected repos.
    let selectedRepos = repoInfo.reposWithChanges;

    // If no repos have uncommitted changes, just push the working dir
    if (selectedRepos.length === 0) {
      const result = await runPushAgent(workingDir);
      return { content: [{ type: "text", text: result }] };
    }

    if (!args.skip_elicitation && selectedRepos.length > 1) {
      selectedRepos = await elicitRepoSelection(server.server, repoInfo);
      if (selectedRepos.length === 0) {
        return { content: [{ type: "text", text: "No repositories selected." }] };
      }
    }
    selectedRepos = sortReposSubmodulesFirst(selectedRepos, repoInfo);

    const results: string[] = [];
    for (const repo of selectedRepos) {
      const result = await runPushAgent(repo.path);
      if (selectedRepos.length > 1) {
        results.push(`=== ${repo.name} (${repo.path}) ===\n${result}`);
      } else {
        results.push(result);
      }
    }

    return { content: [{ type: "text", text: results.join("\n\n") }] };
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
