import "../utils/load-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheckAgent } from "../agents/mcp/check.js";
import { runConfirmAgent } from "../agents/mcp/confirm.js";
import { runCommitAgent } from "../agents/mcp/commit.js";
import { runPushAgent } from "../agents/mcp/push.js";
import { runValidateIntentAgent } from "../agents/mcp/validate-intent.js";
import { handleTestHarnessLabeler } from "../agents/mcp/test-harness-labeler.js";
import { handleTestHarnessTester } from "../agents/mcp/test-harness-tester.js";
import { getRepoInfo } from "../utils/git-utils.js";
import { initializeTelemetry } from "../telemetry/index.js";
import {
  elicitRepoSelection,
  elicitPreferences,
  sortReposSubmodulesFirst,
  parseUncertainties,
  elicitUncertaintyClarification,
} from "../utils/elicitation.js";

const coercibleBoolean = z.preprocess(
  (val) => (typeof val === "string" ? val === "true" : val),
  z.boolean().optional()
);

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
      skip_elicitation: coercibleBoolean.describe("Skip interactive questions, use defaults")
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

    // Phase 1: Collect all preferences upfront
    const repoPrefs = new Map<string, { tier: string | undefined; extraContext: string | undefined }>();
    for (const repo of selectedRepos) {
      if (!args.skip_elicitation && !args.model_tier) {
        const prefs = await elicitPreferences(server.server, repo.name);
        const focus = prefs.focus ? `Focus: ${prefs.focus}` : undefined;
        const extra = args.extra_context && focus ? `${args.extra_context}\n${focus}` : focus || args.extra_context;
        repoPrefs.set(repo.path, { tier: prefs.modelTier, extraContext: extra });
      } else {
        repoPrefs.set(repo.path, { tier: args.model_tier, extraContext: args.extra_context });
      }
    }

    // Phase 2: Process all repos
    const results: string[] = [];
    for (const repo of selectedRepos) {
      const prefs = repoPrefs.get(repo.path)!;
      let extraContext = prefs.extraContext;

      // Multi-repo context
      if (selectedRepos.length > 1) {
        const repoNames = selectedRepos.map((r) => r.name).join(", ");
        const multiContext = `Note: This is part of a multi-repository confirm. Repos: ${repoNames}. Currently evaluating: ${repo.name}.`;
        extraContext = extraContext ? `${multiContext}\n${extraContext}` : multiContext;
      }

      let result = await runConfirmAgent(repo.path, prefs.tier, extraContext, args.transcript_path);

      // Post-processing: If DECLINED with uncertainties, elicit clarification and retry
      if (!args.skip_elicitation && result.includes("DECLINED")) {
        const uncertainties = parseUncertainties(result);
        if (uncertainties.length > 0) {
          const clarification = await elicitUncertaintyClarification(server.server, uncertainties);
          if (clarification) {
            const retryContext = extraContext ? `${extraContext}\n${clarification}` : clarification;
            result = await runConfirmAgent(repo.path, prefs.tier, retryContext, args.transcript_path);
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
    description: "Detect repos with changes, ask user for preferences via form, then generate commit message and execute git commit. Optionally auto-push after successful commits.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Passed to confirm agent (default: opus)"),
      extra_context: z.string().optional().describe("Passed to confirm agent"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine"),
      skip_elicitation: coercibleBoolean.describe("Skip interactive questions, use defaults"),
      auto_push: coercibleBoolean.describe("Automatically push all committed repos after successful commit")
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

    // Phase 1: Collect all preferences upfront
    const repoPrefs = new Map<string, { tier: string | undefined; extraContext: string | undefined }>();
    for (const repo of selectedRepos) {
      if (!args.skip_elicitation && !args.model_tier) {
        const prefs = await elicitPreferences(server.server, repo.name);
        const focus = prefs.focus ? `Focus: ${prefs.focus}` : undefined;
        const extra = args.extra_context && focus ? `${args.extra_context}\n${focus}` : focus || args.extra_context;
        repoPrefs.set(repo.path, { tier: prefs.modelTier, extraContext: extra });
      } else {
        repoPrefs.set(repo.path, { tier: args.model_tier, extraContext: args.extra_context });
      }
    }

    // Phase 2: Process all repos
    const results: string[] = [];
    const committedRepos: typeof selectedRepos = [];
    for (const repo of selectedRepos) {
      const prefs = repoPrefs.get(repo.path)!;
      let extraContext = prefs.extraContext;

      // Multi-repo context
      if (selectedRepos.length > 1) {
        const repoNames = selectedRepos.map((r) => r.name).join(", ");
        const multiContext = `Note: This is part of a multi-repository commit. Repos: ${repoNames}. Currently evaluating: ${repo.name}.`;
        extraContext = extraContext ? `${multiContext}\n${extraContext}` : multiContext;
      }

      const result = await runCommitAgent(repo.path, prefs.tier, extraContext, args.transcript_path);

      const commitFailed = result.includes("DECLINED") || result.includes("ERROR") || result.includes("FAILED");
      if (!commitFailed) {
        committedRepos.push(repo);
      }

      if (selectedRepos.length > 1) {
        results.push(`=== ${repo.name} (${repo.path}) ===\n${result}`);
      } else {
        results.push(result);
      }
    }

    // Phase 3: Auto-push if requested
    if (args.auto_push && committedRepos.length > 0) {
      let reposToPush = committedRepos;

      // If elicitation is enabled and multiple repos, ask which to push
      if (!args.skip_elicitation && committedRepos.length > 1) {
        reposToPush = await elicitRepoSelection(server.server, {
          ...repoInfo,
          reposWithChanges: committedRepos,
        });
        if (reposToPush.length === 0) {
          results.push("\nPush skipped: no repositories selected for push.");
          return { content: [{ type: "text", text: results.join("\n\n") }] };
        }
        reposToPush = sortReposSubmodulesFirst(reposToPush, repoInfo);
      }

      results.push("\n--- Push Results ---");
      for (const repo of reposToPush) {
        const pushResult = await runPushAgent(repo.path);
        if (reposToPush.length > 1) {
          results.push(`=== ${repo.name} (${repo.path}) ===\n${pushResult}`);
        } else {
          results.push(pushResult);
        }
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
      skip_elicitation: coercibleBoolean.describe("Skip interactive questions, push all repos")
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

const richExpectationSchema = z.object({
  expected: z.string().describe("The decision the hook must produce: allow/deny/pass/block (or INVESTIGATE placeholder)."),
  by: z.string().optional().describe("Rule/gate name the denial must come from (matches tool-log gate field)."),
  at: z.union([z.number(), z.literal("full")]).optional().describe("1-based line cap this expectation scores under. Omit or 'full' for the default post-flush run."),
  notes: z.string().optional().describe("Free-text explanation of why this expectation exists."),
});

server.registerTool(
  "test_harness_labeler",
  {
    title: "Test Harness Labeler",
    description: "Label test harness transcripts. Actions: find_work, auto_label, generate_labels, scaffold, list, expand, validate, update_label, update_labels, set_label, finalize, read_file, append_notes, git_hash, help. Use help action for full documentation.",
    inputSchema: {
      action: z.enum([
        "find_work", "auto_label", "generate_labels", "scaffold", "list", "expand", "validate",
        "update_label", "update_labels", "set_label", "finalize", "read_file", "append_notes",
        "git_hash", "help"
      ]).describe("The action to perform"),
      transcript_name: z.string().optional().describe("Transcript name (without .jsonl extension)"),
      target: z.string().optional().describe("For expand: tool_use_id or stop:N key"),
      depth: z.number().optional().describe("For expand: context radius multiplier (default 1)"),
      key: z.string().optional().describe("For update_label/set_label: the label key to update"),
      value: z.string().optional().describe("For update_label: the new label value (allow/deny/pass/block)"),
      reasoning: z.string().optional().describe("For update_label/set_label: explanation for this label decision"),
      updates: z.array(z.object({
        key: z.string(),
        value: z.string(),
        reasoning: z.string(),
      })).optional().describe("For update_labels: array of {key, value, reasoning} updates"),
      expectation: z.union([richExpectationSchema, z.array(richExpectationSchema)]).optional().describe("For set_label: a rich expectation object (or array of them) with {expected, by?, at?, notes?}. Use this when you need 'expected deny by rule X' or per-truncation assertions that the plain update_label string form cannot express."),
      filename: z.string().optional().describe("For read_file: labels.draft.json, labels.json, notes_and_questions.md, or report.json"),
      content: z.string().optional().describe("For append_notes: content to append"),
      date_from: z.string().optional().describe("For find_work: only transcripts modified on or after this date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("For find_work: only transcripts modified on or before this date (YYYY-MM-DD)"),
      limit: z.number().optional().describe("For find_work: how many transcripts to process. Omit=1, 0=unlimited, N=N"),
      transcript_path: z.string().optional().describe("Absolute path to a transcript .jsonl file. Use when the transcript lives outside ~/.claude/projects/-home-tim-Coding-public-repos-agent-framework (e.g. sessions from other project dirs like iocto). Applies to auto_label/generate_labels/scaffold/list/expand/validate. Only needed once; subsequent actions find the transcript in ~/.agent-framework/test-runs/<name>/ after the first copy."),
      working_dir: z.string().optional().describe("Local repo path. When set, the labeler invokes replay.ts from this directory instead of the deployed AGENT_FRAMEWORK_ROOT, so locally edited test-harness/ source is used. Mirrors the tester's `working_dir`."),
    }
  },
  async (args) => {
    const result = await handleTestHarnessLabeler(args);
    return { content: [{ type: "text", text: result }] };
  }
);

const scenarioBlockSchema = z.record(z.unknown());

const scenarioSchema = z.object({
  name: z.string().describe("Slug for the scenario. Must match [A-Za-z0-9._-]+."),
  description: z.string().optional(),
  transcript: z.array(z.union([
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(scenarioBlockSchema)]),
      uuid: z.string().optional(),
      parentUuid: z.string().nullable().optional(),
    }),
    z.object({
      role: z.literal("assistant_split"),
      msg_id: z.string(),
      lines: z.array(z.object({
        blocks: z.array(scenarioBlockSchema),
      })).min(1),
    }),
  ])).min(1),
  target: z.object({
    hook: z.enum(["PreToolUse","PostToolUse","Stop","UserPromptSubmit","SessionStart"]),
    tool_use_ref: z.union([z.string(), z.literal("last")]).optional(),
    prompt_override: z.string().optional(),
  }),
  env: z.object({
    permission_mode: z.enum(["default","plan","acceptEdits","bypassPermissions","dontAsk"]).optional(),
    subagent: z.boolean().optional(),
    cwd: z.string().optional(),
    timeout_ms: z.number().optional(),
  }).optional(),
  expect: z.object({
    expected: z.string(),
    by: z.string().optional(),
    notes: z.string().optional(),
  }),
});

server.registerTool(
  "test_harness_tester",
  {
    title: "Test Harness Tester",
    description: "Run test harness against labeled transcripts OR against synthetic scenarios. Actions: find_work, run_test, run_single_hook, list, expand, read_file, append_notes, run_scenario, list_scenarios, read_scenario, git_hash, help. Use help action for full documentation.",
    inputSchema: {
      action: z.enum([
        "find_work", "run_test", "run_single_hook", "list", "expand", "read_file", "append_notes",
        "run_scenario", "list_scenarios", "read_scenario",
        "git_hash", "help"
      ]).describe("The action to perform"),
      transcript_name: z.string().optional().describe("Transcript name (without .jsonl extension)"),
      target: z.string().optional().describe("For expand: tool_use_id or stop:N key"),
      depth: z.number().optional().describe("For expand: context radius multiplier (default 1)"),
      filename: z.string().optional().describe("For read_file: report.json, labels.json, labels.draft.json, or notes_and_questions.md. For read_scenario: scenario.json or report-scenario.json."),
      content: z.string().optional().describe("For append_notes: content to append"),
      hook_key: z.string().optional().describe("For run_single_hook: hook key to test (tool_use_id or stop:N from report failures)"),
      working_dir: z.string().optional().describe("Local repo path for run_test/run_single_hook/list/expand/run_scenario (overrides AGENT_FRAMEWORK_ROOT so edited code is tested)"),
      truncate_to_line: z.number().optional().describe("For run_single_hook: 1-based line cap. When set, the harness appends only transcript lines <= truncate_to_line before firing the target hook. The hook still fires with its full tool_use_id because input is synthesized from the in-memory parsed lines. Use this to reproduce timing-sensitive states like pre-flush replay."),
      transcript_path: z.string().optional().describe("Absolute path to a transcript .jsonl file. Use when the transcript lives outside ~/.claude/projects/-home-tim-Coding-public-repos-agent-framework (e.g. iocto sessions). Only needed if the test-runs copy is not yet in place."),
      scenario_name: z.string().optional().describe("For run_scenario / list_scenarios / read_scenario: slug identifying a scenario under ~/.agent-framework/test-runs/scenarios/<name>/. Must match [A-Za-z0-9._-]+."),
      scenario: scenarioSchema.optional().describe("For run_scenario: inline Scenario JSON. When set, overwrites the on-disk scenarios/<name>/scenario.json before running. Omit to re-run a previously stored scenario. See the 'help' action (Workflow B) for the full schema and examples."),
    }
  },
  async (args) => {
    const result = await handleTestHarnessTester(args);
    return { content: [{ type: "text", text: result }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running on stdio");
