import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adapterRoot,
  agentFrameworkRoot,
  internalRuntimeHomeRoot,
  internalSessionRoot,
  internalVolatileRoot,
  managedProviderRoot,
  runtimeScratchRoot,
} from "../utils/paths.js";
import { adapterSpecByName } from "../adapter/spec.js";
import type { AdapterRuntimeHomeSpec } from "../adapter/types.js";
import { TEXT_EDIT_TOOL_NAMES } from "../utils/edit-tools.js";
import {
  runtimeProfileDescriptor,
  type RuntimeHomeProfile,
  type RuntimeToolPolicy,
  type SessionPolicy,
} from "./profiles.js";

export type RuntimeProvider = string;
export type SdkToolPolicy = RuntimeToolPolicy;
export type { RuntimeHomeProfile, SessionPolicy } from "./profiles.js";

export type MaterializedRuntimeHome = {
  provider: RuntimeProvider;
  profile: RuntimeHomeProfile;
  root: string | null;
  env: NodeJS.ProcessEnv;
  sessionPolicy: SessionPolicy;
  runId: string;
  volatileDir?: string;
  cleanup(): void;
};

export function sdkToolsForPolicy(policy: SdkToolPolicy): readonly string[] {
  if (policy === "none") return [];
  if (policy === "read-only") return ["Read", "Bash"];
  return [
    "Read",
    "Bash",
    ...TEXT_EDIT_TOOL_NAMES,
    "Glob",
    "Grep",
    "LS",
    "TodoWrite",
  ];
}

export function runtimeProfileRoot(
  profile: RuntimeHomeProfile,
  provider: RuntimeProvider,
  runId?: string,
): string | null {
  if (profile === "native") return null;
  if (profile === "managedAstral") return managedProviderRoot(provider);
  const base = internalRuntimeHomeRoot(profile, provider);
  return runId ? path.join(base, runId) : base;
}

