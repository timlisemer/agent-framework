# Agent Framework Instructions

Follow the same project rules as `CLAUDE.md`.

This repository is an agent-framework TypeScript project. Prefer `rg` for
search, use `apply_patch` for manual edits, keep adapter-specific behavior in
`adapters/<name>/`, and keep shared hook/rule behavior in `src/`.

Final plans are named planfiles. Claude uses its native planfile; Codex and
future non-native adapters use session planfiles under
`~/.agent-framework/.../plans/`.

Captured scenarios should be materialized through the `scenario_tester` MCP
action `materialize_scenario`, not through ad-hoc `node -e` snippets. Pass the
canonical `run_id`; the materializer reads the accepted commands, records,
snapshot state, and linked artifacts from that run's journal-backed storage.

Do not manually create or remove symlinks under `~/.claude` or `~/.codex`.
Those are managed by the NixOS activation script in
`/home/tim/Coding/nixos/services/mcp-toolbox.nix`.
