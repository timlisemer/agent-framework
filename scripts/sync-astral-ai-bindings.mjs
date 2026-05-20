#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function candidateRoots() {
  return [
    argValue("--astral-root"),
    process.env.ASTRAL_ROOT,
    resolve(repoRoot, "../astral"),
    resolve(repoRoot, "../../private_repos/astral"),
  ].filter(Boolean);
}

function findAstralRoot() {
  for (const root of candidateRoots()) {
    const source = resolve(root, "crates/astral-ai-protocol/bindings/ai");
    if (existsSync(source)) return root;
  }
  throw new Error(
    "Could not find Astral AI bindings. Set ASTRAL_ROOT or pass --astral-root /path/to/astral."
  );
}

const astralRoot = findAstralRoot();
const sourceDir = resolve(astralRoot, "crates/astral-ai-protocol/bindings/ai");
const destDir = resolve(repoRoot, "src/ai-protocol/generated");

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
cpSync(sourceDir, destDir, { recursive: true });

for (const file of readdirSync(destDir)) {
  if (!file.endsWith(".ts")) continue;
  const path = resolve(destDir, file);
  const source = readFileSync(path, "utf8").replaceAll(/from "\.\/([^"]+)"/g, "from \"./$1.js\"");
  writeFileSync(path, source);
}
