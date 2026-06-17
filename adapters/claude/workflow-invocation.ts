import * as path from "path";
import type { CanonicalWorkflow } from "../../src/adapter/types.js";
import type { HostContext } from "../../src/adapter/types.js";
import { CANONICAL_WORKFLOWS } from "../../src/adapter/types.js";
import { readAdapterWorkflowInstructionText } from "../shared/workflow-instructions.js";
import { recognizeMcp } from "./recognize-mcp.js";

const KNOWN: ReadonlySet<string> = new Set(CANONICAL_WORKFLOWS);
const RE_TAG   = /<command-name>\s*\/([\w-]+)\s*<\/command-name>/;
const RE_SLASH = /^\s*\/([\w-]+)(?:\s|$)/;
const RE_STRUCTURED_TAGS_ONLY = /^(?:\s*<(command-message|command-name|command-args)>[\s\S]*?<\/\1>\s*)+$/;
const RE_SLASH_ONLY = /^\/([\w-]+)(?:\s+([\s\S]+))?$/;

export function recognizeWorkflowInvocation(content: string): CanonicalWorkflow | null {
  for (const re of [RE_TAG, RE_SLASH]) {
    const m = content.match(re);
    if (m && KNOWN.has(m[1])) return m[1] as CanonicalWorkflow;
  }
  return null;
}

function suffixLooksLikeCommandParameters(command: string, suffix: string): boolean {
  const trimmed = suffix.trim();
  if (!trimmed) return true;
  if (trimmed === "now") return true;
  if (command === "locate-scenario" && /^"[^"]+"$/.test(trimmed)) return true;
  return false;
}

export function isWorkflowInvocationOnly(content: string): boolean {
  const trimmed = content.trim();
  const tag = trimmed.match(RE_TAG);
  if (tag) {
    return KNOWN.has(tag[1]) && RE_STRUCTURED_TAGS_ONLY.test(trimmed);
  }

  const slash = trimmed.match(RE_SLASH_ONLY);
  if (!slash || !KNOWN.has(slash[1])) return false;
  return suffixLooksLikeCommandParameters(slash[1], slash[2] ?? "");
}

export function renderWorkflowInvocation(c: CanonicalWorkflow): string {
  return `/${c}`;
}

export function workflowInstructionText(c: CanonicalWorkflow, host: HostContext): string | null {
  const relative = path.join("commands", `${c}.md`);
  return readAdapterWorkflowInstructionText({
    adapterName: "claude",
    bundledConfigDir: "dotclaude",
    relativePath: relative,
    host,
    recognizeMcp,
  });
}
