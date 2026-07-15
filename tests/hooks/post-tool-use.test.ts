import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import { mainPostToolUse } from "../../src/hooks/post-tool-use.js";
import { mainPostToolUseFailure } from "../../src/hooks/post-tool-use-failure.js";
import { getAgentFrameworkSessionDir, sessionCurrentPlanFile, sessionPlanFile } from "../../src/utils/paths.js";
import { getSessionState, readToolLogEntries } from "../../src/utils/session-store.js";
import { decidePrediction } from "../../src/utils/prediction-types.js";

vi.mock("../../src/utils/hook-bootstrap.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/hook-bootstrap.js")>(
    "../../src/utils/hook-bootstrap.js",
  );
  return {
    ...actual,
    exitAfterFlush: vi.fn().mockResolvedValue(undefined),
  };
});

describe("mainPostToolUse planfile sidecar", () => {
  let tempDir: string;
  let transcriptPath: string;
  let sessionDir: string;
  let prevAdapter: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "post-tool-use-plan-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
  });

  it("records the active current-plan sidecar after a successful session planfile write", async () => {
    const planPath = sessionPlanFile(sessionDir, "named-plan");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(
      planPath,
      [
        "Plan Name: named-plan",
        "",
        "## User Goal",
        "",
        "> \"Do the thing.\"",
        "",
        "Planfile Path: " + planPath,
        "Plan Name: named-plan",
      ].join("\n"),
    );

    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Write",
        tool_input: { file_path: planPath },
      },
      codexEncoder,
    );

    expect(JSON.parse(fs.readFileSync(sessionCurrentPlanFile(sessionDir), "utf-8"))).toEqual({
      kind: "file",
      path: planPath,
      planName: "named-plan",
    });
  });

  it("records the current-plan sidecar when a multi-file edit touches a planfile second", async () => {
    const sourcePath = path.join(tempDir, "src", "main.ts");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "source");
    const planPath = sessionPlanFile(sessionDir, "second-plan");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(
      planPath,
      [
        "Plan Name: second-plan",
        "",
        "## User Goal",
        "",
        "> \"Do the thing.\"",
        "",
        "Planfile Path: " + planPath,
        "Plan Name: second-plan",
      ].join("\n"),
    );

    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: { file_path: sourcePath, file_paths: [sourcePath, planPath] },
      },
      codexEncoder,
    );

    expect(JSON.parse(fs.readFileSync(sessionCurrentPlanFile(sessionDir), "utf-8"))).toEqual({
      kind: "file",
      path: planPath,
      planName: "second-plan",
    });
  });

  it("records the current-plan sidecar after a successful planfile MultiEdit", async () => {
    const planPath = sessionPlanFile(sessionDir, "multi-edit-plan");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(
      planPath,
      [
        "Plan Name: multi-edit-plan",
        "",
        "## User Goal",
        "",
        "> \"Do the thing.\"",
        "",
        "Planfile Path: " + planPath,
        "Plan Name: multi-edit-plan",
      ].join("\n"),
    );

    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "MultiEdit",
        tool_input: {
          file_path: planPath,
          edits: [{ old_string: "thing", new_string: "thing now" }],
        },
      },
      codexEncoder,
    );

    expect(JSON.parse(fs.readFileSync(sessionCurrentPlanFile(sessionDir), "utf-8"))).toEqual({
      kind: "file",
      path: planPath,
      planName: "multi-edit-plan",
    });
  });

  it("logs raw Codex edit_file successes as canonical Edit entries", async () => {
    const filePath = path.join(tempDir, "src", "main.ts");

    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "edit_file",
        tool_input: { file_path: filePath },
      },
      codexEncoder,
    );

    const [entry] = readToolLogEntries(sessionDir, 1);
    expect(entry.tool).toBe("Edit");
    expect(entry.path).toBe(filePath);
    expect(entry.paths).toEqual([filePath]);
  });

  it("logs raw Codex write_file successes as canonical Write entries", async () => {
    const filePath = path.join(tempDir, "src", "main.ts");

    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "write_file",
        tool_input: { file_path: filePath },
      },
      codexEncoder,
    );

    const [entry] = readToolLogEntries(sessionDir, 1);
    expect(entry.tool).toBe("Write");
    expect(entry.path).toBe(filePath);
    expect(entry.paths).toEqual([filePath]);
  });

  it("requires the exact Codex wait only after an MCP yields a cell", async () => {
    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "mcp__agent_framework__check",
        tool_input: { working_dir: tempDir },
        tool_response: {
          content: [{ type: "text", text: "Script running with cell ID cell-check" }],
        },
      },
      codexEncoder,
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools).toEqual([
      {
        tool: "Wait",
        input: { cell_id: "cell-check", yield_time_ms: 330000 },
        reason: "Wait must continue the preceding MCP call for this adapter",
      },
    ]);
    expect(decidePrediction(state.currentPrediction, "Wait", {
      cell_id: "cell-check",
      yield_time_ms: 1,
    }, 0).decision).toBe("deny");
    expect(decidePrediction(state.currentPrediction, "Wait", {
      cell_id: "cell-check",
      yield_time_ms: 330000,
    }, 0).decision).toBe("allow");
  });

  it("does not require a wait after a synchronous MCP result", async () => {
    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "mcp__agent_framework__check",
        tool_input: { working_dir: tempDir },
        tool_response: { content: [{ type: "text", text: "Status: PASS" }] },
      },
      codexEncoder,
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools ?? []).toEqual([]);
  });

  it("does not treat incidental cell-like MCP output as a yielded continuation", async () => {
    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "mcp__agent_framework__check",
        tool_input: { working_dir: tempDir },
        tool_response: {
          content: [{
            type: "text",
            text: "Checked fixture: {\"cell_id\":\"example\"}; phrase: cell ID example",
          }],
          metadata: { cellId: "example" },
        },
      },
      codexEncoder,
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools ?? []).toEqual([]);
  });

  it("does not require a wait after an MCP failure without a cell", async () => {
    await mainPostToolUseFailure(
      {
        session_id: "session-post",
        tool_use_id: "tool-failed-check",
        tool_name: "mcp__agent_framework__check",
        error: "MCP failed before yielding",
        is_interrupt: false,
        transcript_path: transcriptPath,
      },
      codexEncoder,
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools ?? []).toEqual([]);
    expect(readToolLogEntries(sessionDir, 1)[0]?.toolUseId).toBe("tool-failed-check");
  });

  it("does not orphan a wait for a synchronous parallel MCP sibling", async () => {
    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_use_id: "call-check",
        tool_name: "mcp__agent_framework__check",
        tool_input: { working_dir: tempDir },
        tool_response: "Status: PASS",
      },
      codexEncoder,
    );
    await mainPostToolUse(
      {
        session_id: "session-post",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_use_id: "call-confirm",
        tool_name: "mcp__agent_framework__confirm",
        tool_input: { working_dir: tempDir },
        tool_response: "Script running with cell ID cell-confirm",
      },
      codexEncoder,
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools).toEqual([
      {
        tool: "Wait",
        input: { cell_id: "cell-confirm", yield_time_ms: 1500000 },
        reason: "Wait must continue the preceding MCP call for this adapter",
      },
    ]);
  });
});
