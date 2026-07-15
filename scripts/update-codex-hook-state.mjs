#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { rewriteCodexHookTrustConfig } from "../dist/adapters/codex/runtime-home.js";
import { CODEX_HOOKS_CONFIG } from "../dist/adapters/codex/hook-config.js";

const repoRoot = process.cwd();
const configPath = path.join(repoRoot, "adapters/codex/dotcodex/config.toml");
const hooksPath = path.join(repoRoot, "adapters/codex/dotcodex/hooks.json");
const codexHooksSourcePath = process.env.CODEX_HOOKS_SOURCE_PATH ?? "/home/tim/.codex/hooks.json";

fs.writeFileSync(hooksPath, `${JSON.stringify(CODEX_HOOKS_CONFIG, null, 2)}\n`);

const updatedConfig = rewriteCodexHookTrustConfig({
  config: fs.readFileSync(configPath, "utf8"),
  hooksConfig: CODEX_HOOKS_CONFIG,
  codexHooksSourcePath,
});

fs.writeFileSync(configPath, `${updatedConfig}\n`);
