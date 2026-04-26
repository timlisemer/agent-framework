import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findUnprocessedPlanApproval,
  synthesizePostApprovalPrediction,
  PLAN_APPROVAL_MARKER,
} from "../../src/utils/plan-approval-detector.js";

describe("findUnprocessedPlanApproval", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-approval-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTranscript(entries: unknown[]): string {
    const filePath = path.join(tempDir, "transcript.jsonl");
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("returns null for empty transcript", async () => {
    const filePath = writeTranscript([]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).toBeNull();
  });

  it("returns null for non-existent file", async () => {
    const result = await findUnprocessedPlanApproval(
      path.join(tempDir, "missing.jsonl"),
    );
    expect(result).toBeNull();
  });

  it("returns event when ExitPlanMode tool_use is followed by matching tool_result", async () => {
    const filePath = writeTranscript([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_exit",
              name: "ExitPlanMode",
              input: { plan: "..." },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_exit",
              content: `${PLAN_APPROVAL_MARKER} You can now start coding.`,
            },
          ],
        },
      },
    ]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).not.toBeNull();
    expect(result?.toolUseId).toBe("toolu_exit");
    expect(result?.approvalContent).toContain(PLAN_APPROVAL_MARKER);
  });

  it("returns null when tool_use_id resolves to non-ExitPlanMode tool", async () => {
    const filePath = writeTranscript([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_other",
              name: "Read",
              input: { file_path: "foo.txt" },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_other",
              content: `${PLAN_APPROVAL_MARKER} (false positive)`,
            },
          ],
        },
      },
    ]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).toBeNull();
  });

  it("returns null when tool_result content does not start with marker", async () => {
    const filePath = writeTranscript([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_exit",
              name: "ExitPlanMode",
              input: { plan: "..." },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_exit",
              content: "Plan rejected.",
            },
          ],
        },
      },
    ]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).toBeNull();
  });

  it("returns null when a real user TEXT turn appears after the approval (string content)", async () => {
    const filePath = writeTranscript([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_exit",
              name: "ExitPlanMode",
              input: { plan: "..." },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_exit",
              content: `${PLAN_APPROVAL_MARKER} You can now start coding.`,
            },
          ],
        },
      },
      {
        isMeta: false,
        message: {
          role: "user",
          content: "wait, change of plan",
        },
      },
    ]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).toBeNull();
  });

  it("returns null when a real user TEXT turn appears after the approval (array content)", async () => {
    const filePath = writeTranscript([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_exit",
              name: "ExitPlanMode",
              input: { plan: "..." },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_exit",
              content: `${PLAN_APPROVAL_MARKER} You can now start coding.`,
            },
          ],
        },
      },
      {
        isMeta: false,
        message: {
          role: "user",
          content: [{ type: "text", text: "actually, hold on" }],
        },
      },
    ]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).toBeNull();
  });

  it("returns event when only meta user turns appear after the approval", async () => {
    const filePath = writeTranscript([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_exit",
              name: "ExitPlanMode",
              input: { plan: "..." },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_exit",
              content: `${PLAN_APPROVAL_MARKER} You can now start coding.`,
            },
          ],
        },
      },
      {
        isMeta: true,
        message: {
          role: "user",
          content: [{ type: "text", text: "<meta marker>" }],
        },
      },
    ]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).not.toBeNull();
    expect(result?.toolUseId).toBe("toolu_exit");
  });

  it("returns the most recent approval when multiple approval cycles exist", async () => {
    const filePath = writeTranscript([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_first",
              name: "ExitPlanMode",
              input: { plan: "first" },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_first",
              content: `${PLAN_APPROVAL_MARKER} First approval.`,
            },
          ],
        },
      },
      {
        isMeta: false,
        message: { role: "user", content: "next task" },
      },
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_second",
              name: "ExitPlanMode",
              input: { plan: "second" },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_second",
              content: `${PLAN_APPROVAL_MARKER} Second approval.`,
            },
          ],
        },
      },
    ]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).not.toBeNull();
    expect(result?.toolUseId).toBe("toolu_second");
    expect(result?.approvalContent).toContain("Second approval");
  });

  it("handles tool_result.content as a [{type:'text', text:'...'}] array", async () => {
    const filePath = writeTranscript([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_exit",
              name: "ExitPlanMode",
              input: { plan: "..." },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_exit",
              content: [
                {
                  type: "text",
                  text: `${PLAN_APPROVAL_MARKER} (array shape)`,
                },
              ],
            },
          ],
        },
      },
    ]);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).not.toBeNull();
    expect(result?.toolUseId).toBe("toolu_exit");
    expect(result?.approvalContent).toContain("(array shape)");
  });

  it("silently skips malformed JSONL lines and returns valid result", async () => {
    const filePath = path.join(tempDir, "transcript.jsonl");
    const goodEntries = [
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_exit",
              name: "ExitPlanMode",
              input: { plan: "..." },
            },
          ],
        },
      },
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_exit",
              content: `${PLAN_APPROVAL_MARKER} You can now start coding.`,
            },
          ],
        },
      },
    ];
    const content =
      JSON.stringify(goodEntries[0]) +
      "\n{not valid json\n" +
      JSON.stringify(goodEntries[1]) +
      "\n";
    fs.writeFileSync(filePath, content);
    const result = await findUnprocessedPlanApproval(filePath);
    expect(result).not.toBeNull();
    expect(result?.toolUseId).toBe("toolu_exit");
  });
});

describe("synthesizePostApprovalPrediction", () => {
  it("returns a prediction with neutral mood, normal trust, contextSwitch=yes, and intent containing 'approved'", () => {
    const result = synthesizePostApprovalPrediction(
      `${PLAN_APPROVAL_MARKER} You can now start coding.`,
    );
    expect(result.mood).toBe("neutral");
    expect(result.trust).toBe("normal");
    expect(result.contextSwitch).toBe("yes");
    expect(result.intent).toContain("approved");
  });

  it("populates userMessageSnippet with [plan approved] prefix", () => {
    const content = `${PLAN_APPROVAL_MARKER} You can now start coding.`;
    const result = synthesizePostApprovalPrediction(content);
    expect(result.userMessageSnippet.startsWith("[plan approved] ")).toBe(true);
    expect(result.userMessageSnippet.length).toBeLessThanOrEqual(200);
  });

  it("sets timestamp to a recent value", () => {
    const before = Date.now();
    const result = synthesizePostApprovalPrediction(PLAN_APPROVAL_MARKER);
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it("leaves explicitlyAllowedTools and explicitlyBlockedSubstrings empty (conservative)", () => {
    const result = synthesizePostApprovalPrediction(PLAN_APPROVAL_MARKER);
    expect(result.explicitlyAllowedTools).toEqual([]);
    expect(result.explicitlyBlockedSubstrings).toEqual([]);
    expect(result.blockAllTools).toBe(false);
    expect(result.hasExplicitOverride).toBe(false);
  });

  it("truncates long approval content to fit within 200 chars total", () => {
    const longContent =
      PLAN_APPROVAL_MARKER + " " + "x".repeat(500);
    const result = synthesizePostApprovalPrediction(longContent);
    expect(result.userMessageSnippet.length).toBeLessThanOrEqual(200);
  });
});
