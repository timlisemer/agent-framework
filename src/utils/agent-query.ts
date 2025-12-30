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
  const messageTypes: string[] = [];

  try {
    const q = query({ prompt, options });

    for await (const message of q) {
      const subtype = 'subtype' in message ? message.subtype : 'none';
      messageTypes.push(`${message.type}:${subtype}`);

      if (message.type === 'result' && subtype === 'success') {
        output = (message as { result: string }).result;
      }
    }

    if (!output.trim()) {
      const error = `ERROR: ${agentName} agent returned no output. Message types received: [${messageTypes.join(', ')}]`;
      logToHomeAssistant({
        agent: agentName,
        level: 'error',
        problem: 'Empty output',
        answer: error,
      });
      return { success: false, output: error, messageTypes };
    }

    return { success: true, output: output.trim(), messageTypes };
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
