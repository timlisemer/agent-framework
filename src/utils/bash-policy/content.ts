import { contentPolicyTargets, resolvePatternAlternative } from "./helpers.js";
import { CHECK_ROUTED_COMMAND_POLICIES, matchCheckRoutedPolicyInContent } from "./topics/check-routed.js";
import type { BlacklistHighlight, BlacklistPattern, ContentBlacklistOptions } from "./types.js";

export function getContentBlacklistHighlights(
  content: string,
  patterns: ReadonlyArray<BlacklistPattern>,
  opts: ContentBlacklistOptions = {},
): BlacklistHighlight[] {
  const highlights: BlacklistHighlight[] = [];
  const lines = content.split("\n");
  let inCodeBlock = false;
  const insideOnly = opts.inverseCodeBlocks === true;
  const checkMcpMessage = opts.checkMcpMessage ?? "Use the check MCP";
  const gitWorkflowMessage = opts.gitWorkflowMessage ?? "Use workflow tools";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (insideOnly && !inCodeBlock) continue;
    if (!insideOnly && inCodeBlock) continue;

    const { target, redactedTarget } = contentPolicyTargets(line, insideOnly);

    for (const { pattern, contentPattern, contentMatcher, name, alternative, bashOnly, redactPaths: shouldRedact } of patterns) {
      if (bashOnly) continue;
      const t = shouldRedact ? redactedTarget : target;
      const re = contentPattern ?? pattern;
      const matched = contentMatcher ? contentMatcher(t) : re.test(t);
      if (matched) {
        const altStr = resolvePatternAlternative(name, alternative, gitWorkflowMessage);
        const rendered = `[VIOLATION: ${name}] "${line.trim()}" → ${altStr}`;
        highlights.push({
          lineIndex: i,
          line,
          message: altStr,
          rendered,
        });
        break;
      }
    }

    for (const policy of CHECK_ROUTED_COMMAND_POLICIES) {
      if (policy.bashOnly) continue;
      if (matchCheckRoutedPolicyInContent(target, policy, redactedTarget)) {
        const altStr = checkMcpMessage;
        const rendered = `[VIOLATION: ${policy.name}] "${line.trim()}" → ${altStr}`;
        highlights.push({
          lineIndex: i,
          line,
          message: altStr,
          rendered,
        });
        break;
      }
    }
  }

  return highlights;
}
