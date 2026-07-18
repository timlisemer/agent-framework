import { resetProviderConfig } from "../../src/utils/provider-config.js";
import { withEnvironmentForTest } from "./environment.js";

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
  const restoreEnvironment = withEnvironmentForTest(values);
  resetProviderConfig();

  return () => {
    restoreEnvironment();
    resetProviderConfig();
  };
}
