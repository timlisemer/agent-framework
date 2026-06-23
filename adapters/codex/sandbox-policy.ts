import type { RuntimeHomeProfile, RuntimeToolPolicy } from "../../src/runtime-home/profiles.js";

export type CodexSandboxMode = "read-only" | "workspace-write";
export type CodexSandboxToolPolicy = RuntimeToolPolicy;

const RUNTIME_PROFILE_SANDBOX_MODE: Partial<Record<RuntimeHomeProfile, CodexSandboxMode>> = {
  internalDirect: "read-only",
  internalReadOnly: "read-only",
  internalWrite: "workspace-write",
};

export function codexSandboxModeForToolPolicy(policy: CodexSandboxToolPolicy): CodexSandboxMode {
  return policy === "write" ? "workspace-write" : "read-only";
}

export function codexSandboxModeForRuntimeProfile(profile: RuntimeHomeProfile): CodexSandboxMode | null {
  return RUNTIME_PROFILE_SANDBOX_MODE[profile] ?? null;
}
