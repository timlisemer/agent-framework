import type { CanonicalWorkflow } from "../../src/adapter/types.js";
import { CANONICAL_WORKFLOWS } from "../../src/adapter/types.js";

const KNOWN: ReadonlySet<string> = new Set(CANONICAL_WORKFLOWS);
const RE_DOLLAR = /(?:^|\s)\$agent-framework-([\w-]+)\b/;
const RE_TAG    = /<name>\s*agent-framework-([\w-]+)\s*<\/name>/;
const RE_FRONT  = /^name:\s*agent-framework-([\w-]+)\b/m;

export function recognizeWorkflowInvocation(content: string): CanonicalWorkflow | null {
  for (const re of [RE_DOLLAR, RE_TAG, RE_FRONT]) {
    const m = content.match(re);
    if (m && KNOWN.has(m[1])) return m[1] as CanonicalWorkflow;
  }
  return null;
}

export function renderWorkflowInvocation(c: CanonicalWorkflow): string {
  return `$agent-framework-${c}`;
}
