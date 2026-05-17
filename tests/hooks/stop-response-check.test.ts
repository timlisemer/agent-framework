import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import {
  sessionCurrentPlanFile,
  sessionPlanFile,
  sessionPlanValidationStatusFile,
} from "../../src/utils/paths.js";
import {
  hashPlanContent,
  recordPlanValidationStatus,
} from "../../src/utils/plan-validation-status.js";

vi.mock("../../src/utils/hook-bootstrap.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/hook-bootstrap.js")>(
    "../../src/utils/hook-bootstrap.js",
  );
  return {
    ...actual,
    exitAfterFlush: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/agents/mcp/validate-plan.js", () => ({
  validatePlanFileWithContract: vi.fn(),
}));

import { mainStop } from "../../src/hooks/stop-response-check.js";
import { exitAfterFlush } from "../../src/utils/hook-bootstrap.js";
import { validatePlanFileWithContract } from "../../src/agents/mcp/validate-plan.js";

const mockExitAfterFlush = vi.mocked(exitAfterFlush);
const mockValidatePlanFileWithContract = vi.mocked(validatePlanFileWithContract);

const requiredHeadings = [
  "User Goal",
  "Answered Assumptions",
  "Goal In My Words",
  "Approach",
  "Data Flow",
  "Files To Create",
  "Files To Modify",
  "Implementation Order",
  "Assistant Verification",
  "Manual User Verification",
  "Approaches Decided Against",
  "Possible Future Followups",
  "Relevant Files",
  "Files That Need Changes",
];

function validPlan(planPath: string, planName = "test-plan", marker = "primary"): string {
  const body = requiredHeadings.map((heading) => {
    if (heading === "User Goal") return `## ${heading}\n\n> "Create a restored Codex Stop validation plan."`;
    if (heading === "Answered Assumptions") {
      return `## ${heading}\n\n1. The session directory is available. Answer: yes. Source: hook input.`;
    }
    if (heading === "Data Flow") {
      return `## ${heading}\n\nStop response\n  |\n  v\nExtract proposed plan\n  |\n  v\nCompare with ${marker} planfile`;
    }
    if (heading === "Assistant Verification") {
      return `## ${heading}\n\nRun \`mcp__agent_framework__check\` with \`working_dir\` set to \`/repo\`.`;
    }
    if (heading === "Manual User Verification") {
      return `## ${heading}\n\nNo manual user verification is required.`;
    }
    return `## ${heading}\n\nUpdate \`src/${marker}.ts\` and \`tests/${marker}.test.ts\` with concrete ${heading} details.`;
  }).join("\n\n");
  return `Plan Name: ${planName}\n\n${body}\n\nPlanfile Path: ${planPath}\nPlan Name: ${planName}`;
}

function proposedPlan(content: string): string {
  return `<proposed_plan>\n${content}\n</proposed_plan>`;
}

function seedPlanMode(transcriptPath: string): void {
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({ type: "event_msg", payload: { collaboration_mode_kind: "plan" } }) + "\n",
  );
}

async function runStop(transcriptPath: string, cwd: string, content: string): Promise<void> {
  await mainStop(
    {
      session_id: "session-stop",
      transcript_path: transcriptPath,
      cwd,
      last_assistant_message: proposedPlan(content),
    },
    codexEncoder,
  );
}

