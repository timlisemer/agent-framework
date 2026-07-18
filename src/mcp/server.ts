import "../utils/load-env.js";
import { activeSpec } from "../adapter/spec.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AnySchema,
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { runCheckAgent } from "../agents/mcp/check.js";
import { runValidatePlanAgent } from "../agents/mcp/validate-plan.js";
import { runCreatePlanfileAgent } from "../agents/mcp/create-planfile.js";
import { runImplementAgent, runValidateImplementationAgent } from "../agents/mcp/implement.js";
import { confirmResultFailed, runConfirmAgent, runFullConfirmAgent } from "../agents/mcp/confirm.js";
import { prepareCommitConfirmContext, runCommitAgent, runCommitAgentWithSharedConfirm } from "../agents/mcp/commit.js";
import { runPushAgent } from "../agents/mcp/push.js";
import { runTranscriptAgent } from "../agents/mcp/transcript.js";
import { runLocateScenarioMcp } from "../agents/mcp/locate-scenario.js";
import { dispatchPreToolUseResult } from "../entrypoints/host-hook.js";
import {
  handleScenarioTester,
  SCENARIO_TESTER_ACTIONS,
  TESTER_HELP,
} from "../agents/mcp/scenario-tester.js";
import { SCENARIO_SOURCE_TAGS } from "../agents/mcp/scenario-catalog.js";
import {
  CHECK_HELP,
  CONFIRM_HELP,
  FULLCONFIRM_HELP,
  COMMIT_HELP,
  PUSH_HELP,
  LIST_REPOS_HELP,
  VALIDATE_INTENT_HELP,
  VALIDATE_PLAN_HELP,
  CREATE_PLANFILE_HELP,
  IMPLEMENT_HELP,
  VALIDATE_IMPLEMENTATION_HELP,
  TRANSCRIPT_HELP,
  LOCATE_SCENARIO_HELP,
} from "./help-docs.js";
import {
  allReposInScope,
  getRepoInfo,
  getRepoInfoCancellable,
  sortReposWithChangesSubmodulesFirst,
  type RepoInfo,
} from "../utils/git-utils.js";
import { throwIfAborted } from "../utils/cancellation.js";
import { initializeTelemetry } from "../telemetry/index.js";
import {
  elicitRepoSelection,
  elicitRepoScope,
  elicitPreferences,
  sortReposSubmodulesFirst,
  parseUncertainties,
  elicitUncertaintyClarification,
} from "../utils/elicitation.js";
import { scenarioFixtureSchema } from "../scenario/fixtures/types.js";
import { scenarioNameSchema } from "../scenario/name.js";
import {
  McpToolTimeoutError,
  formatMcpTimeoutError,
  runMcpToolWithTimeout,
} from "./timeout.js";
import { appendMcpContinuationRecommendation } from "../utils/mcp-continuation-recommendation.js";

const coercibleBoolean = z.preprocess(
  (val) => (typeof val === "string" ? val === "true" : val),
  z.boolean().optional()
);

