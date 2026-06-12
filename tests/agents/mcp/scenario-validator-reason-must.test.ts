import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { validateScenario } from "../../../src/scenario/types.js";
import { baseValidationScenario } from "../../helpers/scenario-fixtures.js";

function baseScenario(): Record<string, unknown> {
  return baseValidationScenario({
    name: "test-reason-must",
    expect: {
      expected: "deny",
      by: "tool-approve",
      reason_must: {
        contains: ["bad"],
        not_contains: ["good"],
      },
    },
  });
}

describe("validateScenario reason_must", () => {
  it("accepts well-formed reason_must on single-form expect", () => {
    expect(() => validateScenario(baseScenario())).not.toThrow();
  });

  it("accepts well-formed reason_must on fanout-form expect", () => {
    const s = baseScenario();
    s.transcript = [
      { role: "user", content: "x" },
      {
        role: "assistant_split",
        msg_id: "msg_1",
        lines: [
          {
            blocks: [
              {
                type: "tool_use",
                id: "t1",
                name: "Bash",
                input: { command: "ls" },
              },
            ],
          },
          {
            blocks: [
              {
                type: "tool_use",
                id: "t2",
                name: "Bash",
                input: { command: "ls" },
              },
            ],
          },
        ],
      },
    ];
    s.target = { hook: "PreToolUse", fanout: true };
    s.expect = [
      {
        position: 0,
        expected: "deny",
        by: "tool-approve",
        reason_must: { contains: ["x"] },
      },
      { position: 1, expected: "allow" },
    ];
    expect(() => validateScenario(s)).not.toThrow();
  });

  it("rejects reason_must when expected='allow'", () => {
    const s = baseScenario();
    (s.expect as { expected: string }).expected = "allow";
    expect(() => validateScenario(s)).toThrow(
      /reason_must requires expected ∈/,
    );
  });

  it("rejects reason_must on Stop hook with expected='pass'", () => {
    const s = baseScenario();
    s.transcript = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
    ];
    s.target = { hook: "Stop" };
    s.expect = {
      expected: "pass",
      reason_must: { contains: ["x"] },
    };
    expect(() => validateScenario(s)).toThrow(
      /reason_must requires expected ∈/,
    );
  });

  it("rejects empty arrays", () => {
    const s = baseScenario();
    (s.expect as { reason_must: Record<string, unknown> }).reason_must = {
      contains: [],
    };
    expect(() => validateScenario(s)).toThrow(
      /reason_must.contains must be a non-empty array/,
    );
  });

  it("rejects non-string entries", () => {
    const s = baseScenario();
    (s.expect as { reason_must: Record<string, unknown> }).reason_must = {
      contains: [123],
    };
    expect(() => validateScenario(s)).toThrow(
      /reason_must.contains\[0\] must be a non-empty string/,
    );
  });

  it("rejects uncompilable regex (asserts new RegExp error message surfaces)", () => {
    const s = baseScenario();
    (s.expect as { reason_must: Record<string, unknown> }).reason_must = {
      matches: ["[unterminated"],
    };
    expect(() => validateScenario(s)).toThrow(
      /reason_must.matches\[0\] is not a valid regex/,
    );
  });

  it("rejects unknown sub-fields under reason_must", () => {
    const s = baseScenario();
    (s.expect as { reason_must: Record<string, unknown> }).reason_must = {
      contains: ["x"],
      bogus: ["y"],
    };
    expect(() => validateScenario(s)).toThrow(
      /reason_must.bogus is not a recognized field/,
    );
  });

  it("rejects empty-shape reason_must (every sub-array missing)", () => {
    const s = baseScenario();
    (s.expect as { reason_must: Record<string, unknown> }).reason_must = {};
    expect(() => validateScenario(s)).toThrow(
      /reason_must is set but every sub-array is missing/,
    );
  });

});

describe("setRichLabel reason_must round-trip", () => {
  let TMP_HOME: string;
  const ORIG_HOME = process.env.HOME;
  const transcriptName = "rrm-test-transcript";

  beforeEach(() => {
    TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rrm-"));
    process.env.HOME = TMP_HOME;
    const dir = path.join(
      TMP_HOME,
      ".agent-framework",
      "test-runs",
      transcriptName,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "labels.draft.json"),
      JSON.stringify({ labels: {} }),
    );
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = ORIG_HOME;
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("rejects reason_must on expected='allow' (validates within setRichLabel)", async () => {
    const { setRichLabel } = await import(
      "../../../src/agents/mcp/scenario-mcp-shared.js"
    );
    expect(() =>
      setRichLabel(
        transcriptName,
        "tool:abc",
        {
          expected: "allow",
          reason_must: { contains: ["x"] },
        },
        "test reasoning",
      ),
    ).toThrow(/reason_must on key "tool:abc" requires expected/);
  });

  it("accepts reason_must on expected='deny' and round-trips through writeLabelFile", async () => {
    const { setRichLabel } = await import(
      "../../../src/agents/mcp/scenario-mcp-shared.js"
    );
    const result = setRichLabel(
      transcriptName,
      "tool:abc",
      {
        expected: "deny",
        by: "tool-approve",
        reason_must: { not_contains: ["bad text"] },
      },
      "test reasoning",
    );
    const stored = result.labels["tool:abc"];
    expect(stored).toMatchObject({
      expected: "deny",
      by: "tool-approve",
      reason_must: { not_contains: ["bad text"] },
    });
  });

  it("rejects malformed reason_must shapes via setRichLabel", async () => {
    const { setRichLabel } = await import(
      "../../../src/agents/mcp/scenario-mcp-shared.js"
    );
    expect(() =>
      setRichLabel(
        transcriptName,
        "tool:abc",
        {
          expected: "deny",
          reason_must: { matches: ["[unterminated"] },
        },
        "test",
      ),
    ).toThrow(/is not a valid regex/);
  });
});
