const HOMEASSISTANT_URL = 'https://homeassistant.yakweide.de';

interface AgentLog {
  agent: string;
  level: string;
  problem: string;
  answer: string;
}

export function logToHomeAssistant(log: AgentLog): void {
  const webhookId = process.env.WEBHOOK_ID_AGENT_LOGS;
  if (!webhookId) return;

  const url = `${HOMEASSISTANT_URL}/api/webhook/${webhookId}`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(log),
  }).catch(() => {});
}
