/**
 * Paths — shared agent-framework filesystem conventions.
 *
 * Adapter-neutral runtime, session, scenario, and repository paths live here.
 * Adapter-specific host roots and transcript layouts live under
 * adapters/<name>/paths.ts.
 *
 * @module paths
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as url from "url";
import { hashString } from "./hash-utils.js";
import { resolveHostContext } from "./host-context.js";

// ─── In-memory caches ─────────────────────────────────────────────────────

/**
 * In-memory cache of resolved session directories.
 * Avoids repeated readdirSync calls within the same process lifetime.
 * Keyed by project plus transcript hash.
 */
const sessionDirCache = new Map<string, string>();

export interface AgentFrameworkSessionDirInput {
  transcriptPath?: string;
  projectDir?: string;
  explicitSessionDir?: string;
}

// ─── Roots ────────────────────────────────────────────────────────────────

/**
 * Runtime root: ~/.agent-framework
 */
export function runtimeRoot(): string {
  return path.join(os.homedir(), ".agent-framework");
}

/**
 * Repo root: <repo> via AGENT_FRAMEWORK_ROOT or import.meta.url climb.
 */
export function agentFrameworkRoot(): string {
  const envRoot = process.env.AGENT_FRAMEWORK_ROOT;
  if (envRoot) return envRoot;
  // Climb from src/utils/paths.ts -> src/utils -> src -> repo
  const thisFile = url.fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "..");
}

/**
 * Repo-relative path to fixture scenarios.
 */
export function scenariosRepoRoot(): string {
  return path.join(agentFrameworkRoot(), "scenarios");
}

/**
 * Root directory for a named adapter.
 */
export function adapterRoot(name: string): string {
  return path.join(agentFrameworkRoot(), "adapters", name);
}

/**
 * Active host-agent config root (~/.claude or ~/.codex).
 */
export function hostConfigRoot(): string {
  return resolveHostContext().configRoot;
}

/**
 * Active host-agent plan directory.
 */
export function hostPlansRoot(): string {
  return resolveHostContext().plansRoot;
}

/**
 * Path to the provider config file.
 * Searches cwd first, then ~/.config/agent-framework/config.json.
 */
export function providerConfigPath(): string {
  return path.join(os.homedir(), ".config", "agent-framework", "config.json");
}

// ─── Project-dir encoders (two distinct variants) ─────────────────────────

/**
 * Encode a project root path into a directory-safe name for the agent-framework
 * session tree. Replaces / with - and strips the leading -.
 *
 * Example: /home/user/project -> home-user-project
 */
