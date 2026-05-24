import { describe, expect, it } from "vitest";
import { AiBackendSessionManager } from "../../src/ai-backend/session-manager.js";
import type { AiBackendMessage } from "../../src/ai-protocol/index.js";

describe("AI backend plan state", () => {
  it("emits provider-neutral plan state changes", async () => {
    const frames: AiBackendMessage[] = [];
    const manager = new AiBackendSessionManager((frame) => frames.push(frame));
    await manager.handle({
      type: "request",
      request: {
        type: "startSession",
        sessionId: "session-plan-state",
        config: {
          model: null,
          workingDir: null,
          systemPrompt: null,
          continuable: false,
          sdkRuntimeEnvironment: "isolated",
        },
      },
    });
    const response = frames[0];
    if (response.type !== "response" || response.response.type !== "sessionStarted") {
      throw new Error("expected sessionStarted response");
    }

    await manager.handle({
      type: "request",
      request: {
        type: "setPlanState",
        sessionId: response.response.sessionId,
        state: { mode: "approved", planText: "ship it", approved: true },
      },
    });

    expect(frames).toContainEqual({
      type: "event",
      event: expect.objectContaining({
        type: "planStateChanged",
        sessionId: response.response.sessionId,
        state: { mode: "approved", planText: "ship it", approved: true },
      }),
    });
  });
});
