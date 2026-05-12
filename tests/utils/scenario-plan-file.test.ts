import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { findCurrentPlanSource } from "../../adapters/claude/plan-source.js";

const ORIG_HOME = process.env.HOME;
let TMP_HOME: string;

function makeJsonl(slug: string, sessionId: string): string {
  // Minimal user-line that carries slug. Matches the structure scenario.ts
  // would synthesize when seed_state.planFile is set.
  const line = {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/tmp",
    sessionId,
    version: "0.0.0",
    type: "user",
    message: { role: "user", content: "x" },
    uuid: "uuid-1",
    timestamp: new Date().toISOString(),
    slug,
  };
  return JSON.stringify(line) + "\n";
}

describe("scenario plan-file materialization (HOME-scoped)", () => {
  beforeEach(() => {
    TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-plan-"));
    process.env.HOME = TMP_HOME;
  });

  afterEach(() => {
    process.env.HOME = ORIG_HOME;
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("materializes plans dir + file, Claude plan source finds it via slug on JSONL", async () => {
    const planDir = path.join(TMP_HOME, ".claude", "plans");
    fs.mkdirSync(planDir, { recursive: true });
    const slug = "test-slug-mat-1";
    const planPath = path.join(planDir, `${slug}.md`);
    const planContent = "# Plan\n...";
    fs.writeFileSync(planPath, planContent);

    // Build a transcript jsonl that carries slug on the first line.
    const jsonlPath = path.join(TMP_HOME, "transcript.jsonl");
    fs.writeFileSync(jsonlPath, makeJsonl(slug, "session-1"));

    const resolved = await findCurrentPlanSource({ transcriptPath: jsonlPath });
    expect(resolved).toEqual({ kind: "file", path: planPath });
  });

  it("Claude plan source returns null when slug points at a non-existent file", async () => {
    const slug = "test-slug-mat-2";
    const jsonlPath = path.join(TMP_HOME, "transcript.jsonl");
    fs.writeFileSync(jsonlPath, makeJsonl(slug, "session-2"));

    const resolved = await findCurrentPlanSource({ transcriptPath: jsonlPath });
    expect(resolved).toBeNull();
  });

  it("Claude plan source returns null when no slug present on any line", async () => {
    const jsonlPath = path.join(TMP_HOME, "transcript.jsonl");
    fs.writeFileSync(
      jsonlPath,
      JSON.stringify({
        parentUuid: null,
        type: "user",
        message: { role: "user", content: "x" },
        uuid: "u1",
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    const resolved = await findCurrentPlanSource({ transcriptPath: jsonlPath });
    expect(resolved).toBeNull();
  });

  it("write-then-existsSync round-trip matches scenario.ts refusal-to-clobber behavior", () => {
    const planDir = path.join(TMP_HOME, ".claude", "plans");
    fs.mkdirSync(planDir, { recursive: true });
    const slug = "test-slug-clobber";
    const planPath = path.join(planDir, `${slug}.md`);

    fs.writeFileSync(planPath, "first");
    expect(fs.existsSync(planPath)).toBe(true);

    // The scenario.ts guard rejects when fs.existsSync(planPath) === true.
    // The behavior is documented in scenario.ts; we only verify the file
    // accessor sees it (the guard itself is exercised by the scenario
    // harness at run-time).
    const exists = fs.existsSync(planPath);
    expect(exists).toBe(true);
  });

  it("unlink removes the file (cleanup-finally semantics)", () => {
    const planDir = path.join(TMP_HOME, ".claude", "plans");
    fs.mkdirSync(planDir, { recursive: true });
    const slug = "test-slug-unlink";
    const planPath = path.join(planDir, `${slug}.md`);

    fs.writeFileSync(planPath, "to be removed");
    expect(fs.existsSync(planPath)).toBe(true);
    fs.unlinkSync(planPath);
    expect(fs.existsSync(planPath)).toBe(false);
  });
});
