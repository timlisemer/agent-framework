# Codex Adapter

This adapter integrates agent-framework hooks with Codex CLI.

## Symlink Instructions (NixOS)

`dotcodex/config.toml` is intended to be symlinked into
`~/.codex/config.toml` by the NixOS activation script. It owns the
agent-framework Codex feature flags, plugin settings, and MCP server
configuration.

`dotcodex/hooks.json` is intended to be symlinked into `~/.codex/hooks.json`.
Do not create these symlinks manually in normal deployments.

`dotcodex/skills/agent-framework-*` contains Codex-native skills
(`$agent-framework-check`, `$agent-framework-commit`,
`$agent-framework-confirm`, `$agent-framework-push`,
`$agent-framework-quickpush`, `$agent-framework-transcript`,
`$agent-framework-plan1`, `$agent-framework-plan3`,
`$agent-framework-plan5`, and `$agent-framework-implement`). These mirror
the Claude slash-command workflows. The NixOS activation script creates real directories under
`~/.codex/skills/` and copies each `SKILL.md` into place. Do not symlink these
skill directories: Codex skill discovery does not follow symlinked skill
directories reliably. Existing user and system skills remain intact.

`dotcodex/agents/*.toml` contains Codex custom-agent equivalents for the
Claude subagent roles. The NixOS activation script links these as individual
files under `~/.codex/agents/`.

## Current Codex Hook Limits

Codex `PreToolUse` can intercept Bash, `apply_patch`, and MCP tool calls, but
it is not a complete enforcement boundary. The adapter also registers
`PermissionRequest`, `PostToolUse`, and `Stop` hooks so approval prompts and
post-tool feedback still pass through the framework where Codex exposes them.

`apply_patch` arrives as `tool_name: "apply_patch"` with the patch in
`tool_input.command`; the shared rules parse patch headers to recover edited
paths.

Codex skill invocations such as `$agent-framework-commit` are treated as
workflow authorization for the restricted agent-framework MCP tools in the
same way Claude's `<command-name>/commit</command-name>` slash-command tag is.
