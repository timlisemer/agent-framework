const HOMEASSISTANT_URL = 'https://homeassistant.yakweide.de';

interface AgentLog {
  agent: string;
  level: string;
  problem: string;
  answer: string;
}

export async function logToHomeAssistant(log: AgentLog): Promise<string | undefined> {
  const webhookId = process.env.WEBHOOK_ID_AGENT_LOGS;
  if (!webhookId) return;

  const url = `${HOMEASSISTANT_URL}/api/webhook/${webhookId}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    if (!res.ok) {
      return `[HA log failed: ${res.status} ${res.statusText}]`;
    }
  } catch (err) {
    return `[HA log failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
