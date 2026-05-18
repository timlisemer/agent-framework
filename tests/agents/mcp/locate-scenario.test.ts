import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  locateScenarioCandidates,
  locateScenarioFailureOutput,
  type SearchRoots,
} from "../../../src/agents/mcp/locate-scenario.js";

function mkRoots(): SearchRoots & { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-locate-"));
  const roots = {
    root,
    claudeProjects: path.join(root, ".claude", "projects"),
    codexSessions: path.join(root, ".codex", "sessions"),
    agentSessions: path.join(root, ".agent-framework", "sessions"),
  };
  fs.mkdirSync(roots.claudeProjects, { recursive: true });
  fs.mkdirSync(roots.codexSessions, { recursive: true });
  fs.mkdirSync(roots.agentSessions, { recursive: true });
  return roots;
}

describe("locateScenarioFailureOutput", () => {
  it("tells the user the MCP failed and includes manual fallback guidance", () => {
    const output = locateScenarioFailureOutput(["rg example"]);
    expect(output).toContain("## Locate Scenario Failed");
    expect(output).toContain("The locate_scenario MCP did not find any matches");
    expect(output).toContain("## Manual Fallback Guidance");
    expect(output).toContain("Branch A: quote is from user or assistant text");
    expect(output).toContain("Picking the right capture");
  });
});

describe("locateScenarioCandidates", () => {
  it("maps tool-log quote hits to captures by toolUseId", async () => {
    const roots = mkRoots();
    const sessionDir = path.join(roots.agentSessions, "encoded", "2026-05-18-1200_abcd");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "tool-log.jsonl"),
      JSON.stringify({
        toolUseId: "toolu_123",
        gate: "tool-approve",
        reason: "Denied command: Use Read tool",
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(sessionDir, "captures.jsonl"),
      JSON.stringify({
        seq: 42,
        event: "PreToolUse",
        tool_use_id: "toolu_123",
        decision: "deny",
      }) + "\n",
    );

    const result = await locateScenarioCandidates(["Use Read tool"], {}, roots);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      kind: "tool-log",
      sessionDir,
      captureSeq: 42,
      event: "PreToolUse",
      decision: "deny",
      toolUseId: "toolu_123",
    });
  });

  it("resolves raw transcript hits through transcript-path sidecars", async () => {
    const roots = mkRoots();
    const transcriptPath = path.join(roots.claudeProjects, "encoded", "session.jsonl");
    const sessionDir = path.join(roots.agentSessions, "encoded", "2026-05-18-1300_dcba");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        uuid: "uuid-1",
        sessionId: "session-1",
        message: { role: "assistant", content: "needle quote appears here" },
      }) + "\n",
    );
    fs.writeFileSync(path.join(sessionDir, "transcript-path.txt"), transcriptPath + "\n");

    const result = await locateScenarioCandidates(["needle quote"], {}, roots);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      kind: "transcript",
      sourcePath: transcriptPath,
      sessionDir,
      transcriptUuid: "uuid-1",
      transcriptSessionId: "session-1",
    });
  });
});
