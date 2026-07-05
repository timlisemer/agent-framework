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
import { evaluateRules } from "../rules/index.js";
import { validateIntentRule } from "../rules/validate-intent.js";
import { getSessionState } from "../utils/session-store.js";
import { getAgentFrameworkSessionDir } from "../utils/paths.js";
import { handleScenarioLabeler, LABELER_HELP } from "../agents/mcp/scenario-labeler.js";
import { handleScenarioTester, TESTER_HELP } from "../agents/mcp/scenario-tester.js";
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
import {
  richExpectationSchema,
  scenarioSchema,
} from "./scenario-schema.js";
import {
  McpToolTimeoutError,
  formatMcpTimeoutError,
  runMcpToolWithTimeout,
} from "./timeout.js";

const coercibleBoolean = z.preprocess(
  (val) => (typeof val === "string" ? val === "true" : val),
  z.boolean().optional()
);

function implementationWorkflowInputSchema() {
  return {
    working_dir: z.string().optional().describe("Working directory (defaults to cwd)"),
    planfile: z.string().optional().describe("Path to the plan file. If omitted, resolves the active current-plan sidecar for working_dir."),
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
  server.registerTool(name, config, timedHandler);
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
    description: "Run linter, make/just check, deterministic filename-reference diagnostics (deleted/renamed errors plus docs/config missing-file warnings), and supplemental editor diagnostics; return summarized results with warning recommendations.",
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
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
    const stateManager = getSessionState(sessionDir);
    const state = await stateManager.load();
    const ctx = {
      hookEvent: "PreToolUse" as const,
      toolName: "mcp-validate_intent",
      rawToolName: activeSpec().mcpWireName("validate_intent"),
      toolInput: {},
      toolUseId: "validate-intent-mcp",
      projectDir,
      transcriptPath,
      sessionDir,
      sessionId: "mcp",
      state,
      stateManager,
      planMode: false,
      planModeCtx: { active: false, contextString: "" },
    };
    const result = await evaluateRules([validateIntentRule], ctx, "PreToolUse");
    const text =
      result?.decision === "deny"
        ? result.reason
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
    description: "Locate a captured scenario from one or more quote substrings. Runs predefined searches over adapter transcripts and agent-framework session logs, then summarizes candidate captures.",
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
  "scenario_labeler",
  {
    title: "Scenario Labeler",
    description: "Label test harness transcripts. Actions: find_work, auto_label, generate_labels, scaffold, list, expand, validate, update_label, update_labels, set_label, update_label_prediction, update_label_predictions, reset_for_relabel, finalize, read_file, append_notes, git_hash, help. Use help action for full documentation.",
    inputSchema: {
      action: z.enum([
        "find_work", "auto_label", "generate_labels", "scaffold", "list", "expand", "validate",
        "update_label", "update_labels", "set_label",
        "update_label_prediction", "update_label_predictions", "reset_for_relabel",
        "finalize", "read_file", "append_notes",
        "git_hash", "help"
      ]).describe("The action to perform"),
      transcript_name: z.string().optional().describe("Transcript name (without .jsonl extension)"),
      target: z.string().optional().describe("For expand: tool_use_id or stop:N key"),
      depth: z.number().optional().describe("For expand: context radius multiplier (default 1)"),
      key: z.string().optional().describe("For update_label/set_label/update_label_prediction: the label key to update"),
      value: z.string().optional().describe("For update_label: the new label value (allow/deny/pass/block)"),
      reasoning: z.string().optional().describe("For update_label/set_label/update_label_prediction: explanation for this label decision"),
      updates: z.array(z.object({
        key: z.string(),
        value: z.string(),
        reasoning: z.string(),
      })).optional().describe("For update_labels: array of {key, value, reasoning} updates"),
      expectation: z.union([richExpectationSchema, z.array(richExpectationSchema)]).optional().describe("For set_label: a rich expectation object (or array of them) with {expected, by?, at?, notes?, prediction?}. Use this when you need 'expected deny by rule X' or per-truncation assertions that the plain update_label string form cannot express."),
      verdict: z.enum(["correct", "too_broad", "wrong", "INVESTIGATE"]).optional().describe("For update_label_prediction: hindsight verdict on the prediction that caused this deny."),
      forbidden_blocks: z.array(z.object({
        tool: z.string().optional(),
        target_pattern: z.string().optional(),
      })).optional().describe("For update_label_prediction: required when verdict='too_broad'. LITERAL tool names the prediction MUST NOT match after narrowing."),
      intent_must_contain: z.string().optional().describe("For update_label_prediction: substring that must appear in the live prediction's intent."),
      prediction_updates: z.array(z.object({
        key: z.string(),
        verdict: z.enum(["correct", "too_broad", "wrong", "INVESTIGATE"]),
        forbidden_blocks: z.array(z.object({
          tool: z.string().optional(),
          target_pattern: z.string().optional(),
        })).optional(),
        intent_must_contain: z.string().optional(),
        expected_mood: z.enum(["angry", "frustrated", "neutral", "satisfied", "happy"]).optional(),
        expected_trust: z.enum(["low", "normal", "high"]).optional(),
        notes: z.string().optional(),
        reasoning: z.string(),
      })).optional().describe("For update_label_predictions: batch updates of prediction annotations."),
      filename: z.string().optional().describe("For read_file: labels.draft.json, labels.json, notes_and_questions.md, or report.json"),
      content: z.string().optional().describe("For append_notes: content to append"),
      date_from: z.string().optional().describe("For find_work: only transcripts modified on or after this date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("For find_work: only transcripts modified on or before this date (YYYY-MM-DD)"),
      limit: z.number().optional().describe("For find_work: how many transcripts to process. Omit=1, 0=unlimited, N=N"),
      transcript_path: z.string().optional().describe("Absolute path to a transcript .jsonl file. Use when the transcript lives outside the active adapter's default transcript storage (Claude: ~/.claude/projects/<encoded-project>/; Codex: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl). You may also pass a session folder name (e.g. '2025-01-15-1430_abc12345') and the resolver will look up the path via the session sidecar at ~/.agent-framework/sessions/. Applies to auto_label/generate_labels/scaffold/list/expand/validate. Only needed once; subsequent actions find the transcript in ~/.agent-framework/test-runs/<name>/ after the first copy."),
      working_dir: z.string().optional().describe("Local repo path. When set, the labeler invokes replay.ts from this directory instead of the deployed AGENT_FRAMEWORK_ROOT, so locally edited test-harness/ source is used. Mirrors the tester's `working_dir`."),
    }
  },
  async (args) => {
    const result = await handleScenarioLabeler(args);
    return { content: [{ type: "text", text: result }] };
  }
);

registerTimedTool(
  "scenario_tester",
  {
    title: "Scenario Tester",
    description: "Run test harness against labeled transcripts OR against synthetic scenarios. Actions: find_work, run_test, run_single_hook, list, expand, read_file, append_notes, materialize_scenario, run_scenario, run_scenarios, list_scenarios, read_scenario, git_hash, help. Use help action for full documentation.",
    inputSchema: {
      action: z.enum([
        "find_work", "run_test", "run_single_hook", "list", "expand", "read_file", "append_notes", "materialize_scenario",
        "run_scenario", "run_scenarios", "list_scenarios", "read_scenario",
        "git_hash", "help"
      ]).describe("The action to perform"),
      transcript_name: z.string().optional().describe("Transcript name (without .jsonl extension)"),
      target: z.string().optional().describe("For expand: tool_use_id or stop:N key"),
      depth: z.number().optional().describe("For expand: context radius multiplier (default 1)"),
      filename: z.string().optional().describe("For read_file: report.json, labels.json, labels.draft.json, or notes_and_questions.md. For read_scenario: scenario.json or report-scenario.json."),
      content: z.string().optional().describe("For append_notes: content to append"),
      hook_key: z.string().optional().describe("For run_single_hook: hook key to test (tool_use_id or stop:N from report failures)"),
      session_dir: z.string().optional().describe("For materialize_scenario: agent-framework session directory containing captures.jsonl, state-snapshots.jsonl, and transcript-path.txt"),
      capture_seq: z.number().optional().describe("For materialize_scenario: numeric capture seq from captures.jsonl"),
      run_materialized: z.boolean().optional().describe("For materialize_scenario: immediately run the stored materialized scenario after writing it"),
      working_dir: z.string().optional().describe("Local repo path for run_test/run_single_hook/list/expand/run_scenario/run_scenarios/list_scenarios (overrides AGENT_FRAMEWORK_ROOT so edited code AND locally-edited fixture scenarios are used)"),
      truncate_to_line: z.number().optional().describe("For run_single_hook: 1-based line cap. When set, the harness appends only transcript lines <= truncate_to_line before firing the target hook. The hook still fires with its full tool_use_id because input is synthesized from the in-memory parsed lines. Use this to reproduce timing-sensitive states like pre-flush replay."),
      transcript_path: z.string().optional().describe("Absolute path to a transcript .jsonl file. Use when the transcript lives outside the active adapter's default transcript storage (Claude: ~/.claude/projects/<encoded-project>/; Codex: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl). You may also pass a session folder name (e.g. '2025-01-15-1430_abc12345') and the resolver will look up the path via the session sidecar at ~/.agent-framework/sessions/. Only needed if the test-runs copy is not yet in place."),
      scenario_name: z.string().optional().describe("For run_scenario / read_scenario: slug identifying a scenario. For run_scenario, resolved across the union of four sources: ~/.agent-framework/test-runs/scenarios/<name>/scenario.json (home) and <AGENT_FRAMEWORK_ROOT>/scenarios/{expected-to-pass,non-deterministic,expected-to-fail}/<name>.json (committed fixtures). Slugs must be unique across all four sources. read_scenario still reads only from the home tree. Must match [A-Za-z0-9._-]+."),
      scenario: scenarioSchema.optional().describe("For run_scenario: inline Scenario JSON. When set, overwrites the on-disk scenarios/<name>/scenario.json before running. Omit to re-run a previously stored scenario. See the 'help' action (Workflow B) for the full schema and examples."),
      scenario_names: z.array(z.string()).optional().describe("For run_scenarios: explicit list of scenario slugs to run. Resolved against the UNION of four sources: ~/.agent-framework/test-runs/scenarios/<name>/scenario.json (home) and <AGENT_FRAMEWORK_ROOT>/scenarios/{expected-to-pass,non-deterministic,expected-to-fail}/<name>.json (committed fixtures). A slug present in two or more sources is a hard error. Fixtures run in place; reports + cache always land under the home tree. Omit or pass an empty array to run EVERY scenario in the union, alphabetically. Returns aggregated JSON {total, passed, failed, results[]} with per-result {source: \"home\"|\"expected-to-pass\"|\"non-deterministic\"|\"expected-to-fail\"}. Each result also carries `expectation_reality: \"expected-to-pass\" | \"non-deterministic\" | \"expected-to-fail\" | null` and `expectation_reality_last_run_at: ISO-8601` — the most recent run's reality, written to last-run.json sidecar. A mismatch between folder and reality surfaces regressions or landed features. The aggregate response does NOT summarize mismatches; callers inspect `results[]` directly."),
      scenario_source: z.enum(["expected-to-pass", "non-deterministic", "expected-to-fail", "home"]).optional().describe("For run_scenarios / list_scenarios: scope to ONE source. 'expected-to-pass' | 'non-deterministic' | 'expected-to-fail' select fixture subfolders (<AGENT_FRAMEWORK_ROOT>/scenarios/<sub>/). 'home' selects ~/.agent-framework/test-runs/scenarios/. Omit to include all four. Slug uniqueness is enforced across all four roots regardless of filter."),
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
  { tool: "scenario_tester", title: "scenario_tester -- Help", summary: "Scenario tester (transcripts + scenarios)", body: TESTER_HELP },
  { tool: "scenario_labeler", title: "scenario_labeler -- Help", summary: "Scenario transcript labeler", body: LABELER_HELP },
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
