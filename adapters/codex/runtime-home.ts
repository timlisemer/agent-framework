import fs from "node:fs";
import path from "node:path";
import {
  CODEX_HOOK_TRUST_BEGIN,
  CODEX_HOOK_TRUST_END,
  buildCodexHookTrustBlock,
} from "./hook-trust-state.js";
import { isPathAtOrInside } from "../../src/utils/path-containment.js";
import {
  codexSandboxModeForRuntimeProfile,
  codexSandboxModeForToolPolicy,
} from "./sandbox-policy.js";
import type { RuntimeHomeProfile } from "../../src/runtime-home/profiles.js";

export { codexSandboxModeForToolPolicy as sandboxModeForToolPolicy } from "./sandbox-policy.js";

export const CODEX_AUTH_FILES = ["auth.json"] as const;
export const CODEX_DURABLE_MANAGED_ENTRIES = ["sessions"] as const;

export function dotRoot(adapterRoot: string): string {
  return path.join(adapterRoot, "dotcodex");
}

export function applyRuntimeEnv(env: NodeJS.ProcessEnv, root: string | null): NodeJS.ProcessEnv {
  return root ? { ...env, CODEX_HOME: root } : env;
}

export function resolveNativeRoot(input: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  managedRoot: string;
}): string {
  const root = input.env.CODEX_HOME && path.resolve(input.env.CODEX_HOME);
  return root && !isPathAtOrInside(root, input.managedRoot)
    ? root
    : path.join(input.homeDir, ".codex");
}

export function writeMinimalConfig(root: string): void {
  fs.writeFileSync(path.join(root, "config.toml"), `sandbox_mode = "${codexSandboxModeForToolPolicy("none")}"\n`);
}

export function rewriteConfig(root: string, profile: RuntimeHomeProfile): void {
  const configPath = path.join(root, "config.toml");
  let config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
  config = rewriteCodexHookTrustConfig({
    config,
    hooksConfig: JSON.parse(fs.readFileSync(path.join(root, "hooks.json"), "utf8")),
    codexHooksSourcePath: path.join(root, "hooks.json"),
  });
  const sandboxMode = codexSandboxModeForRuntimeProfile(profile);
  if (sandboxMode) config = replaceOrAppendSandboxMode(config, sandboxMode);
  fs.writeFileSync(configPath, `${config.trimEnd()}\n`);
}

export function removeMcpServerConfig(root: string): void {
  const configPath = path.join(root, "config.toml");
  if (!fs.existsSync(configPath)) return;
  const config = fs.readFileSync(configPath, "utf-8");
  fs.writeFileSync(configPath, removeInternalTomlTables(config));
}

export function removeHooksConfig(root: string): void {
  fs.rmSync(path.join(root, "hooks.json"), { force: true });
}

export function buildHookTrustBlock(hooksConfigPath: string, codexHooksSourcePath: string): string {
  return buildCodexHookTrustBlock({
    hooksConfig: JSON.parse(fs.readFileSync(hooksConfigPath, "utf8")),
    codexHooksSourcePath,
  });
}

export function rewriteCodexHookTrustConfig(input: {
  config: string;
  hooksConfig: unknown;
  codexHooksSourcePath: string;
}): string {
  return insertGeneratedHookTrustBlock(
    removeGeneratedHookTrustBlock(ensureHooksFeature(input.config)),
    input.hooksConfig,
    input.codexHooksSourcePath,
  )
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function removeGeneratedHookTrustBlock(config: string): string {
  const blockPattern = new RegExp(
    `\\n?${escapeRegExp(CODEX_HOOK_TRUST_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_HOOK_TRUST_END)}\\n?`,
    "m",
  );
  return config.replace(blockPattern, "\n");
}

function ensureHooksFeature(config: string): string {
  let next = config.replace(/^codex_hooks\s*=\s*true\s*$/m, "hooks = true");
  if (!/^\[features\]\s*$/m.test(next)) return `\n[features]\nhooks = true\n${next}`;
  if (!/^hooks\s*=\s*true\s*$/m.test(next)) {
    next = next.replace(/^(\[features\]\s*)$/m, "$1hooks = true\n");
  }
  return next;
}

function insertGeneratedHookTrustBlock(
  config: string,
  hooksConfig: unknown,
  codexHooksSourcePath: string,
): string {
  const block = `${buildCodexHookTrustBlock({ hooksConfig, codexHooksSourcePath })}\n\n`;
  const pluginsTable = /^\[plugins\.[^\n]+\]\n/m;
  const next = pluginsTable.test(config)
    ? config.replace(pluginsTable, `${block}$&`)
    : `${config.trimEnd()}\n\n${block}`;
  return next;
}

function replaceOrAppendSandboxMode(config: string, mode: string): string {
  if (/^sandbox_mode\s*=\s*"[^"]*"\s*$/m.test(config)) {
    return config.replace(/^sandbox_mode\s*=\s*"[^"]*"\s*$/m, `sandbox_mode = "${mode}"`);
  }
  return `sandbox_mode = "${mode}"\n${config}`;
}

function removeInternalTomlTables(config: string): string {
  const lines = config.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\[(?:mcp_servers|plugins|projects)\./.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return `${kept.join("\n").trimEnd()}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
