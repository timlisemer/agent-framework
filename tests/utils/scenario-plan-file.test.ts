import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getPathToPlanfile } from "../../src/utils/planfile.js";
import { readCurrentPlanContent } from "../../src/utils/plan-source.js";
import { activeSpec } from "../../src/adapter/spec.js";

const ORIG_HOME = process.env.HOME;
const ORIG_ADAPTER = process.env.AGENT_FRAMEWORK_ADAPTER;
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
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
  });

  afterEach(() => {
    process.env.HOME = ORIG_HOME;
    if (ORIG_ADAPTER === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = ORIG_ADAPTER;
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("materializes plans dir + file, generic planfile locator finds it via slug on JSONL", async () => {
    const planDir = path.join(TMP_HOME, ".claude", "plans");
    fs.mkdirSync(planDir, { recursive: true });
    const slug = "test-slug-mat-1";
    const planPath = path.join(planDir, `${slug}.md`);
    const planContent = "# Plan\n...";
    fs.writeFileSync(planPath, planContent);

    // Build a transcript jsonl that carries slug on the first line.
    const jsonlPath = path.join(TMP_HOME, "transcript.jsonl");
    fs.writeFileSync(jsonlPath, makeJsonl(slug, "session-1"));

    const resolved = await getPathToPlanfile(
      { transcriptPath: jsonlPath },
      (lookup) => activeSpec().findNativePlanFile(lookup),
    );
    expect(resolved).toBe(planPath);
    await expect(readCurrentPlanContent({ transcriptPath: jsonlPath })).resolves.toBe(planContent);
  });

  it("generic current-plan content returns null when slug points at a non-existent file", async () => {
    const slug = "test-slug-mat-2";
    const jsonlPath = path.join(TMP_HOME, "transcript.jsonl");
    fs.writeFileSync(jsonlPath, makeJsonl(slug, "session-2"));

    await expect(readCurrentPlanContent({ transcriptPath: jsonlPath })).resolves.toBeNull();
  });

  it("generic planfile locator returns null when no slug present on any line", async () => {
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

    const resolved = await getPathToPlanfile(
      { transcriptPath: jsonlPath },
      (lookup) => activeSpec().findNativePlanFile(lookup),
    );
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
