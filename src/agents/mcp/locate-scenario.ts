import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { resolveAgentFrameworkScenarioRoot } from "../../effects/scenario-root.js";
import { canonicalRunsRoot } from "../../scenario/store/paths.js";
import { EXECUTION_TYPES, MODEL_TIERS } from "../../types.js";
import { activeSpec } from "../../adapter/spec.js";
import { runAgent, type AgentConfig } from "../../utils/agent-runner.js";
import { runProcessCancellable } from "../../utils/command.js";
import { setTranscriptPath } from "../../utils/execution-context.js";
import { logAgentResult } from "../../utils/logger.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";
import {
  readValidatedTextFileCancellable,
  scanValidatedFileCancellable,
} from "../../utils/file-io.js";

type SearchKind = "journal" | "artifact";

export interface LocateScenarioInput {
  quotes: string[];
  workingDir?: string;
  transcriptPath?: string;
}

export interface SearchRoots {
  agentRuns: string;
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
  runId: string;
  runtimeRoot: string;
  recordSeq?: number;
  event?: string;
  toolUseId?: string;
  excerpt: string;
}

interface LocateSearchResult {
  commands: string[];
  candidates: LocateCandidate[];
  diagnostics: string[];
}

export interface LocateScanLimits {
  maxArtifactBytes: number;
  maxJournalBytes: number;
  maxTotalVerificationBytes: number;
}

const MAX_HITS_PER_COMMAND = 30;
const MAX_SUMMARY_CANDIDATES = 20;
const DEFAULT_SCAN_LIMITS: LocateScanLimits = {
  maxArtifactBytes: 8 * 1024 * 1024,
  maxJournalBytes: 16 * 1024 * 1024,
  maxTotalVerificationBytes: 64 * 1024 * 1024,
};

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
- Include run_id and runtime_root for every finding.
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
  return { agentRuns: canonicalRunsRoot(resolveAgentFrameworkScenarioRoot()) };
}

function renderCommand(quote: string, roots: string[], glob?: string): string {
  const parts = ["rg -n --no-heading --color=never -F"];
  if (glob) parts.push(`--glob ${JSON.stringify(glob)}`);
  parts.push(JSON.stringify(quote), ...roots.map((root) => JSON.stringify(root)));
  return parts.join(" ");
}

