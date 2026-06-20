import { describe, expect, it } from "vitest";
import { AiBackendSessionManager } from "../../src/ai-backend/session-manager.js";
import type { AiBackendMessage } from "../../src/ai-protocol/index.js";

describe("AI backend close requests", () => {
  it("reports request-scoped not_found for unknown sessions", async () => {
    const frames: AiBackendMessage[] = [];
    const manager = new AiBackendSessionManager((frame) => frames.push(frame));

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
