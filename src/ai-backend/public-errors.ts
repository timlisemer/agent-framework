import { isCancellationError } from "../utils/cancellation.js";
import type { ProviderError, ProviderMetadata } from "../providers/provider-contract.js";

export function toPublicError(
  error: unknown,
  options: { publicMessage?: string; metadata?: ProviderMetadata } = {}
): ProviderError {
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
  code: Exclude<ProviderError["code"], "cancelled" | "runtime_error">,
  message: string
): ProviderError {
  return { code, message, recoverable: code !== "conflict" };
}

function withMetadata(error: ProviderError, metadata: ProviderMetadata | undefined): ProviderError {
  return metadata && Object.keys(metadata).length > 0 ? { ...error, metadata } : error;
}
