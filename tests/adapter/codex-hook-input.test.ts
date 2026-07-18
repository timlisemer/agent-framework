import { describe, expect, it } from "vitest";
import {
  toPostToolUseFailure,
  toUserPromptSubmit,
  type CodexFailureInput,
} from "../../adapters/codex/hooks/input.js";

describe("Codex hook input conversion", () => {
  it.each([
    { delivery_id: "delivery-snake" },
    { deliveryId: "delivery-camel" },
  ])("preserves a host-provided prompt delivery identity %#", (deliveryInput) => {
    expect(toUserPromptSubmit({
      sessionId: "session-codex",
      transcriptPath: "/tmp/codex-transcript.jsonl",
      prompt: "repeatable prompt",
      ...deliveryInput,
    })).toMatchObject({
      delivery_id: Object.values(deliveryInput)[0],
      prompt: "repeatable prompt",
    });
  });

  it.each([
    { collaboration_mode: "plan" },
    { collaborationMode: { mode: "plan" } },
    { collaboration_mode_kind: { kind: "plan" } },
    { collaborationModeKind: "plan" },
  ] satisfies Array<Partial<CodexFailureInput>>)(
    "normalizes failure input collaboration mode %#",
    (collaborationInput) => {
      const input: CodexFailureInput = {
        sessionId: "session-codex",
        transcriptPath: "/tmp/codex-transcript.jsonl",
        toolName: "wait",
        tool_input: { cell_id: "cell-check", yield_time_ms: 330000 },
        error: "wait failed",
        isInterrupt: false,
        ...collaborationInput,
      };

      expect(toPostToolUseFailure(input)).toMatchObject({
        session_id: "session-codex",
        transcript_path: "/tmp/codex-transcript.jsonl",
        collaboration_mode: "plan",
        tool_name: "wait",
        tool_input: { cell_id: "cell-check", yield_time_ms: 330000 },
        error: "wait failed",
        is_interrupt: false,
      });
    },
  );
});
