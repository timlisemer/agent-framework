/**
 * Elicitation Helpers - MCP Form-based User Input
 *
 * Utilities for requesting structured input from users mid-tool-execution
 * via MCP elicitation. Used by commit, confirm, and push tools to ask
 * repo selection and preference questions directly, bypassing Claude Code's
 * LLM round-trips.
 *
 * @module elicitation
 */

import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { RepoInfo } from "./git-utils.js";
import { type CancellationOptions, throwIfAborted } from "./cancellation.js";
import { MCP_NO_TIMEOUT_MS, pauseMcpTimeout, resumeMcpTimeout } from "../mcp/timeout.js";

// MCP SDK always calls setTimeout internally with no way to disable it.
// Max 32-bit signed int is the largest value setTimeout accepts.
const NO_TIMEOUT: RequestOptions = { timeout: MCP_NO_TIMEOUT_MS };

interface ElicitInputServer {
  elicitInput(
    params: ElicitRequestFormParams | ElicitRequestURLParams,
    options?: RequestOptions,
  ): Promise<ElicitResult>;
}

function noTimeoutWithCancellation(options: CancellationOptions = {}): RequestOptions {
  return { ...NO_TIMEOUT, signal: options.signal };
}

async function elicitInputNoTimeout<T>(
  mcpServer: ElicitInputServer,
  request: ElicitRequestFormParams | ElicitRequestURLParams,
  options: CancellationOptions = {},
): Promise<T> {
  pauseMcpTimeout();
  try {
    return await mcpServer.elicitInput(request, noTimeoutWithCancellation(options)) as T;
  } finally {
    resumeMcpTimeout();
  }
}

export interface RepoSelection {
  path: string;
  name: string;
}

export interface Preferences {
  modelTier: "haiku" | "sonnet" | "opus";
  focus: string | undefined;
}

const IN_DEPTH_CONFIRM_FOCUS =
  "[generated confirm review-depth guidance] In depth confirm review: do not be lazy. Investigate thoroughly before confirming. Read the relevant changed code and nearby helpers/patterns, search for existing helpers or similar implementations where appropriate, and only CONFIRMED after you have genuinely checked the important files, edge cases, tests/docs implications, and deduplication/generic-code concerns.";

const BROAD_MINIMAL_CONFIRM_FOCUS =
  "[generated confirm review-depth guidance] Broad/minimal confirm review: do a broad but lightweight pass. Check the changed files for obvious correctness, security, documentation, test, and deduplication issues without deep optional exploration unless the diff reveals a concrete risk.";

/**
 * Ask the user which repositories to process when multiple have changes.
 * Returns all repos with changes if only one has changes (no form shown).
 */
export async function elicitRepoSelection(
  mcpServer: ElicitInputServer,
  repoInfo: RepoInfo,
  options: CancellationOptions = {}
): Promise<RepoSelection[]> {
  throwIfAborted(options.signal);
  const repos = repoInfo.reposWithChanges;

  if (repos.length === 0) {
    return [];
  }

  // Single repo — no need to ask
  if (repos.length === 1) {
    return repos;
  }

  // Build dynamic schema with one boolean per repo
  const properties: Record<string, { type: "boolean"; title: string; description: string; default: boolean }> = {};
  for (const repo of repos) {
    properties[repo.path] = {
      type: "boolean",
      title: repo.name,
      description: repo.path,
      default: true,
    };
  }

  const result = await elicitInputNoTimeout<ElicitResult>(mcpServer, {
    mode: "form",
    message: "Multiple repositories have uncommitted changes. Select which to process:",
    requestedSchema: {
      type: "object",
      properties,
    },
  }, options);

  throwIfAborted(options.signal);

  if (result.action !== "accept" || !result.content) {
    return [];
  }

  // Filter to selected repos
  return repos.filter((repo) => result.content![repo.path] === true);
}

/**
 * Ask the user for model tier and focus area preferences for a repo.
 */
