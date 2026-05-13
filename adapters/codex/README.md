# Codex Adapter

This adapter integrates agent-framework hooks with Codex CLI.

## Deployment

`dotcodex/config.toml` is intended to be symlinked into
`~/.codex/config.toml` by the NixOS activation script. It owns the
agent-framework Codex feature flags, plugin settings, and MCP server
configuration.

`dotcodex/hooks.json` is intended to be symlinked into `~/.codex/hooks.json`.
On Linux-only manual deployments, copy the full `dotcodex/` contents into
`~/.codex/` or symlink `config.toml`, `hooks.json`, and `agents/*.toml`
individually. Do not manually create or remove these symlinks on the NixOS
deployment path; the activation script owns them.

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

## Codex Hook Trust Hashes

Codex requires unmanaged hooks to be reviewed before they run. The review state
is stored in `dotcodex/config.toml` as generated `[hooks.state]` entries with a
`trusted_hash` for each hook command definition. These hashes are not secrets;
they fingerprint the event, matcher, command, timeout, async flag, and status
message from `dotcodex/hooks.json`.

Run `just build` from the repo root after changing Codex hook commands. The
build runs `scripts/update-codex-hook-state.mjs`, regenerates the trust hashes,
and keeps the generated block in `dotcodex/config.toml` in sync with
`dotcodex/hooks.json`.

Codex planning receives the planning contract as foreground session context
when a session enters plan mode. The plan skills present final inline
`<proposed_plan>` output from the foreground session; spawned planning and
validation agents do not receive separate planning-contract instructions.

Codex plans are inline `<proposed_plan>...</proposed_plan>` blocks, not
temporary plan files. The Stop hook validates a complete inline proposed plan
before it is presented and stores the validated content in the session
`current-plan.json` sidecar. When Codex later submits `Implement the plan.` or
the clear-context implementation prompt, `UserPromptSubmit` validates the
stored or embedded plan again before allowing implementation state to begin.

`dotcodex/agents/*.toml` contains Codex custom-agent equivalents for the
Claude subagent roles. The NixOS activation script links these as individual
files under `~/.codex/agents/`.

## Current Codex Hook Limits

Codex `PreToolUse` can intercept Bash, `apply_patch`, and MCP tool calls, but
it is not a complete enforcement boundary. The adapter also registers
`PermissionRequest`, `PostToolUse`, and `Stop` hooks so approval prompts and
post-tool feedback still pass through the framework where Codex exposes them.

For Bash, the shared policy keeps authorization and safety separate. If the
latest user message already implies Bash, the Codex hook should not require a
second permission request solely because the command head is outside the
prediction-block read-only classifier. Deterministic blacklist checks and final
tool approval still decide whether the specific command is safe and relevant.

`apply_patch` arrives as `tool_name: "apply_patch"` with the patch in
`tool_input.command`; the shared rules parse patch headers to recover edited
paths.

Codex skill invocations such as `$agent-framework-commit` are treated as
workflow authorization for the restricted agent-framework MCP tools in the
same way Claude's `<command-name>/commit</command-name>` slash-command tag is.
