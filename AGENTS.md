# Agent Framework Instructions

Follow the same project rules as `CLAUDE.md`.

This repository is an agent-framework TypeScript project. Prefer `rg` for
search, use `apply_patch` for manual edits, keep adapter-specific behavior in
`adapters/<name>/`, and keep shared hook/rule behavior in `src/`.

When creating or presenting any plan, including ordinary Codex plan mode and
`<proposed_plan>` responses, read and follow `PLANS.md`.

Do not manually create or remove symlinks under `~/.claude` or `~/.codex`.
Those are managed by the NixOS activation script in
`/home/tim/Coding/nixos/services/mcp-toolbox.nix`.
