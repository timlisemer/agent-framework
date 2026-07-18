import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import {
  locateScenarioCandidates,
  locateScenarioFailureOutput,
  type SearchRoots,
} from "../../../src/agents/mcp/locate-scenario.js";
import { withTemporaryTestRoot } from "../../helpers/temporary-root.js";

function mkRoots(): SearchRoots & { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-locate-"));
  const roots = {
    root,
    agentRuns: path.join(root, ".agent-framework", "runs"),
  };
  fs.mkdirSync(roots.agentRuns, { recursive: true });
  return roots;
}

describe("locateScenarioFailureOutput", () => {
  it("tells the user the MCP failed and includes manual fallback guidance", () => {
    const output = locateScenarioFailureOutput(["rg example"]);
    expect(output).toContain("## Locate Scenario Failed");
    expect(output).toContain("The locate_scenario MCP did not find any matches");
    expect(output).toContain("## Manual Fallback Guidance");
    expect(output).toContain("Branch A: quote is from user or assistant text");
    expect(output).toContain("Picking the right run");
    expect(output).not.toContain("tool-log.jsonl");
  });
});

describe("locateScenarioCandidates", () => {
  it("uses the application Scenario root configured for canonical writers", async () => {
    await withTemporaryTestRoot("agent-framework-locate-configured-", async (root) => {
      vi.stubEnv("AGENT_FRAMEWORK_SCENARIO_ROOT", root);
      try {
        const runDir = path.join(root, "runs", "configured-run");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, "scenario.records.jsonl"), `${JSON.stringify([{
          runId: "configured-run",
          recordSeq: 1,
          eventType: "message.userSubmitted",
          payload: { content: "configured root evidence" },
        }])}\n`);

        const result = await locateScenarioCandidates(["configured root evidence"]);

        expect(result.candidates).toContainEqual(expect.objectContaining({
          runId: "configured-run",
          runtimeRoot: root,
        }));
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("locates canonical run records with their stable cursor and entity", async () => {
    const roots = mkRoots();
    const runDir = path.join(roots.agentRuns, "run-42");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "scenario.records.jsonl"),
      JSON.stringify([{
        runId: "run-42",
        recordSeq: 17,
        eventType: "tool.authorization.finalResolved",
        entityRef: { kind: "toolCall", id: "toolu_123" },
        payload: { reason: "Denied command: Use Read tool" },
      }]) + "\n",
    );

    const result = await locateScenarioCandidates(["Use Read tool"], {}, roots);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      kind: "journal",
      runId: "run-42",
      runtimeRoot: path.join(roots.root, ".agent-framework"),
      recordSeq: 17,
      event: "tool.authorization.finalResolved",
      toolUseId: "toolu_123",
    });
  });

  it("locates quotes beyond previews in digest-verified linked artifacts", async () => {
    const roots = mkRoots();
    const runDir = path.join(roots.agentRuns, "artifact-run");
    const artifactsDir = path.join(runDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const quote = "needle stored beyond the inline preview";
    const bytes = Buffer.from(JSON.stringify({ value: `${"x".repeat(4_096)}${quote}` }), "utf8");
    const artifactId = createHash("sha256").update(bytes).digest("hex");
    const digest = `sha256:${artifactId}`;
    fs.writeFileSync(path.join(artifactsDir, artifactId), bytes);
    fs.writeFileSync(path.join(runDir, "scenario.records.jsonl"), JSON.stringify([
      {
        runId: "artifact-run",
        recordSeq: 1,
        eventType: "artifact.linked",
        payload: { artifact: { artifactId, digest } },
      },
      {
        runId: "artifact-run",
        recordSeq: 2,
        eventType: "tool.requested",
        entityRef: { kind: "toolCall", id: "artifact-tool" },
        payload: { input: { $scenarioArtifactValue: { artifact: { artifactId, digest } } } },
      },
    ]) + "\n");

    const result = await locateScenarioCandidates([quote], {}, roots);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((candidate) => candidate.kind === "artifact")).toBe(true);
    expect(result.candidates).toContainEqual(expect.objectContaining({
      runId: "artifact-run",
      event: "tool.requested",
      toolUseId: "artifact-tool",
      excerpt: expect.stringContaining(quote),
    }));
  });

  it("skips artifacts and journals outside explicit verification limits", async () => {
    const roots = mkRoots();
    const runDir = path.join(roots.agentRuns, "limited-run");
    const artifactsDir = path.join(runDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const quote = "bounded verification needle";
    const bytes = Buffer.from(`${"x".repeat(256)}${quote}`, "utf8");
    const artifactId = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(artifactsDir, artifactId), bytes);
    fs.writeFileSync(path.join(runDir, "scenario.records.jsonl"), `${JSON.stringify([{
      runId: "limited-run",
      recordSeq: 1,
      eventType: "artifact.linked",
      payload: { artifact: { artifactId, digest: `sha256:${artifactId}` } },
    }])}\n`);

    const artifactLimited = await locateScenarioCandidates([quote], {}, roots, {
      maxArtifactBytes: 64,
      maxJournalBytes: 1_024,
      maxTotalVerificationBytes: 2_048,
    });
    expect(artifactLimited.candidates).toEqual([]);
    expect(artifactLimited.diagnostics).toContainEqual(expect.stringContaining("exceeds the 64-byte scan limit"));

    const journalLimited = await locateScenarioCandidates([quote], {}, roots, {
      maxArtifactBytes: 1_024,
      maxJournalBytes: 32,
      maxTotalVerificationBytes: 2_048,
    });
    expect(journalLimited.candidates).toEqual([]);
    expect(journalLimited.diagnostics).toContainEqual(expect.stringContaining("journal"));
    expect(journalLimited.diagnostics).toContainEqual(expect.stringContaining("32-byte limit"));
  });

  it("rejects non-regular journals and propagates cancellation through verification", async () => {
    const roots = mkRoots();
    const runDir = path.join(roots.agentRuns, "unsafe-run");
    const artifactsDir = path.join(runDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const quote = "resource boundary needle";
    const bytes = Buffer.from(quote, "utf8");
    const artifactId = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(artifactsDir, artifactId), bytes);
    const linkedJournal = path.join(roots.root, "linked-journal.jsonl");
    fs.writeFileSync(linkedJournal, `${JSON.stringify([{
      runId: "unsafe-run",
      recordSeq: 1,
      eventType: "artifact.linked",
      payload: { artifact: { artifactId, digest: `sha256:${artifactId}` } },
    }])}\n`);
    fs.symlinkSync(linkedJournal, path.join(runDir, "scenario.records.jsonl"));

    const unsafe = await locateScenarioCandidates([quote], {}, roots);
    expect(unsafe.candidates).toEqual([]);
    expect(unsafe.diagnostics).toContainEqual(expect.stringContaining("not a regular text file"));

    const controller = new AbortController();
    controller.abort();
    await expect(locateScenarioCandidates([quote], { signal: controller.signal }, roots))
      .rejects.toMatchObject({ name: "OperationCancelledError" });
  });

  it("enforces an aggregate verification budget after retaining valid bounded candidates", async () => {
    const roots = mkRoots();
    const quote = "aggregate verification needle";
    const bytes = Buffer.from(quote, "utf8");
    const artifactId = createHash("sha256").update(bytes).digest("hex");
    let journalBytes = 0;
    for (const runId of ["aggregate-a", "aggregate-b"]) {
      const runDir = path.join(roots.agentRuns, runId);
      fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
      fs.writeFileSync(path.join(runDir, "artifacts", artifactId), bytes);
      const journal = `${JSON.stringify([{
        runId,
        recordSeq: 1,
        eventType: "artifact.linked",
        payload: { artifact: { artifactId, digest: `sha256:${artifactId}` } },
      }])}\n`;
      journalBytes = Buffer.byteLength(journal);
      fs.writeFileSync(path.join(runDir, "scenario.records.jsonl"), journal);
    }

    const result = await locateScenarioCandidates([quote], {}, roots, {
      maxArtifactBytes: 1_024,
      maxJournalBytes: 1_024,
      maxTotalVerificationBytes: bytes.length + journalBytes + 1,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.join("\n")).toMatch(/total limit|scan limit/);
  });
});
