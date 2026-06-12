import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findUnlabeledTranscripts,
  resolveScenarioTranscriptPath,
} from "../../src/agents/mcp/scenario-mcp-shared.js";

const ORIG_HOME = process.env.HOME;
const ORIG_ADAPTER = process.env.AGENT_FRAMEWORK_ADAPTER;
const ORIG_PROJECT_DIR = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
let tmpHome: string;

function writeCodexTranscript(
  name: string,
  content: string = "{}\n",
  cwd: string = process.cwd(),
  dateParts: string[] = ["2026", "06", "12"],
): string {
  const dir = path.join(tmpHome, ".codex", "sessions", ...dateParts);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(filePath, JSON.stringify({
    type: "session_meta",
    payload: { cwd },
  }) + "\n" + content);
  return filePath;
}

describe("codex transcript paths", () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-transcripts-"));
    process.env.HOME = tmpHome;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
  });

  afterEach(() => {
    process.env.HOME = ORIG_HOME;
    if (ORIG_ADAPTER === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = ORIG_ADAPTER;
    if (ORIG_PROJECT_DIR === undefined) delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    else process.env.AGENT_FRAMEWORK_PROJECT_DIR = ORIG_PROJECT_DIR;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("resolves named transcripts from nested rollout storage", () => {
    const transcriptPath = writeCodexTranscript("rollout-test-session");

    expect(resolveScenarioTranscriptPath(
      "rollout-test-session",
      undefined,
      { prefer: "project" },
    )).toBe(transcriptPath);
  });

  it("discovers unlabeled transcripts recursively", () => {
    const transcriptPath = writeCodexTranscript("rollout-find-work", "{}\n{}\n");

    expect(findUnlabeledTranscripts()).toEqual([
      {
        name: "rollout-find-work",
        path: transcriptPath,
        lines: 3,
        sizeBytes: fs.statSync(transcriptPath).size,
      },
    ]);
  });

  it("uses AGENT_FRAMEWORK_PROJECT_DIR when it differs from process cwd", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-project-"));
    process.env.AGENT_FRAMEWORK_PROJECT_DIR = projectDir;
    const matchingPath = writeCodexTranscript("rollout-env-project", "{}\n{}\n", projectDir);
    writeCodexTranscript("rollout-other-project", "{}\n", process.cwd());

    expect(resolveScenarioTranscriptPath(
      "rollout-env-project",
      undefined,
      { prefer: "project" },
    )).toBe(matchingPath);
    expect(findUnlabeledTranscripts()).toEqual([
      {
        name: "rollout-env-project",
        path: matchingPath,
        lines: 3,
        sizeBytes: fs.statSync(matchingPath).size,
      },
    ]);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("honors run preference before duplicate project transcript names", () => {
    writeCodexTranscript("rollout-duplicate", "{}\n", process.cwd(), ["2026", "06", "12"]);
    writeCodexTranscript("rollout-duplicate", "{}\n", process.cwd(), ["2026", "06", "13"]);
    const runDir = path.join(tmpHome, ".agent-framework", "test-runs", "rollout-duplicate");
    fs.mkdirSync(runDir, { recursive: true });
    const runPath = path.join(runDir, "transcript.jsonl");
    fs.writeFileSync(runPath, "{}\n");

    expect(resolveScenarioTranscriptPath(
      "rollout-duplicate",
      undefined,
      { prefer: "run" },
    )).toBe(runPath);
  });

  it("honors project preference before session sidecars for session-shaped names", () => {
    const transcriptName = "2026-06-12-1234_abcd1234";
    const projectPath = writeCodexTranscript(transcriptName);
    const livePath = path.join(tmpHome, "live-transcript.jsonl");
    fs.writeFileSync(livePath, "{}\n");
    const sidecarDir = path.join(
      tmpHome,
      ".agent-framework",
      "sessions",
      "project-key",
      transcriptName,
    );
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(path.join(sidecarDir, "transcript-path.txt"), livePath);

    expect(resolveScenarioTranscriptPath(
      transcriptName,
      undefined,
      { prefer: "project" },
    )).toBe(projectPath);
  });
});
