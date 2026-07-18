/** Apply test-only environment overrides and return an idempotent restorer. */
export function withEnvironmentForTest(
  values: Readonly<Record<string, string | undefined>>,
): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    setEnvironmentValue(key, value);
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [key, value] of saved) setEnvironmentValue(key, value);
  };
}

function setEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
