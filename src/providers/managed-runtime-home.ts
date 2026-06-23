import type { SdkRuntimeEnvironment, SdkRuntimeHome } from "./execution-types.js";
import {
  copyProviderAuthToHome,
  materializeRuntimeHome,
  resolveNativeProviderRoot,
  type RuntimeProvider,
} from "../runtime-home/runtime-profiles.js";

export type ManagedProvider = RuntimeProvider;

export type ManagedRuntimeHome = {
  provider: ManagedProvider;
  root: string;
  env: NodeJS.ProcessEnv;
};

export type ManagedRuntimeHomeConfig = {
  sdkRuntimeHome?: SdkRuntimeHome;
  sdkRuntimeEnvironment?: SdkRuntimeEnvironment;
};

export function assertManagedRuntimeHomeConfig(config: ManagedRuntimeHomeConfig): void {
  if (config.sdkRuntimeHome === "managedAstral" && config.sdkRuntimeEnvironment !== "user") {
    throw new Error("managedAstral runtime home requires sdkRuntimeEnvironment user");
  }
}

export function prepareManagedRuntimeHome(
  provider: ManagedProvider,
  env: NodeJS.ProcessEnv = process.env,
): ManagedRuntimeHome {
  const home = materializeRuntimeHome({
    provider,
    profile: "managedAstral",
    env,
    runId: `managed-${provider}`,
  });
  if (!home.root) throw new Error(`managed runtime home did not materialize for ${provider}`);
  return { provider, root: home.root, env: home.env };
}

export function copyCodexAuthToHome(destinationRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  copyProviderAuthToHome("codex", destinationRoot, env);
}

export { resolveNativeProviderRoot };
