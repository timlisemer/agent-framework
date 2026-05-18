import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EXECUTION_TYPES, MODEL_TIERS } from "../../types.js";
import { activeSpec } from "../../adapter/spec.js";
import { runAgent, type AgentConfig } from "../../utils/agent-runner.js";
import { runProcessCancellable } from "../../utils/command.js";
import { setTranscriptPath } from "../../utils/execution-context.js";
import { logAgentStarted, logAgentResult } from "../../utils/logger.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";

type SearchKind = "transcript" | "tool-log" | "captures" | "injections";

export interface LocateScenarioInput {
  quotes: string[];
  workingDir?: string;
  transcriptPath?: string;
}

export interface SearchRoots {
  claudeProjects: string;
  codexSessions: string;
  agentSessions: string;
}

interface RgHit {
  kind: SearchKind;
  quote: string;
  path: string;
  line: number;
  text: string;
}

export interface LocateCandidate {
  quote: string;
  kind: SearchKind;
  sourcePath: string;
  line: number;
  sessionDir?: string;
  captureSeq?: number;
  event?: string;
  decision?: string;
  toolUseId?: string;
  injectionSeq?: number;
  transcriptUuid?: string;
  transcriptSessionId?: string;
  excerpt: string;
}

interface LocateSearchResult {
  commands: string[];
  candidates: LocateCandidate[];
}

const MAX_HITS_PER_COMMAND = 30;
const MAX_SUMMARY_CANDIDATES = 20;

const LOCATE_SUMMARIZER: AgentConfig = {
  name: "locate-scenario",
  tier: MODEL_TIERS.HAIKU,
  mode: "direct",
  workingDir: process.cwd(),
  maxTokens: 2000,
  systemPrompt: `You summarize deterministic locate_scenario MCP findings.

Output exactly this shape:

## Findings
<concise summary>

Rules:
- Report only facts present in the search findings.
- Include session_dir and capture_seq when present.
- State when findings are ambiguous or when multiple candidates matched.
- Do not instruct the caller to run shell commands.
- Do not invent materialization results.`,
  formatValidation: {
    validator: /## Findings/i,
    formatReminder: "Reply with a ## Findings section.",
    fallbackOutput: `## Findings
$RAW`,
  },
};

function getHookName(): string {
  return activeSpec().mcpWireName("locate_scenario");
}

function defaultRoots(): SearchRoots {
  const home = os.homedir();
  return {
    claudeProjects: path.join(home, ".claude", "projects"),
    codexSessions: path.join(home, ".codex", "sessions"),
    agentSessions: path.join(home, ".agent-framework", "sessions"),
  };
}

function existing(paths: string[]): string[] {
  return paths.filter((p) => fs.existsSync(p));
}

function renderCommand(quote: string, roots: string[], glob?: string): string {
  const parts = ["rg -n --no-heading --color=never -F"];
  if (glob) parts.push(`--glob ${JSON.stringify(glob)}`);
  parts.push(JSON.stringify(quote), ...roots.map((r) => JSON.stringify(r)));
  return parts.join(" ");
}

function parseRgOutput(kind: SearchKind, quote: string, output: string): RgHit[] {
  const hits: RgHit[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    hits.push({
      kind,
      quote,
      path: m[1],
      line: Number(m[2]),
      text: m[3],
    });
  }
  return hits;
}

async function rgSearch(
  kind: SearchKind,
  quote: string,
  roots: string[],
  options: CancellationOptions,
  glob?: string,
): Promise<{ command: string; hits: RgHit[] }> {
  const present = existing(roots);
  const command = renderCommand(quote, present.length > 0 ? present : roots, glob);
  if (present.length === 0) return { command, hits: [] };

  const args = [
    "-n",
    "--no-heading",
    "--color=never",
    "-F",
    ...(glob ? ["--glob", glob] : []),
    quote,
    ...present,
  ];
  const result = await runProcessCancellable(
    { shell: false, file: "rg", args },
    process.cwd(),
    { ...options, maxStdoutBytes: 512 * 1024, maxStderrBytes: 64 * 1024 },
  );
  if (result.exitCode !== 0 && !result.output.trim()) {
    return { command, hits: [] };
  }
  return {
    command,
    hits: parseRgOutput(kind, quote, result.output).slice(0, MAX_HITS_PER_COMMAND),
  };
}

function sessionDirFromLogPath(filePath: string): string {
  return path.dirname(filePath);
}

function safeJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readLine(filePath: string, lineNo: number): string | null {
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    return lines[lineNo - 1] ?? null;
  } catch {
    return null;
  }
}

function parseTranscriptMeta(hit: RgHit): Pick<LocateCandidate, "transcriptUuid" | "transcriptSessionId"> {
  const line = readLine(hit.path, hit.line);
  const json = line ? safeJson(line) : null;
  return {
    transcriptUuid: typeof json?.uuid === "string" ? json.uuid : undefined,
    transcriptSessionId: typeof json?.sessionId === "string" ? json.sessionId : undefined,
  };
}

async function resolveSessionDirForTranscript(
  transcriptPath: string,
  roots: SearchRoots,
  options: CancellationOptions,
): Promise<string | undefined> {
  if (!fs.existsSync(roots.agentSessions)) return undefined;
  const result = await runProcessCancellable(
    {
      shell: false,
      file: "rg",
      args: [
        "-l",
        "--color=never",
        "-F",
        "--glob",
        "**/transcript-path.txt",
        transcriptPath,
        roots.agentSessions,
      ],
    },
    process.cwd(),
    { ...options, maxStdoutBytes: 128 * 1024, maxStderrBytes: 32 * 1024 },
  );
  const first = result.output.split("\n").find((line) => line.trim());
  return first ? path.dirname(first.trim()) : undefined;
}

function findCaptureByToolUseId(sessionDir: string, toolUseId: string): Partial<LocateCandidate> {
  const captures = path.join(sessionDir, "captures.jsonl");
  if (!fs.existsSync(captures)) return {};
  for (const line of fs.readFileSync(captures, "utf-8").split("\n")) {
    const json = safeJson(line);
    if (json?.tool_use_id !== toolUseId) continue;
    return {
      captureSeq: typeof json.seq === "number" ? json.seq : undefined,
      event: typeof json.event === "string" ? json.event : undefined,
      decision: typeof json.decision === "string" ? json.decision : undefined,
      toolUseId,
    };
  }
  return { toolUseId };
}

function findCaptureByInjectionSeq(sessionDir: string, injectionSeq: number): Partial<LocateCandidate> {
  const captures = path.join(sessionDir, "captures.jsonl");
  if (!fs.existsSync(captures)) return {};
  for (const line of fs.readFileSync(captures, "utf-8").split("\n")) {
    const json = safeJson(line);
    const seqs = Array.isArray(json?.injection_seqs) ? json.injection_seqs : [];
    if (!seqs.includes(injectionSeq)) continue;
    return {
      captureSeq: typeof json?.seq === "number" ? json.seq : undefined,
      event: typeof json?.event === "string" ? json.event : undefined,
      decision: typeof json?.decision === "string" ? json.decision : undefined,
      injectionSeq,
    };
  }
  return { injectionSeq };
}

function candidateKey(c: LocateCandidate): string {
  return [
    c.quote,
    c.kind,
    c.sourcePath,
    c.line,
    c.sessionDir ?? "",
    c.captureSeq ?? "",
    c.toolUseId ?? "",
    c.injectionSeq ?? "",
  ].join("\0");
}

async function candidateFromHit(
  hit: RgHit,
  roots: SearchRoots,
  options: CancellationOptions,
): Promise<LocateCandidate> {
  if (hit.kind === "transcript") {
    const sessionDir = await resolveSessionDirForTranscript(hit.path, roots, options);
    return {
      quote: hit.quote,
      kind: hit.kind,
      sourcePath: hit.path,
      line: hit.line,
      sessionDir,
      ...parseTranscriptMeta(hit),
      excerpt: hit.text.slice(0, 500),
    };
  }

  const sessionDir = sessionDirFromLogPath(hit.path);
  const line = readLine(hit.path, hit.line);
  const json = line ? safeJson(line) : null;
  const base: LocateCandidate = {
    quote: hit.quote,
    kind: hit.kind,
    sourcePath: hit.path,
    line: hit.line,
    sessionDir,
    excerpt: hit.text.slice(0, 500),
  };

  if (hit.kind === "tool-log") {
    const toolUseId = typeof json?.toolUseId === "string" ? json.toolUseId : undefined;
    return toolUseId ? { ...base, ...findCaptureByToolUseId(sessionDir, toolUseId) } : base;
  }

  if (hit.kind === "captures") {
    return {
      ...base,
      captureSeq: typeof json?.seq === "number" ? json.seq : undefined,
      event: typeof json?.event === "string" ? json.event : undefined,
      decision: typeof json?.decision === "string" ? json.decision : undefined,
      toolUseId: typeof json?.tool_use_id === "string" ? json.tool_use_id : undefined,
    };
  }

  const injectionSeq = typeof json?.seq === "number" ? json.seq : undefined;
  return injectionSeq !== undefined
    ? { ...base, ...findCaptureByInjectionSeq(sessionDir, injectionSeq) }
    : base;
}

