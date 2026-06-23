#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { rewriteCodexHookTrustConfig } from "../dist/adapters/codex/runtime-home.js";

const repoRoot = process.cwd();
const configPath = path.join(repoRoot, "adapters/codex/dotcodex/config.toml");
const hooksPath = path.join(repoRoot, "adapters/codex/dotcodex/hooks.json");
const codexHooksSourcePath = process.env.CODEX_HOOKS_SOURCE_PATH ?? "/home/tim/.codex/hooks.json";

const updatedConfig = rewriteCodexHookTrustConfig({
  config: fs.readFileSync(configPath, "utf8"),
  hooksConfig: JSON.parse(fs.readFileSync(hooksPath, "utf8")),
  codexHooksSourcePath,
});

fs.writeFileSync(configPath, `${updatedConfig}\n`);