export async function elicitPreferences(
  mcpServer: ElicitInputServer,
  repoName: string,
  options: CancellationOptions = {}
): Promise<Preferences> {
  throwIfAborted(options.signal);
  const result = await elicitInputNoTimeout<ElicitResult>(mcpServer, {
    mode: "form",
    message: `Preferences for ${repoName}:`,
    requestedSchema: {
      type: "object",
      properties: {
        model_tier: {
          type: "string",
          title: "Model tier for code review",
          description: "opus = most thorough (default), sonnet = balanced, haiku = fastest",
          enum: ["opus", "sonnet", "haiku"],
          default: "opus",
        },
        focus: {
          type: "string",
          title: "Confirm review depth",
          description: "Default review, deeper investigation, or broad/minimal pass",
          enum: ["Default", "In depth", "Broad/minimal"],
          default: "Default",
        },
      },
    },
  }, options);

  throwIfAborted(options.signal);

  if (result.action !== "accept" || !result.content) {
    return { modelTier: "opus", focus: undefined };
  }

  const tier = (result.content.model_tier as string) || "opus";
  const focus = result.content.focus as string;

  return {
    modelTier: tier as "haiku" | "sonnet" | "opus",
    focus: focus === "In depth"
      ? IN_DEPTH_CONFIRM_FOCUS
      : focus === "Broad/minimal"
        ? BROAD_MINIMAL_CONFIRM_FOCUS
        : undefined,
  };
}

/**
 * Sort repos so submodules come first, main repo last.
 * This ensures submodule pointers are updated before committing the main repo.
 */
export function sortReposSubmodulesFirst(
  selected: RepoSelection[],
  repoInfo: RepoInfo
): RepoSelection[] {
  const mainRepoPath = repoInfo.mainRepo;
  const submodules = selected.filter((r) => r.path !== mainRepoPath);
  const main = selected.filter((r) => r.path === mainRepoPath);
  return [...submodules, ...main];
}

/**
 * Parse UNCERTAIN markers from a DECLINED confirm agent result.
 * Returns empty array if no markers found or result is not DECLINED.
 */
export function parseUncertainties(
  confirmOutput: string
): Array<{ category: string; description: string }> {
  if (!confirmOutput.includes("DECLINED")) {
    return [];
  }

  const markers: Array<{ category: string; description: string }> = [];
  const lines = confirmOutput.split("\n");
  for (const line of lines) {
    const match = line.match(/^UNCERTAIN:\s*(\w+)\s*[—–-]\s*(.+)$/);
    if (match) {
      markers.push({ category: match[1], description: match[2].trim() });
    }
  }
  return markers;
}

/**
 * Build an elicitation form from uncertainty markers and ask the user.
 * Returns extra_context string if user provides clarification, or undefined.
 */
export async function elicitUncertaintyClarification(
  mcpServer: ElicitInputServer,
  uncertainties: Array<{ category: string; description: string }>,
  options: CancellationOptions = {}
): Promise<string | undefined> {
  throwIfAborted(options.signal);
  if (uncertainties.length === 0) {
    return undefined;
  }

  const properties: Record<string, { type: "string"; title: string; description: string }> = {};
  for (const u of uncertainties) {
    properties[u.category] = {
      type: "string",
      title: u.category,
      description: u.description,
    };
  }

  const result = await elicitInputNoTimeout<ElicitResult>(mcpServer, {
    mode: "form",
    message: "The quality gate declined but flagged uncertainties that your input could resolve:",
    requestedSchema: {
      type: "object",
      properties,
    },
  }, options);

  throwIfAborted(options.signal);

  if (result.action !== "accept" || !result.content) {
    return undefined;
  }

  // Build extra_context from user responses
  const clarifications: string[] = [];
  for (const u of uncertainties) {
    const answer = result.content[u.category];
    if (answer && typeof answer === "string" && answer.trim()) {
      clarifications.push(`${u.category}: ${answer}`);
    }
  }

  return clarifications.length > 0
    ? `User clarifications:\n${clarifications.join("\n")}`
    : undefined;
}
