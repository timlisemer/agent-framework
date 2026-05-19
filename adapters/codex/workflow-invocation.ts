import type { CanonicalWorkflow } from "../../src/adapter/types.js";
import { CANONICAL_WORKFLOWS } from "../../src/adapter/types.js";

const KNOWN: ReadonlySet<string> = new Set(CANONICAL_WORKFLOWS);
const RE_DOLLAR = /(?:^|\s)\$agent-framework-([\w-]+)\b/;
const RE_TAG    = /<name>\s*agent-framework-([\w-]+)\s*<\/name>/;
const RE_FRONT  = /^name:\s*agent-framework-([\w-]+)\b/m;
const RE_DOLLAR_ONLY = /^\$agent-framework-([\w-]+)$/;
const RE_SKILL_ONLY = /^<skill\b[\s\S]*<name>\s*agent-framework-([\w-]+)\s*<\/name>[\s\S]*<\/skill>$/;
const RE_FRONTMATTER_ONLY = /^---\r?\n([\s\S]*?)\r?\n---$/;

export function recognizeWorkflowInvocation(content: string): CanonicalWorkflow | null {
  for (const re of [RE_DOLLAR, RE_TAG, RE_FRONT]) {
    const m = content.match(re);
    if (m && KNOWN.has(m[1])) return m[1] as CanonicalWorkflow;
  }
  return null;
}

export function isWorkflowInvocationOnly(content: string): boolean {
  const trimmed = content.trim();
  const dollar = trimmed.match(RE_DOLLAR_ONLY);
  if (dollar) return KNOWN.has(dollar[1]);

  const skill = trimmed.match(RE_SKILL_ONLY);
  if (skill) return KNOWN.has(skill[1]);

  const frontmatter = trimmed.match(RE_FRONTMATTER_ONLY);
  if (frontmatter) {
    const name = frontmatter[1].match(RE_FRONT);
    return !!name && KNOWN.has(name[1]);
  }

  return false;
}

export function renderWorkflowInvocation(c: CanonicalWorkflow): string {
  return `$agent-framework-${c}`;
}
