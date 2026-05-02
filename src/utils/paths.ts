/**
 * Paths — sole owner of every disk path in the agent-framework.
 *
 * No os.homedir() call survives outside this file.
 * All other modules import path helpers from here.
 *
 * @module paths
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as url from "url";
import { hashString } from "./hash-utils.js";

// ─── In-memory caches ─────────────────────────────────────────────────────

/**
 * In-memory cache of resolved session directories.
 * Avoids repeated readdirSync calls within the same process lifetime.
 * Keyed by transcript hash.
 */
const sessionDirCache = new Map<string, string>();

/**
 * Per-process sidecar-written tracking — each dirPath written at most once.
 */
const sidecarWrittenForDir = new Set<string>();

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
 * The dotclaude directory for the Claude adapter.
 */
export function adapterDotclaudeDir(name: string): string {
  return path.join(agentFrameworkRoot(), "adapters", name, "dotclaude");
}

/**
 * ~/.claude directory.
 */
export function claudeRoot(): string {
  return path.join(os.homedir(), ".claude");
}

/**
 * ~/.claude/projects directory.
 */
export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * ~/.claude/plans directory.
 */
export function claudePlansRoot(): string {
  return path.join(os.homedir(), ".claude", "plans");
}

/**
 * Return absolute path to a specific plan file by slug.
 * Honors AGENT_FRAMEWORK_PLAN_DIR env var (used by scenario runner to
 * redirect plan files away from the global ~/.claude/plans/).
 */
export function claudePlanFile(slug: string): string {
  const planDir = process.env.AGENT_FRAMEWORK_PLAN_DIR ?? claudePlansRoot();
  return path.join(planDir, `${slug}.md`);
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
  const projectDir = absPath ?? (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  return projectDir.replace(/\//g, "-").replace(/^-/, "");
}

/**
 * Encode a project root path into the format Claude Code uses for its
 * ~/.claude/projects/ directory names. Replaces both / and _ with - and
 * KEEPS the leading -.
 *
 * Example: /home/user/my_project -> -home-user-my-project
 */
export function encodeClaudeProjectDir(absPath?: string): string {
  const projectDir = absPath ?? (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  return projectDir.replace(/[/_]/g, "-");
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
 * Get the session-scoped directory for a transcript.
 *
 * PRESERVES AGENT_FRAMEWORK_SESSION_DIR short-circuit (for synthetic
 * transcript paths in scenario runner that have no live ~/.claude/projects/ file).
 *
 * For real transcripts: folder name is `{yyyy-mm-dd-HHmm}_{hash}` where
 * the timestamp is set once at creation time. Discovery scans the parent
 * dir for an existing folder ending with `_{hash}`.
 *
 * Also writes a transcript-path.txt sidecar on all non-bypass return paths,
 * idempotently (skipped if content already matches, at most once per process
 * per dirPath).
 */
export function sessionDir(transcriptPath: string): string {
  if (process.env.AGENT_FRAMEWORK_SESSION_DIR) {
    fs.mkdirSync(process.env.AGENT_FRAMEWORK_SESSION_DIR, { recursive: true });
    return process.env.AGENT_FRAMEWORK_SESSION_DIR;
  }

  const hash = hashString(transcriptPath);
  const cached = sessionDirCache.get(hash);
  if (cached) {
    writeSidecarIfNeeded(cached, transcriptPath);
    return cached;
  }

  const parentDir = path.join(runtimeRoot(), "sessions", encodeAgentFrameworkProjectDir());
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

  sessionDirCache.set(hash, dirPath);
  writeSidecarIfNeeded(dirPath, transcriptPath);
  return dirPath;
}

function writeSidecarIfNeeded(dirPath: string, transcriptPath: string): void {
  if (sidecarWrittenForDir.has(dirPath)) return;
  sidecarWrittenForDir.add(dirPath);
  try {
    const sidecarPath = sessionTranscriptPathSidecar(dirPath);
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(sidecarPath, "utf-8").trim();
    } catch {
      // file doesn't exist yet
    }
    if (existing !== transcriptPath) {
      fs.writeFileSync(sidecarPath, transcriptPath + "\n");
    }
  } catch {
    // best-effort
  }
}

export function sessionStateFile(sessionDir: string): string {
  return path.join(sessionDir, "state.json");
}

export function sessionToolLogFile(sessionDir: string): string {
  return path.join(sessionDir, "tool-log.jsonl");
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

export function sessionSubagentCounterFile(sessionDir: string): string {
  return path.join(sessionDir, "active-subagents.json");
}

/**
 * Path to the transcript-path sidecar file inside a session directory.
 */
export function sessionTranscriptPathSidecar(sessionDirPath: string): string {
  return path.join(sessionDirPath, "transcript-path.txt");
}

// ─── Test-runs paths (flat layout) ────────────────────────────────────────

function testRunsRoot(): string {
  return path.join(runtimeRoot(), "test-runs");
}

export function transcriptRunDir(name: string): string {
  return path.join(testRunsRoot(), name);
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

function scenariosRoot(): string {
  return path.join(testRunsRoot(), "scenarios");
}

export function scenarioRunDir(name: string): string {
  return path.join(scenariosRoot(), name);
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

// ─── Real Claude Code paths ────────────────────────────────────────────────

/**
 * The ~/.claude/projects/<encoded>/ directory for a given project path.
 */
export function projectTranscriptsDir(absPath?: string): string {
  return path.join(claudeProjectsRoot(), encodeClaudeProjectDir(absPath));
}

/**
 * Absolute path to a specific Claude Code transcript file.
 */
export function projectTranscriptFile(name: string, absPath?: string): string {
  return path.join(projectTranscriptsDir(absPath), `${name}.jsonl`);
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
