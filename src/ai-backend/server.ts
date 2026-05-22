import "../utils/load-env.js";
import { AiBackendSessionManager } from "./session-manager.js";
import { readClientFrames, writeBackendFrame } from "./wire.js";

const manager = new AiBackendSessionManager(writeBackendFrame);

try {
  await readClientFrames(
    (frame) => manager.handle(frame),
    undefined,
    () => {
      writeBackendFrame({
        type: "response",
        response: {
          type: "error",
          sessionId: null,
          message: "Invalid request frame",
          error: {
            code: "invalid_request",
            message: "Invalid request frame",
            recoverable: true,
          },
        },
      });
    }
  );
} catch (error) {
  writeBackendFrame({
    type: "response",
    response: {
      type: "error",
      sessionId: null,
      message: "Runtime operation failed",
      error: {
        code: "runtime_error",
        message: "Runtime operation failed",
        recoverable: false,
      },
    },
  });
  process.exitCode = 1;
} finally {
  await manager.dispose();
}