describe("mainStop Codex proposed-plan presentation validation", () => {
  let tempDir: string;
  let transcriptPath: string;
  let sessionDir: string;
  let prevSessionDir: string | undefined;
  let prevAdapter: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-plan-test-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    sessionDir = path.join(tempDir, "session");
    prevSessionDir = process.env.AGENT_FRAMEWORK_SESSION_DIR;
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_SESSION_DIR = sessionDir;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    mockValidatePlanFileWithContract.mockImplementation(async (input) => {
      const content = fs.readFileSync(input.planFile, "utf-8");
      const contentHash = hashPlanContent(content);
      if (input.sessionDir) {
        recordPlanValidationStatus({
          sessionDir: input.sessionDir,
          planPath: input.planFile,
          contentHash,
          status: "pass",
          reasons: [],
        });
      }
      return {
        status: "PASS",
        reasons: [],
        resolvedPath: input.planFile,
        content,
        contentHash,
      };
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevSessionDir === undefined) delete process.env.AGENT_FRAMEWORK_SESSION_DIR;
    else process.env.AGENT_FRAMEWORK_SESSION_DIR = prevSessionDir;
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
  });

  it("detects whole-message proposed_plan Stop text while in plan mode", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);

    await runStop(transcriptPath, tempDir, plan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("blocks structurally invalid extracted proposed plans with no valid Plan Name and no fallback lookup", async () => {
    seedPlanMode(transcriptPath);
    const existingPath = sessionPlanFile(sessionDir, "existing-plan");
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, validPlan(existingPath, "existing-plan"));

    await runStop(transcriptPath, tempDir, "## User Goal\nToo small.");

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Plan validation failed:");
    expect(output).toContain("Extracted proposed plan is structurally invalid");
    expect(output).not.toContain(existingPath);
  });

  it("creates a missing planfile, runs shared validation, records status, writes current-plan, and allows silently on pass", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);

    await runStop(transcriptPath, tempDir, plan);

    expect(fs.readFileSync(planPath, "utf-8").trim()).toBe(plan);
    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(fs.existsSync(sessionPlanValidationStatusFile(sessionDir))).toBe(true);
    expect(JSON.parse(fs.readFileSync(sessionCurrentPlanFile(sessionDir), "utf-8"))).toEqual({
      kind: "file",
      path: planPath,
      planName: "test-plan",
    });
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("blocks when automatic validation fails after creating a missing planfile", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    mockValidatePlanFileWithContract.mockResolvedValueOnce({
      status: "FAIL",
      reasons: ["Missing concrete file path."],
      resolvedPath: planPath,
      content: "",
      contentHash: "hash",
    });

    await runStop(transcriptPath, tempDir, validPlan(planPath));

    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Plan validation failed:");
    expect(output).toContain("mcp__agent_framework__validate_plan");
  });

  it("blocks existing empty planfiles without overwriting them", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "  \n");

    await runStop(transcriptPath, tempDir, validPlan(planPath));

    expect(fs.readFileSync(planPath, "utf-8")).toBe("  \n");
    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    expect(mockExitAfterFlush.mock.calls.at(-1)?.[1]).toContain("empty");
  });

  it("blocks existing unreadable planfiles without overwriting them", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "secret");
    fs.chmodSync(planPath, 0o000);
    try {
      await runStop(transcriptPath, tempDir, validPlan(planPath));
    } finally {
      fs.chmodSync(planPath, 0o600);
    }

    expect(fs.readFileSync(planPath, "utf-8")).toBe("secret");
    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    expect(mockExitAfterFlush.mock.calls.at(-1)?.[1]).toContain("unreadable");
  });

  it("blocks footer path mismatches", async () => {
    seedPlanMode(transcriptPath);
    const wrongPath = path.join(sessionDir, "plans", "wrong.md");

    await runStop(transcriptPath, tempDir, validPlan(wrongPath));

    expect(mockExitAfterFlush.mock.calls.at(-1)?.[1]).toContain("Plan validation failed:");
    expect(mockExitAfterFlush.mock.calls.at(-1)?.[1]).toContain("must match the resolved current planfile path");
  });

  it("blocks material extracted/file differences and includes small raw diff output", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, validPlan(planPath, "test-plan", "file"));

    await runStop(transcriptPath, tempDir, validPlan(planPath, "test-plan", "presented"));

    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Raw diff:");
    expect(output).toContain("extracted:");
  });

  it("blocks large material differences with different-plan workflow wording", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, validPlan(planPath, "test-plan", "file".repeat(200)));

    await runStop(transcriptPath, tempDir, validPlan(planPath, "test-plan", "presented".repeat(200)));

    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("different or heavily changed plan");
    expect(output).toContain("mcp__agent_framework__validate_plan");
  });

  it("allows identical content with recorded pass without invoking validation again", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, plan);
    recordPlanValidationStatus({
      sessionDir,
      planPath,
      contentHash: hashPlanContent(plan),
      status: "pass",
      reasons: [],
    });

    await runStop(transcriptPath, tempDir, plan);

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("blocks identical content with recorded fail", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, plan);
    recordPlanValidationStatus({
      sessionDir,
      planPath,
      contentHash: hashPlanContent(plan),
      status: "fail",
      reasons: ["bad"],
    });

    await runStop(transcriptPath, tempDir, plan);

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    expect(mockExitAfterFlush.mock.calls.at(-1)?.[1]).toContain("previously failed validation");
  });

  it("runs automatic validation and records status when identical content has no exact status", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, plan);

    await runStop(transcriptPath, tempDir, plan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(fs.existsSync(sessionPlanValidationStatusFile(sessionDir))).toBe(true);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("blocks proposed_plan Stop text outside plan mode", async () => {
    const planPath = sessionPlanFile(sessionDir, "test-plan");

    await runStop(transcriptPath, tempDir, validPlan(planPath));

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    expect(mockExitAfterFlush.mock.calls.at(-1)?.[1]).toContain("Proposed plan block emitted outside plan mode.");
  });

  it("ignores proposed_plan text embedded in ordinary Stop prose", async () => {
    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "Use `<proposed_plan>...</proposed_plan>` for final plans.",
      },
      codexEncoder,
    );

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });
});
