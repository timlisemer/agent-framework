import type { ToolPrediction } from "./prediction-schema.js";
import type { ToolLogEntry } from "./tool-log-types.js";

export interface FulfillmentEvidence {
  tool: string;
  ts: number;
  cmd?: string;
  path?: string;
}

export interface IntentFulfillmentSignal {
  intent: string;
  matchedKeywords: string[];
  evidence: FulfillmentEvidence[];
  predictionTimestamp: number;
}

// Narrow, verb/noun-rooted regex map. Mirrors the morphology-regex style
// in src/utils/prediction-types.ts (UNDO_INTENT_RE etc.).
// Each entry: an intent-text regex paired with a tool-log predicate that
// satisfies it. Add entries as new fixtures expose new fulfillment shapes.
const INTENT_FULFILLMENT_VOCABS: Array<{
  intentRe: RegExp;
  toolMatches: (entry: ToolLogEntry) => boolean;
  label: string;
}> = [
  {
    intentRe: /\b(validator|validation)s?\b/i,
    toolMatches: (e) => (e.tool === "Task" || e.tool === "Agent") && e.status === "allowed",
    label: "validator/validation agents",
  },
  {
    intentRe: /\bplan(?:ning)?\s+agents?\b/i,
    toolMatches: (e) => (e.tool === "Task" || e.tool === "Agent") && e.status === "allowed",
    label: "plan agents",
  },
  {
    intentRe: /\b(spawn|launch|run|start|invoke|another\s+round\s+of)\s+(?:\w+\s+)?(?:sub-?)?agents?\b/i,
    toolMatches: (e) => (e.tool === "Task" || e.tool === "Agent") && e.status === "allowed",
    label: "agent dispatch",
  },
];

export function detectIntentFulfillment(
  prediction: ToolPrediction,
  toolLog: readonly ToolLogEntry[],
): IntentFulfillmentSignal | null {
  if (!prediction.intent) return null;
  if (toolLog.length === 0) return null;
  const cutoff = prediction.timestamp;
  const after = toolLog.filter((e) => e.ts > cutoff);
  if (after.length === 0) return null;

  const matchedKeywords: string[] = [];
  const evidence: FulfillmentEvidence[] = [];
  for (const v of INTENT_FULFILLMENT_VOCABS) {
    if (!v.intentRe.test(prediction.intent)) continue;
    const hits = after.filter(v.toolMatches);
    if (hits.length === 0) continue;
    matchedKeywords.push(v.label);
    for (const h of hits) {
      const ev: FulfillmentEvidence = { tool: h.tool, ts: h.ts };
      if (h.cmd) ev.cmd = h.cmd;
      if (h.path) ev.path = h.path;
      if (!evidence.some((e) => e.tool === ev.tool && e.ts === ev.ts)) evidence.push(ev);
    }
  }

  if (matchedKeywords.length === 0) return null;
  return { intent: prediction.intent, matchedKeywords, evidence, predictionTimestamp: cutoff };
}

/** Apply the canonical recent-history window before fulfillment detection. */
export function detectRecentIntentFulfillment(
  prediction: ToolPrediction,
  toolLog: readonly ToolLogEntry[],
): IntentFulfillmentSignal | null {
  return detectIntentFulfillment(prediction, toolLog.slice(-50));
}

export function formatIntentFulfillment(s: IntentFulfillmentSignal): string {
  const lines: string[] = [
    `=== INTENT FULFILLMENT ===`,
    `The cached PREDICTIONS intent ("${s.intent.slice(0, 200)}") appears already fulfilled by tool calls completed AFTER the prediction was set:`,
  ];
  for (const e of s.evidence.slice(0, 8)) {
    const when = new Date(e.ts).toISOString();
    const detail = e.cmd ? ` cmd="${e.cmd.slice(0, 80)}"` : e.path ? ` path="${e.path.slice(0, 80)}"` : "";
    lines.push(`  - ${when}: ${e.tool}${detail} (allowed)`);
  }
  lines.push(
    `Matched intent keyword(s): ${s.matchedKeywords.join(", ")}.`,
    `The user's stated request from PREDICTIONS therefore appears served. The session has progressed to a new step where the appropriate toolset has shifted. Evaluate the firing tool as a candidate next step rather than as a contradiction of the (now-fulfilled) cached intent.`,
    `=== END INTENT FULFILLMENT ===`,
  );
  return lines.join("\n");
}