export async function locateScenarioCandidates(
  quotes: string[],
  options: CancellationOptions = {},
  roots: SearchRoots = defaultRoots(),
): Promise<LocateSearchResult> {
  const commands: string[] = [];
  const hits: RgHit[] = [];

  for (const quote of quotes) {
    throwIfAborted(options.signal);
    const searches = [
      await rgSearch("transcript", quote, [roots.claudeProjects, roots.codexSessions], options),
      await rgSearch("tool-log", quote, [roots.agentSessions], options, "**/tool-log.jsonl"),
      await rgSearch("captures", quote, [roots.agentSessions], options, "**/captures.jsonl"),
      await rgSearch("injections", quote, [roots.agentSessions], options, "**/session-injections.jsonl"),
    ];
    for (const search of searches) {
      commands.push(search.command);
      hits.push(...search.hits);
    }
  }

  const seen = new Set<string>();
  const candidates: LocateCandidate[] = [];
  for (const hit of hits) {
    const candidate = await candidateFromHit(hit, roots, options);
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }

  return { commands, candidates };
}

function formatCandidates(candidates: LocateCandidate[]): string {
  return candidates.slice(0, MAX_SUMMARY_CANDIDATES).map((c, i) => {
    const fields = [
      `candidate=${i + 1}`,
      `quote=${JSON.stringify(c.quote)}`,
      `kind=${c.kind}`,
      `source=${c.sourcePath}:${c.line}`,
      c.sessionDir ? `session_dir=${c.sessionDir}` : "session_dir=(unresolved)",
      c.captureSeq !== undefined ? `capture_seq=${c.captureSeq}` : undefined,
      c.event ? `event=${c.event}` : undefined,
      c.decision ? `decision=${c.decision}` : undefined,
      c.toolUseId ? `tool_use_id=${c.toolUseId}` : undefined,
      c.injectionSeq !== undefined ? `injection_seq=${c.injectionSeq}` : undefined,
      c.transcriptUuid ? `uuid=${c.transcriptUuid}` : undefined,
      c.transcriptSessionId ? `session_id=${c.transcriptSessionId}` : undefined,
      `excerpt=${JSON.stringify(c.excerpt)}`,
    ].filter(Boolean);
    return fields.join("\n");
  }).join("\n\n");
}

function successInstructions(): string {
  const spec = activeSpec();
  const materializeMcp = spec.mcpWireName("scenario_tester");
  return `## Required Next Steps
- Notify the user that the locate_scenario MCP found one or more likely scenario captures.
- If the user already requested that the found scenario be materialized, call ${materializeMcp} with action "materialize_scenario", using the located session_dir and capture_seq.
- If the user did not already request materialization, stop here and ask the user before materializing.`;
}

