import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { logToHomeAssistant } from './logger.js';

export interface AgentQueryResult {
  success: boolean;
  output: string;
  messageTypes: string[];
}

export async function runAgentQuery(
  agentName: string,
  prompt: string,
  options: Options
): Promise<AgentQueryResult> {
  let output = '';
  let assistantText = '';
  const messageTypes: string[] = [];

  try {
    const q = query({ prompt, options });

    for await (const message of q) {
      const subtype = 'subtype' in message ? message.subtype : 'none';
      messageTypes.push(`${message.type}:${subtype}`);

      // Capture text from assistant messages as fallback
      if (message.type === 'assistant' && 'message' in message) {
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (typeof content === 'string') {
          assistantText = content;
        } else if (Array.isArray(content)) {
          const textBlocks = content
            .filter((b): b is { type: 'text'; text: string } =>
              typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string'
            )
            .map(b => b.text);
          if (textBlocks.length > 0) {
            assistantText = textBlocks.join('\n');
          }
        }
      }

      if (message.type === 'result' && subtype === 'success') {
        output = (message as { result: string }).result;
      }
    }

    // Fall back to last assistant message if result.result is empty
    const finalOutput = output.trim() || assistantText.trim();

    if (!finalOutput) {
      const error = `ERROR: ${agentName} agent returned no output. Message types received: [${messageTypes.join(', ')}]`;
      logToHomeAssistant({
        agent: agentName,
        level: 'error',
        problem: 'Empty output',
        answer: error,
      });
      return { success: false, output: error, messageTypes };
    }

    return { success: true, output: finalOutput, messageTypes };
  } catch (err) {
    const error = `ERROR: ${agentName} agent threw exception: ${err instanceof Error ? err.message : String(err)}`;
    logToHomeAssistant({
      agent: agentName,
      level: 'error',
      problem: 'Exception',
      answer: error,
    });
    return { success: false, output: error, messageTypes };
  }
}