function implementationWorkflowInputSchema() {
  return {
    working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
    planfile: z.string().optional().describe("Path to the plan file. If omitted, resolves the active session's canonical plan.current snapshot slice for working_dir."),
    model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Model tier for the implementation workflow (default: sonnet)"),
    extra_context: z.array(z.string()).optional().describe("Optional exact quoted user text only; each entry must appear verbatim in recovered user transcript text. Do not populate with assistant-inferred context")
  };
}

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

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type TimedToolConfig<InputArgs extends ZodRawShapeCompat> = {
  title?: string;
  description?: string;
  inputSchema: InputArgs;
  outputSchema?: ZodRawShapeCompat | AnySchema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

function registerTimedTool<Name extends string, InputArgs extends ZodRawShapeCompat>(
  name: Name,
  config: TimedToolConfig<InputArgs>,
  handler: (
    args: ShapeOutput<InputArgs>,
    extra: ToolExtra,
    signal: AbortSignal,
  ) => Promise<CallToolResult>,
): void {
  const timedHandler = (async (
    args: ShapeOutput<InputArgs>,
    extra: ToolExtra,
  ) => {
    try {
      return await runMcpToolWithTimeout(name, extra.signal, (signal) =>
        handler(args, extra, signal),
      );
    } catch (error) {
      if (error instanceof McpToolTimeoutError) {
        return { content: [{ type: "text", text: formatMcpTimeoutError(error) }] };
      }
      throw error;
    }
  }) as ToolCallback<InputArgs>;
  server.registerTool(
    name,
    {
      ...config,
      description: appendMcpContinuationRecommendation(name, config.description),
    },
    timedHandler,
  );
}

type ConfirmLikeArgs = {
  working_dir?: string;
  model_tier?: "haiku" | "sonnet" | "opus";
  extra_context?: string;
  optional_planfile?: string;
  skip_elicitation?: boolean;
};

type ConfirmRunner = (
  workingDir: string,
  tierName?: string,
  extraContext?: string,
  optionalPlanfile?: string,
  options?: {
    signal?: AbortSignal;
    repoScope?: { mode: "all"; repoInfo: RepoInfo } | { mode: "single"; repoInfo?: RepoInfo };
  },
) => Promise<string>;

async function retryConfirmWithClarification(
  runner: ConfirmRunner,
  result: string,
  args: ConfirmLikeArgs,
  workingDir: string,
  currentExtraContext: string | undefined,
  optionalPlanfile: string | undefined,
  options: { signal: AbortSignal; repoScope: { mode: "all"; repoInfo: RepoInfo } | { mode: "single"; repoInfo: RepoInfo } },
): Promise<string> {
  if (args.skip_elicitation || !result.includes("DECLINED")) {
    return result;
  }

  const uncertainties = parseUncertainties(result);
  if (uncertainties.length === 0) {
    return result;
  }

  const clarification = await elicitUncertaintyClarification(server.server, uncertainties, options);
  throwIfAborted(options.signal);
  if (!clarification) {
    return result;
  }

  const retryContext = currentExtraContext ? `${currentExtraContext}\n${clarification}` : clarification;
  return runner(
    workingDir,
    args.model_tier || "opus",
    retryContext,
    optionalPlanfile,
    options,
  );
}

async function runConfirmLikeTool(
  scopeKind: "confirm" | "fullconfirm",
  args: ConfirmLikeArgs,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const options = { signal };
  const workingDir = args.working_dir || process.cwd();
  const detectedRepoInfo = await getRepoInfoCancellable(workingDir, options);
  throwIfAborted(signal);

  const scopedRepoInfo: RepoInfo = scopeKind === "fullconfirm"
    ? { ...detectedRepoInfo, reposWithChanges: allReposInScope(detectedRepoInfo) }
    : detectedRepoInfo;

  if (scopeKind === "confirm" && scopedRepoInfo.reposWithChanges.length === 0) {
    return { content: [{ type: "text", text: "No repositories with uncommitted changes found." }] };
  }

  const runner: ConfirmRunner = scopeKind === "fullconfirm" ? runFullConfirmAgent : runConfirmAgent;
  let repoScope: "all" | "individual" = args.skip_elicitation ? "all" : "individual";
  if (!args.skip_elicitation && scopedRepoInfo.reposWithChanges.length > 1) {
    const scopeChoice = await elicitRepoScope(server.server, "confirm", scopedRepoInfo, options);
    throwIfAborted(signal);
    if (!scopeChoice) {
      return { content: [{ type: "text", text: "No repository scope selected." }] };
    }
    repoScope = scopeChoice;
  }

  if (repoScope === "all") {
    const repoScopeOptions = { ...options, repoScope: { mode: "all" as const, repoInfo: scopedRepoInfo } };
    const initial = await runner(
      scopedRepoInfo.mainRepo,
      args.model_tier || "opus",
      args.extra_context,
      args.optional_planfile,
      repoScopeOptions,
    );
    const result = await retryConfirmWithClarification(
      runner,
      initial,
      args,
      scopedRepoInfo.mainRepo,
      args.extra_context,
      args.optional_planfile,
      repoScopeOptions,
    );
    return { content: [{ type: "text", text: result }] };
  }

  let selectedRepos = await elicitRepoSelection(server.server, scopedRepoInfo, options);
  throwIfAborted(signal);
  if (selectedRepos.length === 0) {
    return { content: [{ type: "text", text: "No repositories selected." }] };
  }
  selectedRepos = sortReposSubmodulesFirst(selectedRepos, scopedRepoInfo);

  const repoPrefs = new Map<string, { tier: string | undefined; extraContext: string | undefined }>();
  for (const repo of selectedRepos) {
    throwIfAborted(signal);
    if (!args.skip_elicitation && !args.model_tier) {
      const prefs = await elicitPreferences(server.server, repo.name, options);
      throwIfAborted(signal);
      const focus = prefs.focus ? `Focus: ${prefs.focus}` : undefined;
      const combinedExtraContext = args.extra_context && focus ? `${args.extra_context}\n${focus}` : focus || args.extra_context;
      repoPrefs.set(repo.path, { tier: prefs.modelTier, extraContext: combinedExtraContext });
    } else {
      repoPrefs.set(repo.path, { tier: args.model_tier, extraContext: args.extra_context });
    }
  }

  const results: string[] = [];
  for (const repo of selectedRepos) {
    throwIfAborted(signal);
    const prefs = repoPrefs.get(repo.path)!;
    let extraContext = prefs.extraContext;

    if (selectedRepos.length > 1) {
      const repoNames = selectedRepos.map((r) => r.name).join(", ");
      const multiContext = `Note: This is part of a multi-repository ${scopeKind}. Repos: ${repoNames}. Currently evaluating: ${repo.name}.`;
      extraContext = extraContext ? `${multiContext}\n${extraContext}` : multiContext;
    }

    const repoScopeOptions = { ...options, repoScope: { mode: "single" as const, repoInfo: scopedRepoInfo } };
    const initial = await runner(
      repo.path,
      prefs.tier,
      extraContext,
      args.optional_planfile,
      repoScopeOptions,
    );
    const result = await retryConfirmWithClarification(
      runner,
      initial,
      args,
      repo.path,
      extraContext,
      args.optional_planfile,
      repoScopeOptions,
    );

    results.push(selectedRepos.length > 1
      ? `=== ${repo.name} (${repo.path}) ===\n${result}`
      : result);
  }

  return { content: [{ type: "text", text: results.join("\n\n") }] };
}

registerTimedTool(
  "check",
  {
    title: "Check",
    description: "Run linter, make/just check, deterministic filename-reference diagnostics, repository-wide style-drift warnings, and supplemental editor diagnostics; return summarized results with warning recommendations.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine")
    }
  },
  async (args, _extra, signal) => {
    const options = { signal };
    const result = await runCheckAgent(args.working_dir || process.cwd(), args.transcript_path, options);
    return { content: [{ type: "text", text: result }] };
  }
);

