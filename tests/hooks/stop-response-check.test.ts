import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import { withEnvironmentForTest } from "../helpers/environment.js";
import {
  getAgentFrameworkSessionDir,
  sessionPlanFile,
  testRunsRoot,
} from "../../src/utils/paths.js";

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
import { readTranscriptExact } from "../../src/utils/transcript.js";
import { FIRST_RESPONSE_STOP_COUNTS } from "../../src/utils/transcript-presets.js";
import { validPlanFixture } from "../helpers/plan-fixtures.js";
import { canonicalHookState } from "../helpers/canonical-hook-state.js";

const mockExitAfterFlush = vi.mocked(exitAfterFlush);
const mockValidatePlanFileWithContract = vi.mocked(validatePlanFileWithContract);

function validPlan(planPath: string, planName = "test-plan", marker = "primary"): string {
  return validPlanFixture({
    planPath,
    planName,
    userGoal: `> "Create a restored Codex Stop validation plan."`,
    answeredAssumptions: "1. The session directory is available. Answer: yes. Source: hook input.",
    dataFlow: `Stop response\n  |\n  v\nExtract proposed plan\n  |\n  v\nCompare with ${marker} planfile`,
    sectionBody: (heading) =>
      `Update \`src/${marker}.ts\` and \`tests/${marker}.test.ts\` with concrete ${heading} details.`,
  });
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

function appendCompletedPlan(transcriptPath: string, text: string): void {
  fs.appendFileSync(
    transcriptPath,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "Plan",
          text,
        },
      },
    }) + "\n",
  );
}

function appendFinalAssistantProposedPlan(transcriptPath: string, planText: string): void {
  fs.appendFileSync(
    transcriptPath,
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: proposedPlan(planText) }],
        phase: "final_answer",
      },
    }) + "\n",
  );
}