export function encodeAgentFrameworkProjectDir(absPath?: string): string {
  const projectDir = absPath ?? resolveHostContext().projectDir;
  return projectDir.replace(/\//g, "-").replace(/^-/, "");
}

// ─── Timestamp ────────────────────────────────────────────────────────────

/**
 * Format a creation timestamp for session folder names.
 * @returns Timestamp string in "yyyy-mm-dd-HHmm" format
 */
export function formatTimestamp(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const HH = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${HH}${min}`;
}

// ─── Per-session paths ────────────────────────────────────────────────────

/**
 * Get the agent-framework session directory for hooks, MCP tools, scenarios,
 * replay, and tests.
 *
 * With a transcript path, real sessions are keyed under
 * ~/.agent-framework/sessions/<project>/<timestamp>_<hash>/ and the transcript
 * sidecar is refreshed. Transcript paths inside ~/.agent-framework/test-runs/
 * use their containing cache directory as the session directory.
 *
 * Without a transcript path, the most recent transcript-path.txt sidecar for
 * the project selects the current session. explicitSessionDir is for tests and
 * in-process harness code that already owns an isolated session directory.
 */
export function getAgentFrameworkSessionDir(input: AgentFrameworkSessionDirInput = {}): string {
  if (input.explicitSessionDir) {
    fs.mkdirSync(input.explicitSessionDir, { recursive: true });
    if (input.transcriptPath) writeSidecarIfNeeded(input.explicitSessionDir, input.transcriptPath);
    return input.explicitSessionDir;
  }

  if (!input.transcriptPath) return resolveCurrentSessionDirFromSidecar(input.projectDir);

  const testRunDir = testRunSessionDirForTranscript(input.transcriptPath);
  if (testRunDir) {
    fs.mkdirSync(testRunDir, { recursive: true });
    writeSidecarIfNeeded(testRunDir, input.transcriptPath);
    return testRunDir;
  }

  return sessionDirForTranscript(input.transcriptPath, input.projectDir);
}

function sessionDirForTranscript(transcriptPath: string, projectDir?: string): string {
  const hash = hashString(transcriptPath);
  const projectKey = encodeAgentFrameworkProjectDir(projectDir);
  const cacheKey = `${projectKey}:${hash}`;
  const cached = sessionDirCache.get(cacheKey);
  if (cached) {
    writeSidecarIfNeeded(cached, transcriptPath);
    return cached;
  }

  const parentDir = path.join(runtimeRoot(), "sessions", projectKey);
  fs.mkdirSync(parentDir, { recursive: true });

  const suffix = `_${hash}`;
  let dirPath: string | undefined;
  try {
    const entries = fs.readdirSync(parentDir);
    const existing = entries.find((e) => e.endsWith(suffix));
    if (existing) {
      dirPath = path.join(parentDir, existing);
    }
  } catch {
    // Parent dir just created, no entries yet
  }

  if (!dirPath) {
    dirPath = path.join(parentDir, `${formatTimestamp()}_${hash}`);
    fs.mkdirSync(dirPath, { recursive: true });
  }

  sessionDirCache.set(cacheKey, dirPath);
  writeSidecarIfNeeded(dirPath, transcriptPath);
  return dirPath;
}

function testRunSessionDirForTranscript(transcriptPath: string): string | null {
  const resolved = path.resolve(transcriptPath);
  const root = path.resolve(testRunsRoot());
  if (!(resolved.startsWith(root + path.sep) || resolved === root)) return null;
  return path.dirname(resolved);
}

export function isTestRunSessionDir(sessionDirPath: string): boolean {
  const resolved = path.resolve(sessionDirPath);
  const root = path.resolve(testRunsRoot());
  return resolved.startsWith(root + path.sep) || resolved === root;
}

function resolveCurrentSessionDirFromSidecar(projectDir?: string): string {
  const parentDir = path.join(runtimeRoot(), "sessions", encodeAgentFrameworkProjectDir(projectDir));
  let entries: string[];
  try {
    entries = fs.readdirSync(parentDir);
  } catch {
    throw new Error(`no session directory found at ${parentDir} - has any hook fired yet?`);
  }
  const candidates = entries
    .map((name) => {
      const sessionDirPath = path.join(parentDir, name);
      const sidecar = sessionTranscriptPathSidecar(sessionDirPath);
      try {
        const stat = fs.statSync(sidecar);
        const transcriptPath = fs.readFileSync(sidecar, "utf-8").trim();
        if (!transcriptPath || !fs.existsSync(transcriptPath)) return undefined;
        return { sessionDirPath, mtimeMs: stat.mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((c): c is { sessionDirPath: string; mtimeMs: number } => c !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`no transcript-path.txt sidecar found under ${parentDir}`);
  }
  return candidates[0].sessionDirPath;
}

function writeSidecarIfNeeded(dirPath: string, transcriptPath: string): void {
  try {
    const sidecarPath = sessionTranscriptPathSidecar(dirPath);
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(sidecarPath, "utf-8").trim();
    } catch {
      // file doesn't exist yet
    }
    if (existing === transcriptPath) {
      const now = new Date();
      fs.utimesSync(sidecarPath, now, now);
    } else {
      fs.writeFileSync(sidecarPath, transcriptPath + "\n");
    }
  } catch {
    // best-effort
  }
}

export function sessionStateFile(sessionDir: string): string {
  return path.join(sessionDir, "state.json");
}

export function sessionCurrentPlanFile(sessionDir: string): string {
  return path.join(sessionDir, "current-plan.json");
}

export function sessionPlanValidationStatusFile(sessionDir: string): string {
  return path.join(sessionDir, "plan-validation-status.json");
}

export function sessionPlansDir(sessionDir: string): string {
  return path.join(sessionDir, "plans");
}

export function sessionPlanFile(sessionDir: string, planName: string): string {
  return path.join(sessionPlansDir(sessionDir), `${planName}.md`);
}

export function sessionToolLogFile(sessionDir: string): string {
  return path.join(sessionDir, "tool-log.jsonl");
}

export function sessionPlanModeStateFile(sessionDir: string): string {
  return path.join(sessionDir, "plan-mode-state.json");
}

export function sessionPlanModeEventsFile(sessionDir: string): string {
  return path.join(sessionDir, "plan-mode-events.jsonl");
}

export function sessionInjectionsFile(sessionDir: string): string {
  return path.join(sessionDir, "session-injections.jsonl");
}

export function sessionGateReasoningFile(sessionDir: string): string {
  return path.join(sessionDir, "gate-reasoning.json");
}

export function sessionDenialCacheFile(sessionDir: string): string {
  return path.join(sessionDir, "hook-denials.json");
}

export function sessionStatuslineFile(sessionDir: string): string {
  return path.join(sessionDir, "statusline.json");
}

/**
 * Path to the transcript-path sidecar file inside a session directory.
 */
export function sessionTranscriptPathSidecar(sessionDirPath: string): string {
  return path.join(sessionDirPath, "transcript-path.txt");
}

// ─── Test-runs paths (flat layout) ────────────────────────────────────────

export function testRunsRoot(): string {
  return path.join(runtimeRoot(), "test-runs");
}

export function transcriptRunDir(name: string): string {
  return path.join(testRunsRoot(), name);
}

export function testRunFile(name: string, filename: string): string {
  return path.join(transcriptRunDir(name), filename);
}

export function transcriptCopyFile(name: string): string {
  return path.join(transcriptRunDir(name), "transcript.jsonl");
}

export function transcriptLabelFile(name: string): string {
  return path.join(transcriptRunDir(name), "labels.json");
}

export function transcriptDraftLabelFile(name: string): string {
  return path.join(transcriptRunDir(name), "labels.draft.json");
}

export function transcriptReportFile(name: string, single: boolean): string {
  return path.join(transcriptRunDir(name), single ? "report-single.json" : "report.json");
}

export function transcriptNotesFile(name: string): string {
  return path.join(transcriptRunDir(name), "notes_and_questions.md");
}

export function transcriptMcpStateFile(name: string): string {
  return path.join(transcriptRunDir(name), "mcp-state.json");
}

export function transcriptCacheDir(name: string): string {
  return path.join(transcriptRunDir(name), "cache");
}

export function transcriptReplayPidFile(name: string): string {
  return path.join(transcriptCacheDir(name), "replay.pid");
}

// ─── Scenario paths (flat layout) ─────────────────────────────────────────

export function scenariosRoot(): string {
  return path.join(testRunsRoot(), "scenarios");
}

export function scenarioRunDir(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid scenario name (must match [A-Za-z0-9._-]+): ${name}`);
  }
  if (name === "." || name === "..") {
    throw new Error(`invalid scenario name (must not be "." or ".."): ${name}`);
  }
  const root = path.resolve(scenariosRoot());
  const candidate = path.resolve(root, name);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`invalid scenario name (resolved outside scenarios root): ${name}`);
  }
  return candidate;
}

