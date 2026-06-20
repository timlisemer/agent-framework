# OpenAI Subscription Provider

Provider id: `openai-subscription`

This provider uses the OpenAI Codex SDK runtime with ChatGPT/Codex sign-in credentials. It does not use a normal OpenAI API-compatible token and does not make OpenAI API billing calls.

Model mapping:

| Tier | Model |
| --- | --- |
| `haiku` | `gpt-5.4-mini` |
| `sonnet` | `gpt-5.5` |
| `opus` | `gpt-5.5` with `xhigh` reasoning |

Recommended config:

```bash
export AGENT_FRAMEWORK_PROVIDER=openai-subscription
```

Official references:

- Using Codex with your ChatGPT plan: https://help.openai.com/en/articles/11369540
- Codex CLI and Sign in with ChatGPT: https://help.openai.com/en/articles/11381614-codex-cli-and-sign-in-withgpt
- Codex CLI repository: https://github.com/openai/codex
- Codex SDK package: https://www.npmjs.com/package/@openai/codex-sdk

Compliance stance:

- OpenAI documents Codex as included with ChatGPT plans and documents Codex local use through CLI/IDE/app workflows.
- This provider is intentionally narrow: it drives the official Codex SDK runtime using local Codex credentials. It is not a generic ChatGPT subscription to OpenAI API adapter.
- Business, Enterprise, Edu, and API data/billing terms differ from individual ChatGPT plans. Use the appropriate plan for organization or commercial use.

Silence/session behavior:

- In isolated runtime sessions, agent-framework creates a temporary `CODEX_HOME`, copies only `auth.json` when present, and sets history persistence to `none` for one-shot calls.
- In native user-runtime sessions, agent-framework leaves the normal Codex home/config in place instead of creating a temporary `CODEX_HOME`.
- In managed Astral user-runtime sessions (`sdkRuntimeHome: "managedAstral"`), agent-framework copies top-level Codex auth into `~/.agent-framework/astral-ai/codex`, sets `CODEX_HOME` to that managed home, and uses it for session history listing/resume.
- Opt-in continuable SDK sessions keep a live Codex thread until the owning session is disposed.
- It deletes `OPENAI_API_KEY`, `CODEX_API_KEY`, OpenRouter, and Anthropic API environment variables for this provider so Codex uses ChatGPT/Codex sign-in rather than API billing.