function appendCodexToolRoundTripAndFinalAssistantPlan(
  transcriptPath: string,
  planText: string,
): void {
  const entries = [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "plan the fix" }],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I will inspect the implementation first.",
        phase: "commentary",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call_inspect",
        name: "exec_command",
        arguments: "{}",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_inspect",
        output: "inspection complete",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: proposedPlan(planText) }],
        phase: "final_answer",
      },
    },
  ];
  fs.appendFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
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
  let restoreEnvironment: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdirSync(testRunsRoot(), { recursive: true });
    tempDir = fs.mkdtempSync(path.join(testRunsRoot(), "stop-plan-test-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
    restoreEnvironment = withEnvironmentForTest({
      AGENT_FRAMEWORK_ADAPTER: "codex",
      AGENT_FRAMEWORK_SCENARIO_ROOT: path.join(tempDir, "scenario-runtime"),
    });
    mockValidatePlanFileWithContract.mockImplementation(async (input) => {
      const content = fs.readFileSync(input.planFile, "utf-8");
      return {
        status: "PASS",
        reasons: [],
        resolvedPath: input.planFile,
        content,
      };
    });
  });

  afterEach(() => {
    for (const dirPath of new Set([sessionDir, tempDir])) {
      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
    restoreEnvironment();
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
    expect(output).toContain("Cannot exit plan mode without a planfile path");
    expect(output).toContain("Session planfiles directory:");
    expect(output).toContain(existingPath);
    expect(output).toContain("Existing session planfiles accepted for this session");
    expect(output).toContain("mcp__agent_framework__validate_plan");
    expect(output).toContain("mcp__agent_framework__create_planfile");
  });

  it("creates a first inline planfile for unnamed proposed plans, validates it, and blocks with the created path", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "user-goal");
    mockValidatePlanFileWithContract.mockResolvedValueOnce({
      status: "FAIL",
      reasons: ["First non-empty line must be `Plan Name: <name>` using lowercase kebab-case."],
      resolvedPath: planPath,
      content: "",
      contentHash: "hash",
    });

    await runStop(transcriptPath, tempDir, "## User Goal\nToo small.");

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(fs.existsSync(planPath)).toBe(true);
    expect(fs.readFileSync(planPath, "utf-8")).toContain(`Planfile Path: ${planPath}`);
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Plan validation failed:");
    expect(output).toContain("Cannot exit plan mode without a planfile path");
    expect(output).toContain(`Existing session planfiles accepted for this session: ${planPath}`);
    expect(output).not.toContain("Existing session planfiles accepted for this session: (none)");
    expect(output).toContain(`A planfile was created for you at ${planPath}`);
    expect(output).toContain("Validation resulted in the following error:");
    expect(output).toContain("First non-empty line must be `Plan Name: <name>` using lowercase kebab-case.");
  });

  it("uses inline-plan as the first inline planfile fallback name when no heading is present", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "inline-plan");
    mockValidatePlanFileWithContract.mockResolvedValueOnce({
      status: "FAIL",
      reasons: ["Missing required plan sections."],
      resolvedPath: planPath,
      content: "",
      contentHash: "hash",
    });

    await runStop(transcriptPath, tempDir, "Summary\n\nImplement this plan.");

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(fs.existsSync(planPath)).toBe(true);
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain(`A planfile was created for you at ${planPath}`);
    expect(output).toContain("Missing required plan sections.");
  });

  it("reports validation pass accurately when a first inline planfile validates but the presentation lacked a path", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "user-goal");

    await runStop(transcriptPath, tempDir, "## User Goal\nToo small.");

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain(`A planfile was created for you at ${planPath}`);
    expect(output).toContain("Validation resulted in the following status: Validation passed.");
    expect(output).not.toContain("Validation resulted in the following error: Plan validation failed.");
  });

  it("routes whole-message markdown plan approval through plan validation", async () => {
    seedPlanMode(transcriptPath);
    const existingPath = sessionPlanFile(sessionDir, "existing-plan");
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, validPlan(existingPath, "existing-plan"));

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message:
          "# Remove Standalone Config Route\n\n" +
          "## Summary\n\n" +
          "Remove the standalone route.\n\n" +
          "## Key Changes\n\n" +
          "- Delete the route file.\n\n" +
          "Implement this plan?",
      },
      codexEncoder,
    );

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Plan validation failed:");
    expect(output).toContain("Cannot exit plan mode without a planfile path");
  });

  it("validates transcript completed Plan text when last_assistant_message is stripped", async () => {
    seedPlanMode(transcriptPath);
    const existingPath = sessionPlanFile(sessionDir, "existing-plan");
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, validPlan(existingPath, "existing-plan"));
    appendCompletedPlan(transcriptPath, "## User Goal\nToo small.");

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "## User Goal\nToo small.",
      },
      codexEncoder,
    );

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Plan validation failed:");
    expect(output).toContain("Cannot exit plan mode without a planfile path");
  });

  it("validates transcript response_item proposed plan after Codex tool output when Stop input is stripped", async () => {
    seedPlanMode(transcriptPath);
    const existingPath = sessionPlanFile(sessionDir, "existing-plan");
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, validPlan(existingPath, "existing-plan"));
    appendCodexToolRoundTripAndFinalAssistantPlan(transcriptPath, "## User Goal\nToo small.");

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "",
      },
      codexEncoder,
    );

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Plan validation failed:");
    expect(output).toContain("Cannot exit plan mode without a planfile path");
    expect(output).not.toContain("response-align-stop");
    expect(fs.readFileSync(transcriptPath, "utf-8")).not.toContain("plan-validate");
  });

  it("creates a missing planfile, records validation and canonical current-plan state, and allows silently on pass", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);

    await runStop(transcriptPath, tempDir, plan);

    expect(fs.readFileSync(planPath, "utf-8").trim()).toBe(plan);
    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    const snapshot = await canonicalHookState({
      adapter: "codex",
      nativeSessionId: "session-stop",
      transcriptPath,
      projectDir: tempDir,
    }).snapshot();
    expect(snapshot.stateSlices["plan.current"]?.value).toEqual({
      kind: "file",
      path: planPath,
      planName: "test-plan",
    });
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("creates a clean first planfile when grouped Codex transcript text has duplicated proposed_plan boundaries", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const completedPlan = validPlan(planPath, "test-plan", "completed");
    const finalPlan = validPlan(planPath, "test-plan", "final");
    appendCompletedPlan(transcriptPath, completedPlan);
    appendFinalAssistantProposedPlan(transcriptPath, finalPlan);

    const grouped = await readTranscriptExact(transcriptPath, FIRST_RESPONSE_STOP_COUNTS);
    expect(grouped.assistant[0]?.content).toContain("</proposed_plan> <proposed_plan>");

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "",
      },
      codexEncoder,
    );

    const created = fs.readFileSync(planPath, "utf-8");
    expect(created.match(/^Plan Name: test-plan$/gm)).toHaveLength(2);
    expect(created.match(/^## User Goal$/gm)).toHaveLength(1);
    expect(created.match(/^Planfile Path: /gm)).toHaveLength(1);
    expect(created).toContain("src/final.ts");
    expect(created).not.toContain("src/completed.ts");
    expect(created).not.toContain("<proposed_plan>");
    expect(created).not.toContain("</proposed_plan>");
    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
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
    expect(output).toContain("Missing concrete file path.");
    expect(fs.existsSync(planPath)).toBe(true);
  });

  it("populates existing empty planfiles from extracted content and validates them", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "  \n");

    await runStop(transcriptPath, tempDir, plan);

    expect(fs.readFileSync(planPath, "utf-8").trim()).toBe(plan);
    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("leaves written plan content in existing empty planfiles when automatic validation fails", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "  \n");
    mockValidatePlanFileWithContract.mockResolvedValueOnce({
      status: "FAIL",
      reasons: ["Missing concrete file path."],
      resolvedPath: planPath,
      content: "",
      contentHash: "hash",
    });

    await runStop(transcriptPath, tempDir, plan);

    expect(fs.readFileSync(planPath, "utf-8").trim()).toBe(plan);
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Missing concrete file path.");
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
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("unreadable");
    expect(output).toContain("Iterate on the planfile using");
    expect(output).toContain("mcp__agent_framework__validate_plan");
    expect(output).toContain(planPath);
  });

  it("does not use extracted footer path mismatches when the located planfile can be populated", async () => {
    seedPlanMode(transcriptPath);
    const wrongPath = path.join(sessionDir, "plans", "wrong.md");

    await runStop(transcriptPath, tempDir, validPlan(wrongPath));

    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("validates populated located planfiles without overwriting them when extracted text differs", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const presentedPlan = validPlan(planPath, "test-plan", "presented");
    const filePlan = validPlan(planPath, "test-plan", "file");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, filePlan);

    await runStop(transcriptPath, tempDir, presentedPlan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(fs.readFileSync(planPath, "utf-8")).toBe(filePlan);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("blocks populated located planfiles when the extracted plan name does not match", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, validPlan(planPath, "old-plan", "file"));

    await runStop(transcriptPath, tempDir, validPlan(planPath, "test-plan", "presented"));

    expect(mockValidatePlanFileWithContract).not.toHaveBeenCalled();
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("old-plan");
    expect(output).toContain("test-plan");
    expect(output).toContain("validate_plan");
  });

  it("validates the file content when inline presentation has large material differences", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const presentedPlan = validPlan(planPath, "test-plan", "presented".repeat(200));
    const filePlan = validPlan(planPath, "test-plan", "file".repeat(200));
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, filePlan);

    await runStop(transcriptPath, tempDir, presentedPlan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(fs.readFileSync(planPath, "utf-8")).toBe(filePlan);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("leaves an existing populated planfile unchanged when file validation fails", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const originalPlan = validPlan(planPath, "test-plan", "original");
    const rejectedPlan = validPlan(planPath, "test-plan", "rejected");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, originalPlan);
    mockValidatePlanFileWithContract.mockResolvedValueOnce({
      status: "FAIL",
      reasons: ["Missing concrete file path."],
      resolvedPath: planPath,
      content: rejectedPlan,
      contentHash: "hash",
    });

    await runStop(transcriptPath, tempDir, rejectedPlan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(fs.readFileSync(planPath, "utf-8")).toBe(originalPlan);
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Plan validation failed:");
    expect(output).toContain("Missing concrete file path.");
    expect(output).toContain("Iterate on the planfile using");
    expect(output).toContain("mcp__agent_framework__validate_plan");
    expect(output).toContain(planPath);
  });

  it("revalidates an existing populated planfile", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, plan);
    await runStop(transcriptPath, tempDir, plan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("validates populated planfiles even when an older exact status recorded fail", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, plan);
    await runStop(transcriptPath, tempDir, plan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("validates populated planfiles when no exact status is recorded", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const plan = validPlan(planPath);
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, plan);

    await runStop(transcriptPath, tempDir, plan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("blocks generic Test Plan headings by routing Stop plans through validate_plan", async () => {
    seedPlanMode(transcriptPath);
    const planPath = sessionPlanFile(sessionDir, "test-plan");
    const invalidPlan = validPlan(planPath).replace("## Assistant Verification", "## Test Plan");
    mockValidatePlanFileWithContract.mockResolvedValueOnce({
      status: "FAIL",
      reasons: ["generic verification: \"## Test Plan\""],
      resolvedPath: planPath,
      content: invalidPlan,
      contentHash: "hash",
    });

    await runStop(transcriptPath, tempDir, invalidPlan);

    expect(mockValidatePlanFileWithContract).toHaveBeenCalledOnce();
    const output = mockExitAfterFlush.mock.calls.at(-1)?.[1] ?? "";
    expect(output).toContain("Plan validation failed:");
    expect(output).toContain("generic verification");
    expect(output).toContain("## Test Plan");
    expect(fs.readFileSync(planPath, "utf-8")).toContain("## Test Plan");
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