function parseRgOutput(kind: SearchKind, quote: string, output: string): RgHit[] {
  const hits: RgHit[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    hits.push({
      kind,
      quote,
      path: match[1],
      line: Number(match[2]),
      text: match[3],
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
  const present = roots.filter((root) => fs.existsSync(root));
  const command = renderCommand(quote, present.length > 0 ? present : roots, glob);
  if (present.length === 0) return { command, hits: [] };
  const result = await runProcessCancellable(
    {
      shell: false,
      file: "rg",
      args: [
        "-n",
        "--no-heading",
        "--color=never",
        "-F",
        ...(glob ? ["--glob", glob] : []),
        quote,
        ...present,
      ],
    },
    process.cwd(),
    { ...options, maxStdoutBytes: 512 * 1024, maxStderrBytes: 64 * 1024 },
  );
  if (result.exitCode !== 0 && !result.output.trim()) return { command, hits: [] };
  return {
    command,
    hits: parseRgOutput(kind, quote, result.output).slice(0, MAX_HITS_PER_COMMAND),
  };
}

async function rgArtifactFiles(
  quote: string,
  roots: string[],
  options: CancellationOptions,
): Promise<{ command: string; paths: string[] }> {
  const present = roots.filter((root) => fs.existsSync(root));
  const command = [
    "rg -l --color=never -F --glob",
    JSON.stringify("**/artifacts/*"),
    JSON.stringify(quote),
    ...(present.length > 0 ? present : roots).map((root) => JSON.stringify(root)),
  ].join(" ");
  if (present.length === 0) return { command, paths: [] };
  const result = await runProcessCancellable({
    shell: false,
    file: "rg",
    args: ["-l", "--color=never", "-F", "--glob", "**/artifacts/*", quote, ...present],
  }, process.cwd(), { ...options, maxStdoutBytes: 256 * 1024, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0 && !result.output.trim()) return { command, paths: [] };
  return { command, paths: result.output.split("\n").filter(Boolean).slice(0, MAX_HITS_PER_COMMAND) };
}

function safeJsonBatch(line: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record): record is Record<string, unknown> =>
      record !== null && typeof record === "object" && !Array.isArray(record)
    );
  } catch {
    return [];
  }
}

function candidatesFromHit(hit: RgHit, roots: SearchRoots): LocateCandidate[] {
  const runDir = path.dirname(hit.path);
  return safeJsonBatch(hit.text)
    .filter((record) => JSON.stringify(record).includes(hit.quote))
    .map((record) => {
      const entityRef = record.entityRef && typeof record.entityRef === "object"
        ? record.entityRef as Record<string, unknown>
        : null;
      return {
        quote: hit.quote,
        kind: hit.kind,
        sourcePath: hit.path,
        line: hit.line,
        runId: typeof record.runId === "string" ? record.runId : path.basename(runDir),
        runtimeRoot: path.dirname(roots.agentRuns),
        recordSeq: typeof record.recordSeq === "number" ? record.recordSeq : undefined,
        event: typeof record.eventType === "string" ? record.eventType : undefined,
        toolUseId: entityRef?.kind === "toolCall" && typeof entityRef.id === "string"
          ? entityRef.id
          : undefined,
        excerpt: JSON.stringify(record).slice(0, 500),
      };
    });
}

function candidateKey(candidate: LocateCandidate): string {
  return [
    candidate.quote,
    candidate.sourcePath,
    candidate.line,
    candidate.runId,
    candidate.recordSeq ?? "",
  ].join("\0");
}

async function candidatesFromVerifiedArtifact(
  artifactPath: string,
  quote: string,
  roots: SearchRoots,
  options: CancellationOptions,
  limits: LocateScanLimits,
  budget: { remaining: number },
  diagnostics: string[],
): Promise<LocateCandidate[]> {
  throwIfAborted(options.signal);
  const artifactId = path.basename(artifactPath);
  if (!/^[a-f0-9]{64}$/.test(artifactId)) return [];
  if (budget.remaining <= 0) {
    diagnostics.push(`Skipped artifact verification after reaching the ${limits.maxTotalVerificationBytes}-byte total limit`);
    return [];
  }
  const hasher = createHash("sha256");
  const matcher = streamingQuoteMatcher(quote);
  const artifactLimit = Math.min(limits.maxArtifactBytes, budget.remaining);
  const artifactScan = await scanValidatedFileCancellable(artifactPath, {
    ...options,
    maxBytes: artifactLimit,
    visitChunk: (chunk) => {
      hasher.update(chunk);
      matcher.visit(chunk);
    },
  });
  budget.remaining -= artifactScan.scannedBytes;
  if (artifactScan.kind !== "text") {
    diagnostics.push(`Skipped artifact ${artifactPath}: ${validatedScanReason(artifactScan.kind, artifactLimit)}`);
    return [];
  }
  if (hasher.digest("hex") !== artifactId || !matcher.matched()) return [];
  const runDir = path.dirname(path.dirname(artifactPath));
  const journalPath = path.join(runDir, "scenario.records.jsonl");
  if (budget.remaining <= 0) {
    diagnostics.push(`Skipped journal verification after reaching the ${limits.maxTotalVerificationBytes}-byte total limit`);
    return [];
  }
  const journalLimit = Math.min(limits.maxJournalBytes, budget.remaining);
  const journal = await readValidatedTextFileCancellable(journalPath, { ...options, maxBytes: journalLimit });
  if (journal === null) {
    diagnostics.push(`Skipped journal ${journalPath}: not a regular text file within the ${journalLimit}-byte limit`);
    return [];
  }
  budget.remaining -= Buffer.byteLength(journal, "utf8");
  const digest = `sha256:${artifactId}`;
  const journalLines = journal.split("\n");
  const journalBatches = journalLines.map(safeJsonBatch);
  const linked = journalBatches.some((batch) => batch.some((record) => {
    const payload = record?.payload && typeof record.payload === "object"
      ? record.payload as Record<string, unknown>
      : null;
    const artifact = payload?.artifact && typeof payload.artifact === "object"
      ? payload.artifact as Record<string, unknown>
      : null;
    return record?.eventType === "artifact.linked" &&
      artifact?.artifactId === artifactId && artifact.digest === digest;
  }));
  if (!linked) return [];
  const excerpt = matcher.excerpt();
  const candidates: LocateCandidate[] = [];
  for (const [index, batch] of journalBatches.entries()) {
    for (const record of batch.filter((candidate) => JSON.stringify(candidate).includes(digest))) {
      const entityRef = record.entityRef && typeof record.entityRef === "object"
        ? record.entityRef as Record<string, unknown>
        : null;
      candidates.push({
        quote,
        kind: "artifact",
        sourcePath: journalPath,
        line: index + 1,
        runId: typeof record.runId === "string" ? record.runId : path.basename(runDir),
        runtimeRoot: path.dirname(roots.agentRuns),
        recordSeq: typeof record.recordSeq === "number" ? record.recordSeq : undefined,
        event: typeof record.eventType === "string" ? record.eventType : undefined,
        toolUseId: entityRef?.kind === "toolCall" && typeof entityRef.id === "string"
          ? entityRef.id
          : undefined,
        excerpt,
      });
    }
  }
  return candidates;
}

function streamingQuoteMatcher(quote: string): {
  visit(chunk: Buffer): void;
  matched(): boolean;
  excerpt(): string;
} {
  const needle = Buffer.from(quote, "utf8");
  const overlapBytes = Math.max(needle.length - 1, 120);
  let tail = Buffer.alloc(0);
  let found = false;
  let excerptBytes = Buffer.alloc(0);
  let remainingAfter = 0;
  return {
    visit(chunk) {
      if (found) {
        if (remainingAfter > 0) {
          const append = chunk.subarray(0, remainingAfter);
          excerptBytes = Buffer.concat([excerptBytes, append]);
          remainingAfter -= append.length;
        }
        return;
      }
      const combined = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
      const matchAt = combined.indexOf(needle);
      if (matchAt >= 0) {
        found = true;
        const excerptStart = Math.max(0, matchAt - 120);
        const desiredEnd = matchAt + needle.length + 240;
        excerptBytes = Buffer.from(combined.subarray(excerptStart, Math.min(combined.length, desiredEnd)));
        remainingAfter = Math.max(0, desiredEnd - combined.length);
        return;
      }
      tail = Buffer.from(combined.subarray(Math.max(0, combined.length - overlapBytes)));
    },
    matched: () => found,
    excerpt: () => excerptBytes.toString("utf8"),
  };
}

function validatedScanReason(kind: string, limit: number): string {
  if (kind === "scan-limited") return `exceeds the ${limit}-byte scan limit`;
  if (kind === "non-file") return "path is not a regular file";
  if (kind === "binary") return "content is not text";
  return "file is unreadable";
}

export async function locateScenarioCandidates(
  quotes: string[],
  options: CancellationOptions = {},
  roots: SearchRoots = defaultRoots(),
  scanLimits: Partial<LocateScanLimits> = {},
): Promise<LocateSearchResult> {
  const limits = { ...DEFAULT_SCAN_LIMITS, ...scanLimits };
  const budget = { remaining: limits.maxTotalVerificationBytes };
  const commands: string[] = [];
  const hits: RgHit[] = [];
  const artifactCandidates: LocateCandidate[] = [];
  const diagnostics: string[] = [];
  for (const quote of quotes) {
    throwIfAborted(options.signal);
    const search = await rgSearch(
      "journal",
      quote,
      [roots.agentRuns],
      options,
      "**/scenario.records.jsonl",
    );
    commands.push(search.command);
    hits.push(...search.hits);
    const artifacts = await rgArtifactFiles(quote, [roots.agentRuns], options);
    commands.push(artifacts.command);
    for (const artifactPath of artifacts.paths) {
      throwIfAborted(options.signal);
      artifactCandidates.push(...await candidatesFromVerifiedArtifact(
        artifactPath,
        quote,
        roots,
        options,
        limits,
        budget,
        diagnostics,
      ));
    }
  }

  const seen = new Set<string>();
  const candidates: LocateCandidate[] = [];
  for (const candidate of [
    ...hits.flatMap((hit) => candidatesFromHit(hit, roots)),
    ...artifactCandidates,
  ]) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return { commands, candidates, diagnostics: [...new Set(diagnostics)] };
}

function formatCandidates(candidates: LocateCandidate[]): string {
  return candidates.slice(0, MAX_SUMMARY_CANDIDATES).map((candidate, index) => [
    `candidate=${index + 1}`,
    `quote=${JSON.stringify(candidate.quote)}`,
    `kind=${candidate.kind}`,
    `source=${candidate.sourcePath}:${candidate.line}`,
    `run_id=${candidate.runId}`,
    `runtime_root=${candidate.runtimeRoot}`,
    candidate.recordSeq === undefined ? undefined : `record_seq=${candidate.recordSeq}`,
    candidate.event ? `event=${candidate.event}` : undefined,
    candidate.toolUseId ? `tool_use_id=${candidate.toolUseId}` : undefined,
    `excerpt=${JSON.stringify(candidate.excerpt)}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function successInstructions(): string {
  const materializeMcp = activeSpec().mcpWireName("scenario_tester");
  return `## Required Next Steps
- Notify the user that the locate_scenario MCP found one or more likely canonical runs.
- If the user already requested materialization, call ${materializeMcp} with action "materialize_scenario", using the located run_id and runtime_root.
- If the user did not already request materialization, stop here and ask the user before materializing.`;
}

export function locateScenarioFailureOutput(commands: string[], diagnostics: string[] = []): string {
  return `## Locate Scenario Failed
The locate_scenario MCP did not find any matches with its predefined commands.

## Commands Tried
${commands.map((command) => `- ${command}`).join("\n") || "- (none)"}

## Skipped Inputs
${diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n") || "- (none)"}

## Manual Fallback Guidance

Canonical run data lives under \`~/.agent-framework/runs/<run-id>/\`:

| Path | What's there |
|------|--------------|
| \`scenario.records.jsonl\` | Authoritative canonical commands, decisions, messages, tools, state changes, effects, and feedback. |
| \`manifest.json\` | Run provenance, capabilities, configuration, native session identifiers, and lifecycle metadata. |
| \`scenario.snapshot.json\` | Complete reducer-authored state at the journal cursor. |
| \`artifacts/<sha256>\` | Digest-verified complete values extracted from oversized journal fields. |

### Branch A: quote is from user or assistant text

Search canonical journals for the most distinctive substring. Each hit directly identifies the run, record sequence, event type, and source path.

### Branch B: quote is from a hook decision or reason string

Search canonical journals for gate names, deny reasons, block messages, and hook text. Use \`eventType\`, \`entityRef\`, and \`recordSeq\` to distinguish matches.

### Branch C: quote is a tool name plus input fragment

Search canonical journals and their linked, digest-verified artifacts. Artifact matches map back to the journal records that reference the complete safe tool input. Then proceed like Branch A.

### Branch D: exact quote has no hits

Ask for a more distinctive quote, date, project, or decision detail and search again.

### Picking the right run

Pick the run and record matching the user's intent. For a denied decision, match the tool entity and authorization/rule records. For a whole turn, use the correlated message, tool, rule, and effect records.

### Notes for the assistant

- Ask the user for the most distinctive substring when the quote is too broad.
- If search returns many hits, ask the user to narrow by date, project, or rough decision.
- Materialize with \`scenario_tester materialize_scenario\` using \`run_id\` and \`runtime_root\`.
- \`scenario_tester\` \`list_fixtures\` only lists stored fixtures; it does not walk live runs.`;
}

export async function runLocateScenarioMcp(
  input: LocateScenarioInput,
  options: CancellationOptions = {},
): Promise<string> {
  if (input.transcriptPath) setTranscriptPath(input.transcriptPath);
  const workingDir = input.workingDir || process.cwd();
  const quotes = input.quotes.map((quote) => quote.trim()).filter(Boolean);
  if (quotes.length === 0) return "ERROR: locate_scenario requires at least one non-empty quote.";

  const search = await locateScenarioCandidates(quotes, options);
  if (search.candidates.length === 0) return locateScenarioFailureOutput(search.commands, search.diagnostics);

  const result = await runAgent(
    { ...LOCATE_SUMMARIZER, workingDir },
    {
      prompt: "Summarize these locate_scenario MCP findings:",
      context: `QUOTES:\n${quotes.map((quote) => `- ${JSON.stringify(quote)}`).join("\n")}

FINDINGS:
${formatCandidates(search.candidates)}

TOTAL_CANDIDATES: ${search.candidates.length}${
        search.diagnostics.length === 0 ? "" : `\n\nSKIPPED_INPUTS:\n${search.diagnostics.join("\n")}`
      }`,
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
    decisionReason: `Located ${search.candidates.length} canonical run candidate(s)`,
    extraData: { candidates: search.candidates.length },
  });

  return `${result.output}

${successInstructions()}`;
}