export function makeRuntimeRunId(prefix: string): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return `${safePrefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export function materializeRuntimeHome(input: {
  provider: RuntimeProvider;
  profile: RuntimeHomeProfile;
  toolPolicy?: SdkToolPolicy;
  env?: NodeJS.ProcessEnv;
  runId?: string;
}): MaterializedRuntimeHome {
  const env = { ...(input.env ?? process.env) };
  const runId = input.runId ?? makeRuntimeRunId(`${input.provider}-${input.profile}`);
  const sessionPolicy = sessionPolicyForProfile(input.profile);
  const root = runtimeProfileRoot(input.profile, input.provider, runId);
  let volatileDir: string | undefined;

  try {
    if (root) {
      ensurePrivateDirectory(root);
      if (input.profile === "managedAstral") {
        syncAdapterHome(input.provider, root, env, input.profile);
      } else if (input.profile === "internalDirect") {
        syncMinimalAuthHome(input.provider, root, env);
        removeMcpServerConfig(input.provider, root);
        removeHooksConfig(input.provider, root);
      } else {
        syncAdapterHome(input.provider, root, env, input.profile);
        removeMcpServerConfig(input.provider, root);
        sanitizeLocalSettings(input.provider, root);
      }
    }

    if (sessionPolicy === "volatile") {
      volatileDir = path.join(internalVolatileRoot(), runId);
      ensurePrivateDirectory(volatileDir);
    } else if (sessionPolicy === "write") {
      ensurePrivateDirectory(path.join(internalSessionRoot("write"), runId));
    }
  } catch (error) {
    if (volatileDir) fs.rmSync(volatileDir, { recursive: true, force: true });
    if (root && input.profile.startsWith("internal")) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }

  const nextEnv = withRuntimeEnv(input.provider, env, root, {
    profile: input.profile,
    sessionPolicy,
    runId,
    volatileDir,
  });

  return {
    provider: input.provider,
    profile: input.profile,
    root,
    env: nextEnv,
    sessionPolicy,
    runId,
    volatileDir,
    cleanup() {
      if (volatileDir) fs.rmSync(volatileDir, { recursive: true, force: true });
      if (root && input.profile.startsWith("internal")) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

export function runtimeScratchDir(prefix = "run"): string {
  const root = runtimeScratchRoot();
  ensurePrivateDirectory(root);
  return fs.mkdtempSync(path.join(root, `${prefix}-`));
}

export function cleanupRuntimeScratch(dir: string | null | undefined): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

export function sessionPolicyForProfile(profile: RuntimeHomeProfile): SessionPolicy {
  return runtimeProfileDescriptor(profile).sessionPolicy;
}

export function resolveRuntimeHomeProfile(input: {
  runtimeHomeProfile?: RuntimeHomeProfile;
  sdkRuntimeHome?: "native" | "managedAstral";
  sdkRuntimeEnvironment?: "user" | "isolated";
  sdkToolPolicy?: SdkToolPolicy;
  runtimeExecutionMode?: "direct" | "sdk";
}): RuntimeHomeProfile {
  if (input.runtimeHomeProfile) return input.runtimeHomeProfile;
  if (input.sdkRuntimeHome === "managedAstral") return "managedAstral";
  if (input.sdkRuntimeEnvironment === "user") return "native";
  if (input.sdkToolPolicy === "write") return "internalWrite";
  if (input.sdkToolPolicy === "none" || input.runtimeExecutionMode === "direct") return "internalDirect";
  return "internalReadOnly";
}

function withRuntimeEnv(
  provider: RuntimeProvider,
  env: NodeJS.ProcessEnv,
  root: string | null,
  marker: {
    profile: RuntimeHomeProfile;
    sessionPolicy: SessionPolicy;
    runId: string;
    volatileDir?: string;
  },
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    AGENT_FRAMEWORK_RUNTIME_PROFILE: marker.profile,
    AGENT_FRAMEWORK_SESSION_POLICY: marker.sessionPolicy,
    AGENT_FRAMEWORK_RUN_ID: marker.runId,
    AGENT_FRAMEWORK_ROOT: env.AGENT_FRAMEWORK_ROOT ?? agentFrameworkRoot(),
  };
  if (marker.volatileDir) next.AGENT_FRAMEWORK_VOLATILE_DIR = marker.volatileDir;
  if (marker.sessionPolicy === "write") {
    next.AGENT_FRAMEWORK_DISABLE_STOP_BLOCK = "1";
  } else {
    delete next.AGENT_FRAMEWORK_DISABLE_STOP_BLOCK;
  }
  return runtimeHomeAdapter(provider).applyRuntimeEnv(next, root);
}

function syncAdapterHome(
  provider: RuntimeProvider,
  destinationRoot: string,
  env: NodeJS.ProcessEnv,
  profile: RuntimeHomeProfile,
): void {
  const adapter = runtimeHomeAdapter(provider);
  const sourceRoot = adapter.dotRoot(adapterRoot(provider));
  const preserved = preserveAuthFiles(provider, destinationRoot);
  if (profile === "managedAstral") {
    removeAdapterOwnedEntries(destinationRoot, [
      ...adapter.durableManagedEntries,
      ...adapter.authFiles,
    ]);
  } else {
    fs.rmSync(destinationRoot, { recursive: true, force: true });
  }
  copyDirectory(sourceRoot, destinationRoot);
  restorePreserved(destinationRoot, preserved);
  copyProviderAuthToHome(provider, destinationRoot, env);
  adapter.rewriteConfig?.(destinationRoot, profile);
  if (sessionPolicyForProfile(profile) === "write") adapter.removeStopHookFromSettings?.(destinationRoot);
  ensurePrivateDirectory(destinationRoot);
}

function syncMinimalAuthHome(provider: RuntimeProvider, destinationRoot: string, env: NodeJS.ProcessEnv): void {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  ensurePrivateDirectory(destinationRoot);
  copyProviderAuthToHome(provider, destinationRoot, env);
  runtimeHomeAdapter(provider).writeMinimalConfig?.(destinationRoot);
}

function preserveAuthFiles(provider: RuntimeProvider, root: string): Map<string, Buffer> {
  const names = runtimeHomeAdapter(provider).authFiles;
  const preserved = new Map<string, Buffer>();
  for (const name of names) {
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) preserved.set(name, fs.readFileSync(file));
    } catch {
      // absent
    }
  }
  return preserved;
}

function restorePreserved(root: string, preserved: Map<string, Buffer>): void {
  for (const [name, content] of preserved) {
    const target = path.join(root, name);
    ensurePrivateDirectory(path.dirname(target));
    fs.writeFileSync(target, content, { mode: 0o600 });
  }
}

export function copyProviderAuthToHome(
  provider: RuntimeProvider,
  destinationRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const nativeRoot = resolveNativeProviderRoot(provider, env);
  const names = runtimeHomeAdapter(provider).authFiles;
  for (const name of names) {
    copyTopLevelFileIfPresent(path.join(nativeRoot, name), path.join(destinationRoot, name));
  }
}

export function resolveNativeProviderRoot(provider: RuntimeProvider, env: NodeJS.ProcessEnv = process.env): string {
  return runtimeHomeAdapter(provider).resolveNativeRoot({
    env,
    homeDir: os.homedir(),
    managedRoot: managedProviderRoot(provider),
  });
}

function copyTopLevelFileIfPresent(source: string, destination: string): void {
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    ensurePrivateDirectory(path.dirname(destination));
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o600);
  } catch {
    // absent
  }
}

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dest = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

function removeMcpServerConfig(provider: RuntimeProvider, root: string): void {
  runtimeHomeAdapter(provider).removeMcpServerConfig(root);
}

function removeHooksConfig(provider: RuntimeProvider, root: string): void {
  runtimeHomeAdapter(provider).removeHooksConfig(root);
}

function sanitizeLocalSettings(provider: RuntimeProvider, root: string): void {
  runtimeHomeAdapter(provider).sanitizeLocalSettings?.(root);
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function removeAdapterOwnedEntries(
  destinationRoot: string,
  preservedEntries: readonly string[],
): void {
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const preserved = new Set(preservedEntries);
  for (const entry of fs.readdirSync(destinationRoot, { withFileTypes: true })) {
    if (preserved.has(entry.name)) continue;
    fs.rmSync(path.join(destinationRoot, entry.name), { recursive: true, force: true });
  }
}

function runtimeHomeAdapter(provider: RuntimeProvider): AdapterRuntimeHomeSpec {
  return adapterSpecByName(provider).runtimeHome;
}
