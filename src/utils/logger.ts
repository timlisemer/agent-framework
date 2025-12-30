const HOMEASSISTANT_URL = 'https://homeassistant.yakweide.de';

interface AgentLog {
  agent: string;
  level: string;
  problem: string;
  answer: string;
}

// Track if we've already warned about missing webhook ID
let warnedMissingWebhook = false;

export async function logToHomeAssistant(log: AgentLog): Promise<void> {
  const webhookId = process.env.WEBHOOK_ID_AGENT_LOGS;
  if (!webhookId) {
    if (!warnedMissingWebhook) {
      console.error('[Agent logs] WEBHOOK_ID_AGENT_LOGS not set - logging disabled');
      warnedMissingWebhook = true;
    }
    return;
  }

  const url = `${HOMEASSISTANT_URL}/api/webhook/${webhookId}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    if (!res.ok) {
      console.error(`[Agent logs] Failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error(`[Agent logs] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
