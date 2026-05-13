import Anthropic from "@anthropic-ai/sdk";
import AgentKeepAlive from "agentkeepalive";
import { extractTextFromResponse } from "../utils/response-parser.js";
import { isCancellationError } from "../utils/cancellation.js";
import type { ProviderExecutionResult, ProviderRunInput } from "./execution-types.js";

const httpsAgent = new AgentKeepAlive.HttpsAgent({
  keepAlive: true,
  freeSocketTimeout: 30_000,
  socketActiveTTL: 120_000,
});

function createOpenRouterAnthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 1,
    httpAgent: httpsAgent,
    defaultHeaders: {
      "X-Title": "timlisemer/agent-framework",
      "HTTP-Referer": "https://github.com/timlisemer/agent-framework",
    },
  });
}

export async function runAnthropicApiSkinDirect(
  input: ProviderRunInput
): Promise<ProviderExecutionResult> {
  const { config, prompt, resolvedProvider, options } = input;

  try {
    const response = await createOpenRouterAnthropicClient().messages.create({
      model: resolvedProvider.modelId,
      max_tokens: config.maxTokens ?? 2000,
      system: config.systemPrompt,
      messages: [{ role: "user", content: prompt }],
      // OpenRouter: request usage/cost data in response.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ usage: { include: true } } as any),
    }, {
      maxRetries: 0,
      signal: options.signal,
    });

    const rawUsage = (response as unknown as { usage?: Record<string, unknown> })
      .usage as Record<string, unknown> | undefined;
    const promptTokens = (rawUsage?.prompt_tokens ?? rawUsage?.input_tokens) as number | undefined;
    const completionTokens = (rawUsage?.completion_tokens ?? rawUsage?.output_tokens) as number | undefined;
    const cachedTokens = (rawUsage?.cache_read_input_tokens as number | undefined) ??
      (rawUsage?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens as number | undefined;
    const reasoningTokens = (rawUsage?.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens as number | undefined;
    const cost = rawUsage?.cost as number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationId = (response as any).id as string | undefined;

    return {
      text: extractTextFromResponse(response),
      usage: rawUsage ? {
        promptTokens,
        completionTokens,
        totalTokens: (rawUsage.total_tokens as number | undefined) ??
          (promptTokens && completionTokens ? promptTokens + completionTokens : undefined),
        cachedTokens: cachedTokens || undefined,
        reasoningTokens: reasoningTokens || undefined,
        cost,
      } : undefined,
      generationId,
      provider: resolvedProvider.type,
      modelName: resolvedProvider.modelId,
    };
  } catch (error) {
    if (isCancellationError(error)) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      text: `[DIRECT ERROR] ${errorMessage}`,
      provider: resolvedProvider.type,
      modelName: resolvedProvider.modelId,
    };
  }
}