registerTimedTool(
  "validate_plan",
  {
    title: "Validate Plan",
    description: "Validate a plan file against the planning contract using the plan-validate agent.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      plan_file: z.string().describe("Path to a plan file to validate"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine"),
      continue_workflow: coercibleBoolean.describe("On PASS, continue the invoking plan workflow instead of presenting <proposed_plan>. Defaults to false")
    }
  },
  async (args, _extra, signal) => {
    const result = await runValidatePlanAgent(
      {
        workingDir: args.working_dir || process.cwd(),
        planFile: args.plan_file,
        transcriptPath: args.transcript_path,
        continueWorkflow: args.continue_workflow,
      },
      { signal },
    );
    return { content: [{ type: "text", text: result }] };
  }
);

registerTimedTool(
  "create_planfile",
  {
    title: "Create Planfile",
    description: "Create the current session planfile for a lowercase kebab-case plan name, resolving the session through transcript sidecars when needed, normalize Plan Name and Planfile Path footer, then validate it.",
    inputSchema: {
      plan_name: z.string().describe("Lowercase kebab-case plan name"),
      content: z.string().describe("Plan body/content to write. The tool normalizes the Plan Name header and Planfile Path footer."),
      continue_workflow: coercibleBoolean.describe("On validation PASS, continue the invoking plan workflow instead of presenting <proposed_plan>. Defaults to false")
    }
  },
  async (args, _extra, signal) => {
    const result = await runCreatePlanfileAgent({
      planName: args.plan_name,
      content: args.content,
      continueWorkflow: args.continue_workflow,
    }, { signal });
    return { content: [{ type: "text", text: result }] };
  }
);

registerTimedTool(
  "implement",
  {
    title: "Implement",
    description: "Implement an approved plan through an internal write-capable implementation agent, run parent-owned checks, then validate implementation with a read-only validator.",
    inputSchema: implementationWorkflowInputSchema()
  },
  async (args, _extra, signal) => {
    const result = await runImplementAgent(args, { signal, workingDir: args.working_dir });
    return { content: [{ type: "text", text: result }] };
  }
);

