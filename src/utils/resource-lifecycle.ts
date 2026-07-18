/** Run an operation and always clean up, preserving the operation failure when both fail. */
export async function withCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<unknown>,
): Promise<T> {
  let result: { value: T } | null = null;
  let operationFailure: { error: unknown } | null = null;
  try {
    result = { value: await operation() };
  } catch (error) {
    operationFailure = { error };
  }
  const cleanupFailure = await cleanup()
    .then(() => null, (error: unknown) => ({ error }));
  if (operationFailure) throw operationFailure.error;
  if (cleanupFailure) throw cleanupFailure.error;
  return result!.value;
}