export function locateScenarioFailureOutput(commands: string[]): string {
  return `## Locate Scenario Failed
The locate_scenario MCP did not find any matches with its predefined commands.

## Commands Tried
${commands.map((cmd) => `- ${cmd}`).join("\n") || "- (none)"}

## Manual Fallback Guidance

This is the manual recipe for an agent session asked to find the scenario where a previous session said or did a quoted thing.

### Where data lives

| Path | What's there |
|------|--------------|
| \`~/.claude/projects/<encoded>/<session-id>.jsonl\` | Raw Claude transcript: user/assistant/tool_result lines, literal text, tool inputs and outputs. |
| \`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl\` | Raw Codex transcript: response items, event messages, user/assistant text, and function/tool calls. |
| \`~/.agent-framework/sessions/<encoded>/<yyyy-mm-dd-HHmm>_<hash>/captures.jsonl\` | One compact pointer per hook fire with seq, event, tool_use_id, decision, state_snapshot_seq, and related metadata. |
| \`~/.agent-framework/sessions/<encoded>/<dir>/state-snapshots.jsonl\` | Append-only state snapshots referenced by capture pointers. |
| \`~/.agent-framework/sessions/<encoded>/<dir>/epochs.jsonl\` | One line per epoch. |
| \`~/.agent-framework/sessions/<encoded>/<dir>/tool-log.jsonl\` | Append-only tool-call log with toolUseId, status, gate, reason, and timing. |
| \`~/.agent-framework/sessions/<encoded>/<dir>/plan-mode-events.jsonl\` | Append-only plan-mode transition log. |
| \`~/.agent-framework/sessions/<encoded>/<dir>/session-injections.jsonl\` | Append-only injected-context log. File-backed injections include exact source content and hashes. |
| \`~/.agent-framework/sessions/<encoded>/<dir>/transcript-path.txt\` | Sidecar pointing back to the raw adapter transcript. |

### Branch A: quote is from user or assistant text

Search raw transcripts for the most distinctive substring. Each hit gives a transcript path and line number. For Claude transcripts, inspect the JSONL line and extract \`uuid\` and \`sessionId\` if present. For Codex transcripts, use file path and nearby ordering. Map the transcript path back to an agent-framework session by searching \`transcript-path.txt\` sidecars. Then inspect nearby captures, tool logs, and transcript ordering to choose the hook fire.

### Branch B: quote is from a hook decision or reason string

Search \`tool-log.jsonl\` for gate names, deny reasons, block messages, and hook text. Parse \`toolUseId\`, then cross-reference \`captures.jsonl\` \`tool_use_id\` in the same session to get the matching capture \`seq\`. If the quote is only a decision string or hook event name, search \`captures.jsonl\` directly. If it is injected context, search \`session-injections.jsonl\` and cross-reference injection \`seq\` with capture \`injection_seqs\`.

### Branch C: quote is a tool name plus input fragment

Search raw transcripts because tool inputs live in transcript tool_use/function-call blocks. Then proceed like Branch A.

### Branch D: exact quote has no hits

The session may be too old and rotated out of the capture cap, while raw adapter transcripts may still exist. Search the adapter transcript directories directly. If the transcript is gone too, the quote cannot be resolved; tell the user.

### Picking the right capture

Pick the capture matching the user's intent. For a denied decision, use a \`PreToolUse\` capture with \`decision === "deny"\` and matching tool/input. For hook output, match the lifecycle event. For before/after text, use transcript ordering plus nearby \`UserPromptSubmit\` or \`Stop\` captures. For a whole turn, use all captures between two consecutive \`UserPromptSubmit\` captures.

### Notes for the assistant

- Ask the user for the most distinctive substring when the quote is too broad.
- If search returns many hits, ask the user to narrow by date, project, or rough decision.
- Read compact \`captures.jsonl\` before materializing.
- \`scenario_tester\` \`list_scenarios\` only lists stored fixtures; it does not walk live captures.`;
}

export async function runLocateScenarioMcp(
  input: LocateScenarioInput,
  options: CancellationOptions = {},
): Promise<string> {
  if (input.transcriptPath) {
    setTranscriptPath(input.transcriptPath);
  }

  const workingDir = input.workingDir || process.cwd();
  const quotes = input.quotes.map((q) => q.trim()).filter(Boolean);
  if (quotes.length === 0) {
    return "ERROR: locate_scenario requires at least one non-empty quote.";
  }

  logAgentStarted("locate-scenario", getHookName());
  const search = await locateScenarioCandidates(quotes, options);
  if (search.candidates.length === 0) {
    return locateScenarioFailureOutput(search.commands);
  }

  const result = await runAgent(
    { ...LOCATE_SUMMARIZER, workingDir },
    {
      prompt: "Summarize these locate_scenario MCP findings:",
      context: `QUOTES:\n${quotes.map((q) => `- ${JSON.stringify(q)}`).join("\n")}

FINDINGS:
${formatCandidates(search.candidates)}

TOTAL_CANDIDATES: ${search.candidates.length}`,
    },
    options,
  );

  logAgentResult(result, {
    agent: "locate-scenario",
    hookName: getHookName(),
    toolName: getHookName(),
    workingDir,
    executionType: EXECUTION_TYPES.LLM,
    decisionOverride: "CONFIRM",
    decisionReason: `Located ${search.candidates.length} candidate scenario capture(s)`,
    extraData: { candidates: search.candidates.length },
  });

  return `${result.output}

${successInstructions()}`;
}
