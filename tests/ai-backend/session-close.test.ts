import { describe, expect, it } from "vitest";
import { createAiBackendHarness } from "../helpers/ai-backend-harness.js";

describe("AI backend close requests", () => {
  it("reports request-scoped not_found for unknown sessions", async () => {
    const { frames, manager } = createAiBackendHarness();

    await manager.handle({
      type: "request",
      request: {
        type: "closeSession",
        requestId: "request-close",
        sessionId: "session-missing",
      },
    });

    expect(frames).toEqual([{
      type: "response",
      response: {
        type: "requestError",
        requestId: "request-close",
        sessionId: "session-missing",
        code: "not_found",
        message: "Unknown AI session: session-missing",
        recoverable: true,
      },
    }]);
  });
});
