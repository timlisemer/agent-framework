import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { managedProviderRoot } from "../utils/paths.js";
import type { SdkRuntimeEnvironment, SdkRuntimeHome } from "./execution-types.js";

export type ManagedProvider = "codex" | "claude";

export type ManagedRuntimeHome = {
  provider: ManagedProvider;
  root: string;
  env: NodeJS.ProcessEnv;
};

export type ManagedRuntimeHomeConfig = {
  sdkRuntimeHome?: SdkRuntimeHome;
  sdkRuntimeEnvironment?: SdkRuntimeEnvironment;
};

const CLAUDE_AUTH_ALLOWLIST = new Set([
  ".credentials.json",
  "credentials.json",
  "settings.json",
  "settings.local.json",
]);

export function assertManagedRuntimeHomeConfig(config: ManagedRuntimeHomeConfig): void {
  if (config.sdkRuntimeHome === "managedAstral" && config.sdkRuntimeEnvironment !== "user") {
    throw new Error("managedAstral runtime home requires sdkRuntimeEnvironment user");
  }
}

export function prepareManagedRuntimeHome(provider: ManagedProvider, env: NodeJS.ProcessEnv = process.env): ManagedRuntimeHome {
  const root = managedProviderRoot(provider);
  ensurePrivateDirectory(root);
  if (provider === "codex") {
    copyCodexAuthToHome(root, env);
    return { provider, root, env: { ...env, CODEX_HOME: root } };
  }

  const nativeRoot = resolveNativeProviderRoot(provider, env);
  copyClaudeAllowedFiles(nativeRoot, root);
  return {
    provider,
    root,
    env: {
      ...env,
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_HOME: root,
    },
  };
}

export function copyCodexAuthToHome(destinationRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  const nativeRoot = resolveNativeProviderRoot("codex", env);
  copyTopLevelFileIfPresent(path.join(nativeRoot, "auth.json"), path.join(destinationRoot, "auth.json"));
}

export function resolveNativeProviderRoot(provider: ManagedProvider, env: NodeJS.ProcessEnv = process.env): string {
  if (provider === "codex") {
    const root = env.CODEX_HOME && path.resolve(env.CODEX_HOME);
    return root && root !== managedProviderRoot("codex")
      ? root
      : path.join(os.homedir(), ".codex");
  }

  const root = (env.CLAUDE_CONFIG_DIR ?? env.CLAUDE_HOME) &&
    path.resolve((env.CLAUDE_CONFIG_DIR ?? env.CLAUDE_HOME)!);
  return root && root !== managedProviderRoot("claude")
    ? root
    : path.join(os.homedir(), ".claude");
}

function copyClaudeAllowedFiles(sourceRoot: string, destinationRoot: string): void {
  if (!fs.existsSync(sourceRoot)) return;
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !CLAUDE_AUTH_ALLOWLIST.has(entry.name)) continue;
    copyTopLevelFileIfPresent(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name));
  }
}

function copyTopLevelFileIfPresent(source: string, destination: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  ensurePrivateDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
