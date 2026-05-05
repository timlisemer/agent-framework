import type { CanonicalWorkflow } from "../../src/adapter/types.js";
import { CANONICAL_WORKFLOWS } from "../../src/adapter/types.js";

const KNOWN: ReadonlySet<string> = new Set(CANONICAL_WORKFLOWS);
const RE_TAG   = /<command-name>\s*\/([\w-]+)\s*<\/command-name>/;
const RE_SLASH = /^\s*\/([\w-]+)(?:\s|$)/;

export function recognizeWorkflowInvocation(content: string): CanonicalWorkflow | null {
  for (const re of [RE_TAG, RE_SLASH]) {
    const m = content.match(re);
    if (m && KNOWN.has(m[1])) return m[1] as CanonicalWorkflow;
  }
  return null;
}

export function renderWorkflowInvocation(c: CanonicalWorkflow): string {
  return `/${c}`;
}
