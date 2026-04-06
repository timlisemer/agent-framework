# Fixtures

Curated real JSONL transcripts for hook replay testing. Transcript files are gitignored — only this README is checked in.

## Transcript Format

Each fixture is a `.jsonl` file — one JSON object per line. Lines follow this structure:

```jsonl
{"type":"permission-mode","permissionMode":"default","sessionId":"70c52a93-..."}
{"type":"file-history-snapshot","messageId":"...","snapshot":{...}}
{"type":"user","message":{"role":"user","content":"Fix the bug in main.ts"},"cwd":"/home/user/project"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"main.ts"}}]}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"const x = 1;\n..."}]}}
```

The first few lines are session metadata (`permission-mode`, `file-history-snapshot`, attachments). The `cwd` field appears in user message lines. Subsequent lines are conversation turns: `user` (containing text or `tool_result` blocks), and `assistant` (containing `tool_use` blocks).

## Adding Fixtures

1. Find the transcript you want. Claude Code stores them at `~/.claude/projects/<project-dir>/<session-id>.jsonl`. The `<project-dir>` is the absolute path with both `/` and `_` replaced by `-` (e.g. `/home/tim/Coding/public_repos/my-project` becomes `-home-tim-Coding-public-repos-my-project`). List recent sessions: `ls -lt ~/.claude/projects/<project-dir>/`.
2. Copy the transcript into `test-harness/fixtures/transcripts/`.
3. **Sanitize the transcript** by editing the JSONL file in a text editor. Individual lines can be long (1000+ characters) — search-and-replace is more practical than eyeballing. For each line:
   - **API keys / tokens** — search for `sk-`, `api_key`, `token`, `secret` and replace values with `REDACTED`
   - **Personal data** — replace private emails, usernames, or repo names with generic values. Public project paths and GitHub usernames are fine to keep
   - **Large blobs** — replace base64 content or huge tool results with `"...truncated..."` (keep JSON structure valid)
   - **Verify validity** after editing: `python3 -c "import json; [json.loads(l) for l in open('fixture.jsonl')]"` — this will throw on any malformed line
4. Run `--list` to identify testable tool calls:
   ```bash
   npx tsx test-harness/run.ts --list test-harness/fixtures/transcripts/<your-file>.jsonl
   ```
5. Document each fixture below with its test scenarios

## Fixture Index

(No fixtures checked in — transcripts are gitignored. Copy one from `~/.claude/projects/` to get started.)
