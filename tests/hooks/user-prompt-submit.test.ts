import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEncoder } from "../../src/adapter/types.js";

vi.mock("../../src/utils/hook-bootstrap.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/hook-bootstrap.js")>(
    "../../src/utils/hook-bootstrap.js",
  );
  return {
    ...actual,
    exitAfterFlush: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/rules/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/rules/index.js")>(
    "../../src/rules/index.js",
  );
  return {
    ...actual,
    evaluateRulesForUserPromptSubmit: vi.fn().mockResolvedValue(undefined),
  };
});

import { mainUserPromptSubmit } from "../../src/hooks/user-prompt-submit.js";
import { evaluateRulesForUserPromptSubmit } from "../../src/rules/index.js";
import { exitAfterFlush } from "../../src/utils/hook-bootstrap.js";

const mockEvaluateRulesForUserPromptSubmit = vi.mocked(evaluateRulesForUserPromptSubmit);
const mockExitAfterFlush = vi.mocked(exitAfterFlush);

const encoder: AdapterEncoder = {
  name: "test",
  encodePreToolUseAllow: () => ({ exitCode: 0, stdout: "" }),
  encodePreToolUseDeny: (reason: string) => ({ exitCode: 2, stdout: reason }),
  encodeStopBlock: (reason: string) => ({ exitCode: 2, stdout: reason }),
  encodeStopPass: () => ({ exitCode: 0, stdout: "" }),
  encodeOk: () => ({ exitCode: 0, stdout: "ok" }),
  encodeError: (_event, message: string) => ({ exitCode: 1, stdout: message }),
};

describe("mainUserPromptSubmit slash/skill workflow bypass", () => {
  let tempDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-prompt-submit-test-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
  });

  it("skips UserPromptSubmit rules for direct agent-framework slash commands", async () => {
    await mainUserPromptSubmit(
      {
        session_id: "session-slash",
        transcript_path: transcriptPath,
        cwd: tempDir,
        prompt: "/quickpush",
      },
      encoder,
    );

    expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
  });

  it("skips UserPromptSubmit rules for Codex agent-framework skill invocations", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      await mainUserPromptSubmit(
        {
          session_id: "session-skill",
          transcript_path: transcriptPath,
          cwd: tempDir,
          prompt: "$agent-framework-quickpush",
        },
        encoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("still runs UserPromptSubmit rules for ordinary prompts", async () => {
    await mainUserPromptSubmit(
      {
        session_id: "session-normal",
        transcript_path: transcriptPath,
        cwd: tempDir,
        prompt: "please fix the bug",
      },
      encoder,
    );

    expect(mockEvaluateRulesForUserPromptSubmit).toHaveBeenCalledTimes(1);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
  });
});
