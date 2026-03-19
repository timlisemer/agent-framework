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

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RepoInfo } from "./git-utils.js";

// MCP SDK always calls setTimeout internally with no way to disable it.
// Max 32-bit signed int is the largest value setTimeout accepts.
const NO_TIMEOUT: RequestOptions = { timeout: 2147483647 };

export interface RepoSelection {
  path: string;
  name: string;
}

export interface Preferences {
  modelTier: "haiku" | "sonnet" | "opus";
  focus: string | undefined;
}

/**
 * Ask the user which repositories to process when multiple have changes.
 * Returns all repos with changes if only one has changes (no form shown).
 */
export async function elicitRepoSelection(
  mcpServer: Server,
  repoInfo: RepoInfo
): Promise<RepoSelection[]> {
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

  const result = await mcpServer.elicitInput({
    mode: "form",
    message: "Multiple repositories have uncommitted changes. Select which to process:",
    requestedSchema: {
      type: "object",
      properties,
    },
  }, NO_TIMEOUT);

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
  mcpServer: Server,
  repoName: string
): Promise<Preferences> {
  const result = await mcpServer.elicitInput({
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
          title: "Any specific areas to focus on?",
          description: "Standard review, or extra focus on security/performance",
          enum: ["None", "Security", "Performance"],
          default: "None",
        },
      },
    },
  }, NO_TIMEOUT);

  if (result.action !== "accept" || !result.content) {
    return { modelTier: "opus", focus: undefined };
  }

  const tier = (result.content.model_tier as string) || "opus";
  const focus = result.content.focus as string;

  return {
    modelTier: tier as "haiku" | "sonnet" | "opus",
    focus: focus && focus !== "None" ? focus : undefined,
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
  mcpServer: Server,
  uncertainties: Array<{ category: string; description: string }>
): Promise<string | undefined> {
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

  const result = await mcpServer.elicitInput({
    mode: "form",
    message: "The quality gate declined but flagged uncertainties that your input could resolve:",
    requestedSchema: {
      type: "object",
      properties,
    },
  }, NO_TIMEOUT);

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
