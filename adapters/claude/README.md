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

## Hook Entry Points

Hook scripts live under `adapters/claude/hooks/` after build. Each script
reads stdin, calls the canonical `mainXxx` handler from `src/hooks/`, and
relies on the Claude encoder for stdout formatting.

## Settings

`dotclaude/settings.json` contains the `hooks` configuration that Claude Code
reads to register the hook scripts. Paths reference `$AGENT_FRAMEWORK_ROOT`.
