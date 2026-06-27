import { describe, expect, it } from "vitest";
import {
  createAiBackendHarness,
  requireSessionStartedFrame,
  startAiBackendSession,
} from "../helpers/ai-backend-harness.js";

describe("AI backend plan state", () => {
  it("emits provider-neutral plan state changes", async () => {
    const { frames, manager } = createAiBackendHarness();
    await startAiBackendSession(manager, "session-plan-state");
    const response = requireSessionStartedFrame(frames, "session-plan-state");

    await manager.handle({
      type: "request",
      request: {
        type: "setPlanState",
        sessionId: response.response.sessionId,
        state: { mode: "approved", planText: "ship it", approved: true },
      },
    });

    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "planStateChanged",
        sessionId: response.response.sessionId,
        state: { mode: "approved", planText: "ship it", approved: true },
      }),
      snapshot: expect.objectContaining({
        plan: { mode: "approved", planText: "ship it", approved: true },
      }),
    }));
  });
});
