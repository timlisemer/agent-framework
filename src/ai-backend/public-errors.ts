import { isCancellationError } from "../utils/cancellation.js";
import type { AiErrorInfo, AiMetadata } from "../ai-protocol/index.js";

export function toPublicError(
  error: unknown,
  options: { publicMessage?: string; metadata?: AiMetadata } = {}
): AiErrorInfo {
  if (isCancellationError(error)) {
    return withMetadata(
      { code: "cancelled", message: "Operation cancelled", recoverable: true },
      options.metadata
    );
  }
  return withMetadata({
    code: "runtime_error",
    message: options.publicMessage ?? "Runtime operation failed",
    recoverable: false,
  }, options.metadata);
}

export function protocolError(
  code: Exclude<AiErrorInfo["code"], "cancelled" | "runtime_error">,
  message: string
): AiErrorInfo {
  return { code, message, recoverable: code !== "conflict" };
}

function withMetadata(error: AiErrorInfo, metadata: AiMetadata | undefined): AiErrorInfo {
  return metadata && Object.keys(metadata).length > 0 ? { ...error, metadata } : error;
}
