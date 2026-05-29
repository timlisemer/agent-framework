# Claude Adapter

This adapter integrates agent-framework hooks with Claude Code.

## Symlink Instructions (NixOS)

The `dotclaude/` directory contains files that Claude Code expects under
`~/.claude/`. On NixOS these symlinks are managed declaratively — the user
updates their NixOS configuration and runs `nixos-rebuild switch`. The
implementer must never run `ln` manually.

For a Linux-only manual deployment outside NixOS, either copy the dotfolder
contents:

```bash
mkdir -p ~/.claude
cp -a adapters/claude/dotclaude/. ~/.claude/
```

or symlink the settings file:

```bash
mkdir -p ~/.claude
ln -sfn "$PWD/adapters/claude/dotclaude/settings.json" ~/.claude/settings.json
```

Claude does not need Codex-style hook trust hashes; `settings.json` directly
declares the hook commands.

Build-then-rebuild ordering:

1. `just build` — compile TypeScript to `dist/`
2. NixOS rebuild — activates the new symlinks pointing into `dist/`

## Claude-Specific Quirks

- **assistant_split**: Claude Code sometimes writes one assistant message
  as multiple JSONL lines that share the same `message.id`. The scenario
  runner handles this via `role: "assistant_split"` entries.
- **isMeta**: System-injected user messages (slash-command bodies,
  stop-hook feedback) carry `isMeta: true`. Rules like `respond-first` skip
  meta messages.
- **permission_mode enum**: `"default" | "plan" | "acceptEdits" |
  "bypassPermissions" | "dontAsk"`. Plan mode (`"plan"`) suppresses most
  write rules.
- **plan-file root**: Plan files live under `~/.claude/plans/`. The scenario
  runner redirects writes to a temp dir via `AGENT_FRAMEWORK_PLAN_DIR`.
- **named planfiles**: Final plans must start with `Plan Name: <name>` and end
  with `Planfile Path: <path>` followed by the same `Plan Name`.
- **plan creation**: `/plan1`, `/plan3`, and `/plan5` call
  `mcp__agent-framework__create_planfile` during consolidation. The tool
  resolves the current session planfile path, writes the file, normalizes the
  header/footer, and returns the validation result.

## Hook Entry Points

Hook scripts live under `adapters/claude/hooks/` after build. Each script
reads stdin, calls the canonical `mainXxx` handler from `src/hooks/`, and
relies on the Claude encoder for stdout formatting.

## Settings

`dotclaude/settings.json` contains the `hooks` configuration that Claude Code
reads to register the hook scripts. Paths reference `$AGENT_FRAMEWORK_ROOT`.
It also sets Claude Code MCP client environment overrides that belong with the
Claude dotfolder configuration. In particular, it sets:

```json
"env": {
  "MCP_TOOL_TIMEOUT": "2147483647"
}
```

`MCP_TOOL_TIMEOUT` controls Claude Code's MCP tool execution timeout. It is set
to the largest practical value here so the host timeout does not race
agent-framework's own timeout system. Do not add a timeout flag to
`claude mcp add`; that command only registers the MCP server command.

## MCP Server Registration

The Claude adapter does not include a checked-in MCP server config file.
Claude Code MCP servers are registered by the user or project through
`claude mcp add` or `--mcp-config`, while `dotclaude/settings.json` only covers
hooks, commands, agents, and Claude Code environment settings such as
`MCP_TOOL_TIMEOUT`. Agent-framework MCP timeout policy still lives in shared
server code (`src/mcp/server.ts` and `src/mcp/timeout.ts`) rather than in the
Claude adapter; the Claude setting only disables the host-side tool timeout.
