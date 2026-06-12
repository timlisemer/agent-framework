import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import { mainPreToolUse } from "../../src/hooks/pre-tool-use.js";
import { getAgentFrameworkSessionDir } from "../../src/utils/paths.js";

const mocks = vi.hoisted(() => ({
  exitAfterFlush: vi.fn().mockResolvedValue(undefined),
  validateClaudeMd: vi.fn(),
  appealHelper: vi.fn().mockResolvedValue({ overturned: false }),
}));

vi.mock("../../src/utils/hook-bootstrap.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/hook-bootstrap.js")>(
    "../../src/utils/hook-bootstrap.js",
  );
  return {
    ...actual,
    exitAfterFlush: mocks.exitAfterFlush,
  };
});

vi.mock("../../src/agents/hooks/claude-md-validate.js", () => ({
  validateClaudeMd: mocks.validateClaudeMd,
}));

vi.mock("../../src/agents/hooks/tool-appeal.js", () => ({
  appealHelper: mocks.appealHelper,
}));

vi.mock("../../src/rules/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/rules/index.js")>(
    "../../src/rules/index.js",
  );
  return {
    ...actual,
    evaluateRules: vi.fn().mockResolvedValue(null),
  };
});

describe("pre-tool-use planfile writes", () => {
  let tempDir: string;
  let transcriptPath: string;
  let sessionDir: string;
  let prevAdapter: string | undefined;
  let prevProjectDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-tool-use-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    prevProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    process.env.AGENT_FRAMEWORK_PROJECT_DIR = tempDir;
    mocks.exitAfterFlush.mockClear();
    mocks.validateClaudeMd.mockReset();
    mocks.appealHelper.mockClear();
    mocks.appealHelper.mockResolvedValue({ overturned: false });
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
    if (prevProjectDir === undefined) delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    else process.env.AGENT_FRAMEWORK_PROJECT_DIR = prevProjectDir;
  });

  it("does not run plan validation on every planfile Write/Edit", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "hooks", "pre-tool-use.ts"),
      "utf-8",
    );
    expect(source).not.toContain("validatePlanEdit");
    expect(source).not.toContain("runPlanValidation");
    expect(source).not.toContain("Plan-validate: Write/Edit to the active adapter's plans root.");
  });

  it("validates every instruction file in a multi-file edit", async () => {
    const agentsPath = path.join(tempDir, "AGENTS.md");
    const claudePath = path.join(tempDir, "CLAUDE.md");
    fs.writeFileSync(agentsPath, "agents");
    fs.writeFileSync(claudePath, "claude");
    mocks.validateClaudeMd
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: false, reason: "bad second file" });

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: agentsPath,
          file_paths: [agentsPath, claudePath],
          old_string: "old",
          new_string: "new",
        },
      },
      codexEncoder,
    );

    expect(mocks.validateClaudeMd).toHaveBeenCalledTimes(2);
    expect(mocks.validateClaudeMd.mock.calls.map((call) => call[0])).toEqual(["agents", "claude"]);
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(
      0,
      expect.stringContaining("CLAUDE.md validation failed: bad second file"),
    );
  });

  it("does not use instruction-file validation as the final allow for mixed edits", async () => {
    const agentsPath = path.join(tempDir, "AGENTS.md");
    const sourcePath = path.join(tempDir, "src", "main.ts");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(agentsPath, "agents");
    fs.writeFileSync(sourcePath, "source");
    mocks.validateClaudeMd.mockResolvedValueOnce({ approved: true });

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre-mixed",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: agentsPath,
          file_paths: [agentsPath, sourcePath],
          old_string: "old",
          new_string: "new",
        },
      },
      codexEncoder,
    );

    expect(mocks.validateClaudeMd).toHaveBeenCalledTimes(1);
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(0, "");
  });

  it("does not validate nested instruction-named files as host instruction files", async () => {
    const nestedAgentsPath = path.join(tempDir, "docs", "AGENTS.md");
    fs.mkdirSync(path.dirname(nestedAgentsPath), { recursive: true });
    fs.writeFileSync(nestedAgentsPath, "nested");

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre-nested-agents",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: nestedAgentsPath,
          file_paths: [nestedAgentsPath],
          old_string: "old",
          new_string: "new",
        },
      },
      codexEncoder,
    );

    expect(mocks.validateClaudeMd).not.toHaveBeenCalled();
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(0, "");
  });
});
