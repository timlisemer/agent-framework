# Codex Adapter

This adapter integrates agent-framework hooks with Codex CLI.

## Deployment

`dotcodex/config.toml` is intended to be symlinked into
`~/.codex/config.toml` by the NixOS activation script. It owns the
agent-framework Codex feature flags, plugin settings, and MCP server
configuration.

`dotcodex/hooks.json` is intended to be symlinked into `~/.codex/hooks.json`.
`dotcodex/AGENTS.md` is intended to be symlinked into `~/.codex/AGENTS.md`;
it carries the temporary global planning contract for Codex sessions while
Codex hook `suppressOutput` is parsed but not yet applied.
On Linux-only manual deployments, copy the full `dotcodex/` contents into
`~/.codex/` or symlink `config.toml`, `hooks.json`, and `agents/*.toml`
individually. Do not manually create or remove these symlinks on the NixOS
deployment path; the activation script owns them.

`dotcodex/skills/agent-framework-*` contains Codex-native skills
(`$agent-framework-check`, `$agent-framework-commit`,
`$agent-framework-confirm`, `$agent-framework-push`,
`$agent-framework-fullconfirm`, `$agent-framework-quickpush`,
`$agent-framework-quickconfirm`, `$agent-framework-fullquickconfirm`,
`$agent-framework-transcript`,
`$agent-framework-locate-scenario`,
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

Codex planning currently receives the planning contract from `~/.codex/AGENTS.md`
as a temporary global workaround. The hook-based hidden context injection code is
still present but disabled until Codex applies `suppressOutput` to hook output.
The plan skills call `mcp__agent_framework__create_planfile` during
consolidation. That tool resolves the current session through the shared
agent-framework session resolver, writes the named session planfile, and
immediately runs plan validation for the written content. When the MCP call does
not include a transcript path, the resolver uses the latest
`transcript-path.txt` sidecar for the active project.

Codex planfiles live under the agent-framework session `plans/` directory.
The session `current-plan.json` sidecar stores only the active planfile
descriptor, not plan content. Implementation workflows resolve that planfile
path and pass it to implementer and validator agents as `Plan file: <path>`.

Scenario materialization for Codex sessions uses the shared `scenario_tester`
MCP action `materialize_scenario`. The materializer infers Codex from
`/.codex/` transcript paths and parses `response_item` / `event_msg` JSONL
through `adapters/codex/parse-transcript.ts`, including normalized function-call
inputs, before writing the stored scenario.

When Codex stops with a whole-message `<proposed_plan>...</proposed_plan>`, the
Stop hook treats that block as the plan presentation for user acceptance, not
as a separate source of truth. The hook resolves the named session planfile
through the shared planfile locator. Existing populated planfiles are the source
of truth: the hook validates or trusts exact file content instead of
overwriting it from inline transcript text. Missing or empty planfiles keep the
extracted content so the validation remediation workflow has a concrete file to
edit. If the first inline Codex plan has no valid `Plan Name` and the session
has no accepted planfiles yet, the Stop hook derives a session planfile name,
creates that file through the shared creator path, validates it, and blocks
with the created path plus validation feedback.

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
`tool_input.command`. The Codex adapter parses patch headers during
canonicalization and LLM-facing summarization before shared rule hooks see the
canonical `Edit` input.

Codex skill invocations such as `$agent-framework-commit` are treated as
workflow authorization for the restricted agent-framework MCP tools in the
same way Claude's `<command-name>/commit</command-name>` slash-command tag is.
