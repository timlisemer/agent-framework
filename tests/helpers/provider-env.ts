import { resetProviderConfig } from "../../src/utils/provider-config.js";

const PROVIDER_ENV_KEYS = [
  "AGENT_FRAMEWORK_PROVIDER",
  "AGENT_FRAMEWORK_DIRECT_PROVIDER",
  "AGENT_FRAMEWORK_SDK_PROVIDER",
  "AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME",
] as const;

export function clearProviderEnvForTest(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of PROVIDER_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetProviderConfig();

  return () => {
    for (const key of PROVIDER_ENV_KEYS) {
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
