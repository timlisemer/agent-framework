import fs from "node:fs";
import path from "node:path";
import { removeHookByName } from "../shared/runtime-home-settings.js";
import { readJson, writeJson } from "../../src/utils/file-io.js";
import { isPathAtOrInside } from "../../src/utils/path-containment.js";

export const CLAUDE_AUTH_FILES = [
  ".credentials.json",
  "credentials.json",
  "settings.local.json",
  "claude.json",
] as const;

export const CLAUDE_DURABLE_MANAGED_ENTRIES = ["projects"] as const;

export function dotRoot(adapterRoot: string): string {
  return path.join(adapterRoot, "dotclaude");
}

export function applyRuntimeEnv(env: NodeJS.ProcessEnv, root: string | null): NodeJS.ProcessEnv {
  return root
    ? { ...env, CLAUDE_CONFIG_DIR: root, CLAUDE_HOME: root }
    : env;
}

export function resolveNativeRoot(input: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  managedRoot: string;
}): string {
  const configured = input.env.CLAUDE_CONFIG_DIR ?? input.env.CLAUDE_HOME;
  const root = configured && path.resolve(configured);
  return root && !isPathAtOrInside(root, input.managedRoot)
    ? root
    : path.join(input.homeDir, ".claude");
}

export function removeMcpServerConfig(root: string): void {
  mutateSettingsFiles(root, ["settings.json"], (settings) => {
    delete settings.mcpServers;
  });
  mutateSettingsFiles(root, ["settings.local.json"], (settings) => {
    delete settings.mcpServers;
  });
}

export function removeHooksConfig(root: string): void {
  mutateSettingsFiles(root, ["settings.json", "settings.local.json"], (settings) => {
    delete settings.hooks;
    delete settings.statusLine;
  });
}

export function sanitizeLocalSettings(root: string): void {
  mutateSettingsFiles(root, ["settings.local.json"], (settings) => {
    delete settings.mcpServers;
    delete settings.hooks;
    delete settings.statusLine;
  });
}

export function removeStopHookFromSettings(root: string): void {
  mutateSettingsFiles(root, ["settings.json", "settings.local.json"], (settings) => {
    removeHookByName(settings, "Stop");
  });
}

function mutateSettingsFiles(
  root: string,
  names: readonly string[],
  mutator: (settings: Record<string, unknown>) => void,
): void {
  for (const name of names) {
    const settingsPath = path.join(root, name);
    if (!fs.existsSync(settingsPath)) continue;
    const settings = readJson<Record<string, unknown>>(settingsPath);
    mutator(settings);
    writeJson(settingsPath, settings);
  }
}
