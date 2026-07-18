export const PROVIDER_SETTLEMENT_TIMEOUT_MS = 1_000;

export type ProviderSettlement =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown }
  | { status: "timedOut" };

export class ProviderSettlementTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderSettlementTimeoutError";
  }
}

/** Normalize the one provider-settlement timeout policy shared by callers and waits. */
export function providerSettlementTimeout(
  timeoutMs = PROVIDER_SETTLEMENT_TIMEOUT_MS,
): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Provider settlement timeout must be a positive finite number");
  }
  return timeoutMs;
}

/** Observe a provider promise for its full lifetime while bounding how long cleanup waits for it. */
export async function waitForProviderSettlement(
  promise: Promise<unknown>,
  timeoutMs = PROVIDER_SETTLEMENT_TIMEOUT_MS,
): Promise<ProviderSettlement> {
  const validatedTimeoutMs = providerSettlementTimeout(timeoutMs);
  const observed = promise.then<ProviderSettlement, ProviderSettlement>(
    () => ({ status: "fulfilled" }),
    (error: unknown) => ({ status: "rejected", error }),
  );
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<ProviderSettlement>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timedOut" }), validatedTimeoutMs);
  });
  try {
    return await Promise.race([observed, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