registerTimedTool(
  "validate_implementation",
  {
    title: "Validate Implementation",
    description: "Validate that a plan was implemented correctly using the shared read-only implementation validator workflow.",
    inputSchema: implementationWorkflowInputSchema()
  },
  async (args, _extra, signal) => {
    const result = await runValidateImplementationAgent(args, { signal, workingDir: args.working_dir });
    return { content: [{ type: "text", text: result }] };
  }
);

registerTimedTool(
  "confirm",
  {
    title: "Confirm",
    description: "Review uncommitted code changes. Detects repos with changes, asks user for preferences via form, runs check, then analyzes git diff only if check passes. Returns raw check output on check failure, otherwise CONFIRMED or DECLINED.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Model tier for evaluation (default: opus)"),
      extra_context: z.string().optional().describe("Additional instructions or review-depth guidance"),
      optional_planfile: z.string().optional().describe("Optional planfile path to include in confirm context. If omitted and no session planfile exists, confirm runs without plan input."),
      skip_elicitation: coercibleBoolean.describe("Skip interactive questions, use defaults")
    }
  },
  async (args, _extra, signal) => {
    return runConfirmLikeTool("confirm", args, signal);
  }
);

registerTimedTool(
  "fullconfirm",
  {
    title: "FullConfirm",
    description: "Review the full git-visible code scope. Detects repos, asks user for preferences via form, runs check, then analyzes full-scope metadata and lets SDK agents inspect code if check passes. Returns raw check output on check failure, otherwise CONFIRMED or DECLINED.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Model tier for evaluation (default: opus)"),
      extra_context: z.string().optional().describe("Additional instructions or review-depth guidance"),
      optional_planfile: z.string().optional().describe("Optional planfile path to include in confirm context. If omitted and no session planfile exists, confirm runs without plan input."),
      skip_elicitation: coercibleBoolean.describe("Skip interactive questions, use defaults")
    }
  },
  async (args, _extra, signal) => {
    return runConfirmLikeTool("fullconfirm", args, signal);
  }
);

