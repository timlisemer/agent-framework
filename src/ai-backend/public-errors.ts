import { isCancellationError } from "../utils/cancellation.js";
import type { AiErrorInfo } from "../ai-protocol/index.js";

export function toPublicError(error: unknown): AiErrorInfo {
  if (isCancellationError(error)) {
    return { code: "cancelled", message: "Operation cancelled", recoverable: true };
  }
  return { code: "runtime_error", message: "Runtime operation failed", recoverable: false };
}

export function protocolError(
  code: Exclude<AiErrorInfo["code"], "cancelled" | "runtime_error">,
  message: string
): AiErrorInfo {
  return { code, message, recoverable: code !== "conflict" };
}
