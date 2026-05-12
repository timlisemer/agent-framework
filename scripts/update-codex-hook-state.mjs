#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const configPath = path.join(repoRoot, "adapters/codex/dotcodex/config.toml");
const hooksPath = path.join(repoRoot, "adapters/codex/dotcodex/hooks.json");
const codexHooksSourcePath = process.env.CODEX_HOOKS_SOURCE_PATH ?? "/home/tim/.codex/hooks.json";
const beginMarker = "# BEGIN GENERATED CODEX HOOK TRUST STATE";
const endMarker = "# END GENERATED CODEX HOOK TRUST STATE";

const eventNames = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
};

const matcherEvents = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
]);

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }

  return value;
}

function currentHash(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function hookIdentity(eventName, group, hook) {
  const identity = {
    event_name: eventNames[eventName],
    hooks: [
      {
        type: hook.type,
        command: hook.command,
        timeout: Math.max(hook.timeout ?? 600, 1),
        async: hook.async ?? false,
      },
    ],
  };

  if (matcherEvents.has(eventName) && group.matcher !== undefined) {
    identity.matcher = group.matcher;
  }

  if (hook.statusMessage !== undefined) {
    identity.hooks[0].statusMessage = hook.statusMessage;
  }

  return identity;
}

function buildHookStateBlock() {
  const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const lines = [
    beginMarker,
    "# Codex only runs unmanaged hooks after their current definition has been",
    "# reviewed. These entries are generated from adapters/codex/dotcodex/hooks.json.",
    "# Regenerate them with `just build` after changing Codex hook commands.",
  ];

  for (const [eventName, eventGroups] of Object.entries(hooksConfig.hooks ?? {})) {
    const codexEventName = eventNames[eventName];
    if (!codexEventName || !Array.isArray(eventGroups)) {
      continue;
    }

    for (const [groupIndex, group] of eventGroups.entries()) {
      for (const [hookIndex, hook] of (group.hooks ?? []).entries()) {
        const key = `${codexHooksSourcePath}:${codexEventName}:${groupIndex}:${hookIndex}`;
        lines.push("");
        lines.push(`[hooks.state."${key}"]`);
        lines.push("enabled = true");
        lines.push(`trusted_hash = "${currentHash(hookIdentity(eventName, group, hook))}"`);
      }
    }
  }

  lines.push(endMarker);
  return lines.join("\n");
}

function removeGeneratedBlock(config) {
  const blockPattern = new RegExp(
    `\\n?${beginMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
    "m",
  );

  return config.replace(blockPattern, "\n");
}

function ensureHooksFeature(config) {
  let next = config.replace(/^codex_hooks\s*=\s*true\s*$/m, "hooks = true");

  if (!/^\[features\]\s*$/m.test(next)) {
    return `\n[features]\nhooks = true\n${next}`;
  }

  if (!/^hooks\s*=\s*true\s*$/m.test(next)) {
    next = next.replace(/^(\[features\]\s*)$/m, "$1hooks = true\n");
  }

  return next;
}

function insertGeneratedBlock(config) {
  const block = `${buildHookStateBlock()}\n\n`;
  const pluginsTable = /^\[plugins\.[^\n]+\]\n/m;

  if (!pluginsTable.test(config)) {
    return `${config.trimEnd()}\n\n${block}`;
  }

  return config.replace(pluginsTable, `${block}$&`);
}

const updatedConfig = insertGeneratedBlock(
  removeGeneratedBlock(ensureHooksFeature(fs.readFileSync(configPath, "utf8"))),
)
  .replace(/\n{3,}/g, "\n\n")
  .trimEnd();

fs.writeFileSync(configPath, `${updatedConfig}\n`);
