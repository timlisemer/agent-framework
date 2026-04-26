/**
 * Single source of truth for forbidden DENY phrases.
 *
 * Each entry pairs:
 * - `humanReadable`: the phrase as it should appear in the system-prompt
 *   bullet list ("do NOT use these phrases"). Drives the auto-generated
 *   `FORBIDDEN_DENY_PROMPT_LIST` exported below.
 * - `regex`: the post-filter regex used by `isFabricatedDenyReason` in
 *   `tool-approve.ts`. Some regexes are intentionally broader / shape-
 *   matching than the human-readable phrase so morphological variants are
 *   still caught.
 *
 * Both `agent-configs.ts` (for prompt construction at module load) and
 * `tool-approve.ts` (for post-filter detection) consume this single list.
 *
 * @module fabricated-deny-patterns
 */

export const FORBIDDEN_DENY_PATTERNS: { humanReadable: string; regex: RegExp }[] = [
  {
    humanReadable: '"requires explicit user approval" / "without explicit user approval"',
    regex: /without explicit user approval/i,
  },
  {
    humanReadable: '"subagents are denied"',
    regex: /subagents are denied/i,
  },
  {
    humanReadable: '"subagent escalation"',
    regex: /subagent escalation/i,
  },
  {
    humanReadable: '"Bash/Glob workaround"',
    regex: /bash\/glob workaround/i,
  },
  {
    humanReadable: '"workaround pattern"',
    regex: /workaround pattern/i,
  },
  {
    humanReadable: '"prior denials confirm"',
    regex: /prior denials confirm/i,
  },
  {
    humanReadable: '"enforce core tools"',
    regex: /enforce core tools/i,
  },
  {
    humanReadable: '"#N in sequence" / "Nth in sequence" attempt counters',
    regex: /#\s*\d+\+?\s*in sequence/i,
  },
  {
    humanReadable: '"Nth in sequence" wording',
    regex: /\bnth in sequence\b/i,
  },
  {
    humanReadable: '"Matches pattern of repeated <tool> attempts"',
    regex: /matches pattern of repeated [A-Za-z]+ attempts/i,
  },
  {
    humanReadable: '"duplicates Read tool" / "duplicates Read/LS tools"',
    regex: /duplicates?\s+Read(\s*\/\s*LS)?\s+tools?/i,
  },
  {
    humanReadable: '"duplicative of Read"',
    regex: /duplicat\w*\s+(of\s+)?Read/i,
  },
  {
    humanReadable: '"duplicates LS tool"',
    regex: /duplicates?\s+LS\s+tool/i,
  },
  {
    humanReadable: '"use Read tool instead" / "use Read or LS tool instead"',
    regex: /use\s+Read(\s+or\s+LS)?\s+tool\s+instead/i,
  },
  {
    humanReadable:
      '"Read tool can fetch ... for equivalent analysis / pattern search"',
    regex:
      /Read\s+(tool\s+)?(can\s+)?fetch(es)?[^.]*\b(equivalent|analysis|pattern\s+search)/i,
  },
  {
    humanReadable:
      'phrasing that asserts rg/grep/ugrep/find/fd/bfs/awk/sed/ls/jq/wc duplicate Read or LS',
    regex:
      /(rg|grep|ugrep|find|fd|bfs|awk|sed|ls|jq|wc)\b[^.]*\bduplicat\w+\s+(Read|LS)/i,
  },
  {
    humanReadable: 'a literal quote of "cat/head/tail → DENY (use Read tool)"',
    regex: /^cat\/head\/tail\s*→\s*DENY/im,
  },
];

export const FABRICATED_DENY_FINGERPRINTS: RegExp[] = FORBIDDEN_DENY_PATTERNS.map(
  (p) => p.regex,
);

export const FORBIDDEN_DENY_PROMPT_LIST = FORBIDDEN_DENY_PATTERNS.map(
  (p) => `  - ${p.humanReadable}`,
).join("\n");

export function isFabricatedDenyReason(reason: string): boolean {
  return FABRICATED_DENY_FINGERPRINTS.some((re) => re.test(reason));
}
