import { resetProviderConfig } from "../../src/utils/provider-config.js";

const PROVIDER_ENV_KEYS = [
  "AGENT_FRAMEWORK_PROVIDER",
  "AGENT_FRAMEWORK_DIRECT_PROVIDER",
  "AGENT_FRAMEWORK_SDK_PROVIDER",
  "AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME",
] as const;

export function clearProviderEnvForTest(): () => void {
  return withEnvForTest(Object.fromEntries(PROVIDER_ENV_KEYS.map((key) => [key, undefined])));
}

export function withEnvForTest(values: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetProviderConfig();

  return () => {
    for (const key of Object.keys(values)) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetProviderConfig();
  };
}