export function scenarioJsonFile(name: string): string {
  return path.join(scenarioRunDir(name), "scenario.json");
}

export function scenarioReportFile(name: string): string {
  return path.join(scenarioRunDir(name), "report-scenario.json");
}

export function scenarioLastRunFile(name: string): string {
  return path.join(scenarioRunDir(name), "last-run.json");
}

export function scenarioCacheDir(name: string): string {
  return path.join(scenarioRunDir(name), "cache");
}

export function scenarioPlansDir(name: string): string {
  return path.join(scenarioRunDir(name), "plans");
}

// ─── Repo-relative + safety ────────────────────────────────────────────────

export function distAdapterHookScript(name: string, adapter: string = "claude"): string {
  return path.join(agentFrameworkRoot(), "dist", "adapters", adapter, "hooks", `${name}.js`);
}

/** @deprecated Use distAdapterHookScript instead */
export function distHookScript(name: string): string {
  return distAdapterHookScript(name);
}

export function sessionCapturesFile(dir: string): string {
  return path.join(dir, "captures.jsonl");
}

export function sessionStateSnapshotsFile(dir: string): string {
  return path.join(dir, "state-snapshots.jsonl");
}

export function sessionEpochsFile(dir: string): string {
  return path.join(dir, "epochs.jsonl");
}

export function packageJsonPath(): string {
  return path.join(agentFrameworkRoot(), "package.json");
}

/**
 * Throw if p is not under runtimeRoot().
 */
export function assertWithinRuntimeRoot(p: string): void {
  const resolved = path.resolve(p);
  const root = runtimeRoot();
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path escapes runtime root: ${p}`);
  }
}
