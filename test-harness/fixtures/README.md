# Fixtures — Transcript Format

Reference for the JSONL transcript format used by the replay harness. Transcripts are read directly from `~/.claude/projects/<project>/*.jsonl` — do not copy or curate transcripts into this directory.

## Line Types

Each `.jsonl` file has one JSON object per line. The `type` field determines the line type:

- `permission-mode` — session permission config (no `cwd` field)
- `file-history-snapshot` — file state at session start
- `attachment` — attached files/images
- `system` — system messages
- `user` — user messages (real prompts or tool results)
- `assistant` — assistant responses (may contain tool_use blocks)

## Identifying Content

**User prompts vs tool results**: User messages (`type:"user"`) with string `message.content` are real prompts. User messages with array content containing `{type:"tool_result"}` blocks are tool returns.

**System-injected messages**: User messages with `isMeta:true` are system-injected, not real user input. These are skipped during replay.

**tool_use blocks**: Found in `type:"assistant"` lines. Look in `message.content` array for `{type:"tool_use", id:"toolu_...", name:"...", input:{...}}`. The `id` field is the tool_use_id used in expectations.

**Stop points**: `type:"assistant"` lines with `message.stop_reason:"end_turn"` and no tool_use blocks in content.

**tool_result content**: The `content` field on tool_result blocks can be a string, an array of text blocks, or tool_reference blocks. All formats are handled by the replay harness.

## Main Session vs Subagent Transcripts

Only use **main session transcripts** — the `{session-uuid}.jsonl` files at the top level of the project directory. Do not use subagent transcripts (`subagents/agent-{id}.jsonl`), which have `isSidechain: true` and `agentId` metadata fields.
