import "../utils/load-env.js";
import { AiBackendSessionManager } from "./session-manager.js";
import { readClientFrames, writeBackendFrame } from "./wire.js";

const manager = new AiBackendSessionManager(writeBackendFrame);

try {
  await readClientFrames((frame) => manager.handle(frame));
} catch (error) {
  writeBackendFrame({
    type: "response",
    response: {
      type: "error",
      sessionId: null,
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
}