registerTimedTool(
  "commit",
  {
    title: "Commit",
    description: "Detect repos with changes, ask user for preferences via form, then generate commit message and execute git commit. Optionally auto-push after successful commits.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      model_tier: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Passed to confirm agent (default: opus)"),
      extra_context: z.string().optional().describe("Passed to confirm agent"),
      optional_planfile: z.string().optional().describe("Optional planfile path forwarded to confirm. If omitted and no session planfile exists, confirm runs without plan input."),
      skip_elicitation: coercibleBoolean.describe("Skip interactive questions, use defaults"),
      auto_push: coercibleBoolean.describe("Automatically push all committed repos after successful commit")
    }
  },
  async (args, _extra, signal) => {
    const options = { signal };
    const workingDir = args.working_dir || process.cwd();
    const repoInfo = await getRepoInfoCancellable(workingDir, options);
    throwIfAborted(signal);

    if (repoInfo.reposWithChanges.length === 0) {
      return { content: [{ type: "text", text: "SKIPPED: No repositories with uncommitted changes found." }] };
    }

    let repoScope: "all" | "individual" = args.skip_elicitation ? "all" : "individual";
    if (!args.skip_elicitation && repoInfo.reposWithChanges.length > 1) {
      const scopeChoice = await elicitRepoScope(server.server, "commit", repoInfo, options);
      throwIfAborted(signal);
      if (!scopeChoice) {
        return { content: [{ type: "text", text: "No repository scope selected." }] };
      }
      repoScope = scopeChoice;
    }

    let selectedRepos = repoScope === "all"
      ? sortReposWithChangesSubmodulesFirst(repoInfo)
      : await elicitRepoSelection(server.server, repoInfo, options);
    throwIfAborted(signal);
    if (selectedRepos.length === 0) {
      return { content: [{ type: "text", text: "No repositories selected." }] };
    }
    selectedRepos = sortReposSubmodulesFirst(selectedRepos, repoInfo);

    if (repoScope === "all") {
      const preparedConfirm = await prepareCommitConfirmContext(selectedRepos, args.extra_context, options);
      if (preparedConfirm.error) {
        return { content: [{ type: "text", text: preparedConfirm.error }] };
      }
      let confirmResult = await runConfirmAgent(
        repoInfo.mainRepo,
        args.model_tier || "opus",
        preparedConfirm.extraContext,
        args.optional_planfile,
        { ...options, repoScope: { mode: "all", repoInfo }, preparedNormalizedMovesByRepo: preparedConfirm.movesByRepo },
      );
      if (!args.skip_elicitation && confirmResult.includes("DECLINED")) {
        const uncertainties = parseUncertainties(confirmResult);
        if (uncertainties.length > 0) {
          const clarification = await elicitUncertaintyClarification(server.server, uncertainties, options);
          throwIfAborted(signal);
          if (clarification) {
            const retryBaseContext = preparedConfirm.extraContext || args.extra_context;
            const retryContext = retryBaseContext ? `${retryBaseContext}\n${clarification}` : clarification;
            confirmResult = await runConfirmAgent(
              repoInfo.mainRepo,
              args.model_tier || "opus",
              retryContext,
              args.optional_planfile,
              { ...options, repoScope: { mode: "all", repoInfo }, preparedNormalizedMovesByRepo: preparedConfirm.movesByRepo },
            );
          }
        }
      }
      if (confirmResultFailed(confirmResult)) {
        return { content: [{ type: "text", text: confirmResult }] };
      }

      const repoNames = selectedRepos.map((repo) => repo.name).join(", ");
      const sharedCommitContext = `SHARED ALL-REPOSITORIES CONFIRM CONTEXT:
This commit is part of one all-repositories commit run covering: ${repoNames}.
Use the shared confirm analysis to keep commit messages visibly related across repositories, while still describing only the current repository's own diff.`;

      const results: string[] = [];
      const committedRepos: typeof selectedRepos = [];
      for (const repo of selectedRepos) {
        throwIfAborted(signal);
        const result = await runCommitAgentWithSharedConfirm(
          repo.path,
          confirmResult,
          sharedCommitContext,
          options,
        );
        if (/\nHASH: [0-9a-f]+$/.test(result)) {
          committedRepos.push(repo);
        }
        if (selectedRepos.length > 1) {
          results.push(`=== ${repo.name} (${repo.path}) ===\n${result}`);
        } else {
          results.push(result);
        }
      }

      if (args.auto_push && committedRepos.length > 0) {
        throwIfAborted(signal);
        results.push("\n--- Push Results ---");
        for (const repo of committedRepos) {
          throwIfAborted(signal);
          const pushResult = await runPushAgent(repo.path, options);
          if (committedRepos.length > 1) {
            results.push(`=== ${repo.name} (${repo.path}) ===\n${pushResult}`);
          } else {
            results.push(pushResult);
          }
        }
      }

      return { content: [{ type: "text", text: results.join("\n\n") }] };
    }

    // Phase 1: Collect all preferences upfront
    const repoPrefs = new Map<string, { tier: string | undefined; extraContext: string | undefined }>();
    for (const repo of selectedRepos) {
      throwIfAborted(signal);
      if (!args.skip_elicitation && !args.model_tier) {
        const prefs = await elicitPreferences(server.server, repo.name, options);
        throwIfAborted(signal);
        const focus = prefs.focus ? `Focus: ${prefs.focus}` : undefined;
        const combinedExtraContext = args.extra_context && focus ? `${args.extra_context}\n${focus}` : focus || args.extra_context;
        repoPrefs.set(repo.path, { tier: prefs.modelTier, extraContext: combinedExtraContext });
      } else {
        repoPrefs.set(repo.path, { tier: args.model_tier, extraContext: args.extra_context });
      }
    }

    // Phase 2: Process all repos
    const results: string[] = [];
    const committedRepos: typeof selectedRepos = [];
    for (const repo of selectedRepos) {
      throwIfAborted(signal);
      const prefs = repoPrefs.get(repo.path)!;
      let extraContext = prefs.extraContext;

      // Multi-repo context
      if (selectedRepos.length > 1) {
        const repoNames = selectedRepos.map((r) => r.name).join(", ");
        const multiContext = `Note: This is part of a multi-repository commit. Repos: ${repoNames}. Currently evaluating: ${repo.name}.`;
        extraContext = extraContext ? `${multiContext}\n${extraContext}` : multiContext;
      }

      const result = await runCommitAgent(
        repo.path,
        prefs.tier,
        extraContext,
        args.optional_planfile,
        { ...options, repoScope: { mode: "single", repoInfo } },
      );

      // runCommitAgent emits "HASH: <sha>" on its last line only on successful
      // commits (commit.ts:166). All failure paths omit it. Substring-matching
      // the entire output is unsafe because confirm verdicts and commit
      // messages can legitimately contain the words ERROR / FAILED / DECLINED
      // in their analysis text.
      const commitSucceeded = /\nHASH: [0-9a-f]+$/.test(result);
      if (commitSucceeded) {
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
      throwIfAborted(signal);
      let reposToPush = committedRepos;

      // If elicitation is enabled and multiple repos, ask which to push
      if (!args.skip_elicitation && committedRepos.length > 1) {
        reposToPush = await elicitRepoSelection(server.server, {
          ...repoInfo,
          reposWithChanges: committedRepos,
        }, options);
        throwIfAborted(signal);
        if (reposToPush.length === 0) {
          results.push("\nPush skipped: no repositories selected for push.");
          return { content: [{ type: "text", text: results.join("\n\n") }] };
        }
        reposToPush = sortReposSubmodulesFirst(reposToPush, repoInfo);
      }

      results.push("\n--- Push Results ---");
      for (const repo of reposToPush) {
        throwIfAborted(signal);
        const pushResult = await runPushAgent(repo.path, options);
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

registerTimedTool(
  "push",
  {
    title: "Push",
    description: "Push committed changes to remote repository. Detects repos and asks which to push if multiple exist.",
    inputSchema: {
      working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
      skip_elicitation: coercibleBoolean.describe("Skip interactive questions, push all repos")
    }
  },
  async (args, _extra, signal) => {
    const options = { signal };
    const workingDir = args.working_dir || process.cwd();
    const repoInfo = await getRepoInfoCancellable(workingDir, options);
    throwIfAborted(signal);

    // For push, we push all repos (or let user select)
    // Use reposWithChanges as a starting point, but push can also push repos without uncommitted changes
    // that have committed but unpushed changes. For simplicity, push all detected repos.
    let selectedRepos = repoInfo.reposWithChanges;

    // If no repos have uncommitted changes, just push the working dir
    if (selectedRepos.length === 0) {
      const result = await runPushAgent(workingDir, options);
      return { content: [{ type: "text", text: result }] };
    }

    if (!args.skip_elicitation && selectedRepos.length > 1) {
      selectedRepos = await elicitRepoSelection(server.server, repoInfo, options);
      throwIfAborted(signal);
      if (selectedRepos.length === 0) {
        return { content: [{ type: "text", text: "No repositories selected." }] };
      }
    }
    selectedRepos = sortReposSubmodulesFirst(selectedRepos, repoInfo);

    const results: string[] = [];
    for (const repo of selectedRepos) {
      throwIfAborted(signal);
      const result = await runPushAgent(repo.path, options);
      if (selectedRepos.length > 1) {
        results.push(`=== ${repo.name} (${repo.path}) ===\n${result}`);
      } else {
        results.push(result);
      }
    }

    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }
);

registerTimedTool(
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

registerTimedTool(
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
    const projectDir = args.working_dir || process.cwd();
    const transcriptPath = args.transcript_path;
    const result = await dispatchPreToolUseResult({
      session_id: "mcp-validate-intent",
      transcript_path: transcriptPath,
      cwd: projectDir,
      tool_name: activeSpec().mcpWireName("validate_intent"),
      tool_input: { working_dir: projectDir, transcript_path: transcriptPath },
      tool_use_id: `validate-intent-${Date.now()}`,
    });
    const text =
      result.status === "denied"
        ? result.reason ?? "DRIFTED: Intent validation denied the current changes"
        : "## Verdict\nALIGNED: No code changes / no requests to evaluate";
    return { content: [{ type: "text", text }] };
  }
);

registerTimedTool(
  "transcript",
  {
    title: "Transcript",
    description: "Return the absolute path to the current agent session's transcript .jsonl file. Used by the /transcript slash command. Uses the shared session resolver and the most recent transcript-path.txt sidecar under ~/.agent-framework/sessions/<project> when called with no arguments.",
    inputSchema: {
      transcript_path: z.string().optional().describe("Optional explicit transcript file path. Omit to auto-resolve from the most recent session sidecar.")
    }
  },
  async (args) => ({ content: [{ type: "text", text: await runTranscriptAgent(args.transcript_path) }] })
);

registerTimedTool(
  "locate_scenario",
  {
    title: "Locate Scenario",
    description: "Locate a captured scenario from one or more quote substrings. Searches canonical run journals and digest-verified artifacts, then summarizes matching run and record context.",
    inputSchema: {
      quotes: z.array(z.string()).min(1).describe("One or more distinctive quote substrings to search for"),
      working_dir: z.string().optional().describe("Working directory for telemetry/context (defaults to cwd)"),
      transcript_path: z.string().optional().describe("Session transcript path for statusLine")
    }
  },
  async (args, _extra, signal) => {
    const result = await runLocateScenarioMcp(
      {
        quotes: args.quotes,
        workingDir: args.working_dir,
        transcriptPath: args.transcript_path,
      },
      { signal },
    );
    return { content: [{ type: "text", text: result }] };
  }
);

registerTimedTool(
  "scenario_tester",
  {
    title: "Scenario Tester",
    description: "List, read, materialize, and run canonical Scenario fixtures. Use help for details.",
    inputSchema: {
      action: z.enum(SCENARIO_TESTER_ACTIONS).describe("The action to perform"),
      working_dir: z.string().optional().describe("Agent-framework checkout used to discover repository fixtures"),
      scenario_name: scenarioNameSchema.optional().describe("Canonical fixture slug"),
      scenario: scenarioFixtureSchema.optional().describe("Inline canonical fixture"),
      scenario_names: z.array(scenarioNameSchema).optional().describe("Explicit fixture slugs for run_fixtures; omit to run all fixtures"),
      scenario_source: z.enum(SCENARIO_SOURCE_TAGS).optional().describe("Optional source filter for list_fixtures or run_fixtures"),
      run_id: z.string().optional().describe("Canonical run identifier for materialize_scenario"),
      runtime_root: z.string().optional().describe("Optional canonical runtime root containing runs/<run_id>"),
      run_materialized: z.boolean().optional().describe("Immediately execute a newly materialized fixture"),
    }
  },
  async (args) => {
    const result = await handleScenarioTester(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ─── Help Resources ────────────────────────────────────────────────────────
// Each tool's help documentation is exposed as a resource so clients calling
// resources/list (e.g. the host agent's ListMcpResourcesTool) can discover them
// and then fetch the body via resources/read.

const HELP_RESOURCES: Array<{
  tool: string;
  title: string;
  summary: string;
  body: string;
}> = [
  { tool: "check", title: "check -- Help", summary: "Linter, type-check, and deterministic diagnostics summarizer", body: CHECK_HELP },
  { tool: "confirm", title: "confirm -- Help", summary: "Code quality gate", body: CONFIRM_HELP },
  { tool: "fullconfirm", title: "fullconfirm -- Help", summary: "Full code quality gate", body: FULLCONFIRM_HELP },
  { tool: "commit", title: "commit -- Help", summary: "Quality-gated git commit", body: COMMIT_HELP },
  { tool: "push", title: "push -- Help", summary: "Git push wrapper", body: PUSH_HELP },
  { tool: "list_repos", title: "list_repos -- Help", summary: "Repo + submodule status", body: LIST_REPOS_HELP },
  { tool: "validate_intent", title: "validate_intent -- Help", summary: "User intention alignment check", body: VALIDATE_INTENT_HELP },
  { tool: "validate_plan", title: "validate_plan -- Help", summary: "Plan contract validator", body: VALIDATE_PLAN_HELP },
  { tool: "create_planfile", title: "create_planfile -- Help", summary: "Planfile creator", body: CREATE_PLANFILE_HELP },
  { tool: "implement", title: "implement -- Help", summary: "Plan implementation workflow", body: IMPLEMENT_HELP },
  { tool: "validate_implementation", title: "validate_implementation -- Help", summary: "Implementation validator", body: VALIDATE_IMPLEMENTATION_HELP },
  { tool: "scenario_tester", title: "scenario_tester -- Help", summary: "Canonical Scenario fixture tester", body: TESTER_HELP },
  { tool: "transcript", title: "transcript -- Help", summary: "Session transcript path resolver", body: TRANSCRIPT_HELP },
  { tool: "locate_scenario", title: "locate_scenario -- Help", summary: "Captured scenario locator", body: LOCATE_SCENARIO_HELP },
];

for (const { tool, title, summary, body } of HELP_RESOURCES) {
  const uri = `help://${tool}`;
  server.registerResource(
    `${tool}-help`,
    uri,
    {
      title,
      description: summary,
      mimeType: "text/markdown",
    },
    async (resourceUri) => ({
      contents: [
        {
          uri: resourceUri.toString(),
          mimeType: "text/markdown",
          text: body,
        },
      ],
    })
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running on stdio");
