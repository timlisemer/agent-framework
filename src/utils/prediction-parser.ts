/**
 * Prediction Parser - Strict marker-section parser for SENTIMENT_AGENT output.
 *
 * Parses the agent's `---SECTION---`-delimited output into a partial
 * `ToolPrediction` (without `userMessageSnippet`/`timestamp`). Returns null
 * on garbage so the caller can fall back to leaving the previous prediction
 * intact.
 *
 * @module prediction-parser
 */

import type { Mood, ToolPrediction, Trust } from "./prediction-types.js";

const VALID_MOODS: ReadonlySet<Mood> = new Set([
  "angry",
  "frustrated",
  "neutral",
  "satisfied",
  "happy",
]);

const VALID_TRUSTS: ReadonlySet<Trust> = new Set(["low", "normal", "high"]);

type ParsedPrediction = Omit<ToolPrediction, "userMessageSnippet" | "timestamp">;

/**
 * Extract the contents between two marker lines, exclusive. Returns null
 * when either marker is missing.
 */
function extractSection(raw: string, marker: string, nextMarker?: string): string | null {
  const startIdx = raw.indexOf(marker);
  if (startIdx === -1) return null;
  const afterMarker = startIdx + marker.length;
  const endIdx = nextMarker ? raw.indexOf(nextMarker, afterMarker) : -1;
  const slice = endIdx === -1 ? raw.slice(afterMarker) : raw.slice(afterMarker, endIdx);
  return slice.trim();
}

/**
 * Parse the SENTIMENT_AGENT's marker-formatted output. Returns the partial
 * prediction or null on any structural problem (missing markers, invalid
 * mood/trust enum). Caller fills in `userMessageSnippet` and `timestamp`.
 */
export function parseSentimentOutput(raw: string): ParsedPrediction | null {
  if (!raw || typeof raw !== "string") return null;

  const moodRaw = extractSection(raw, "---MOOD---", "---TRUST---");
  const trustRaw = extractSection(raw, "---TRUST---", "---INTENT---");
  const intentRaw = extractSection(raw, "---INTENT---", "---BLOCKED-INTENT---");
  const blockedIntentRaw = extractSection(
    raw,
    "---BLOCKED-INTENT---",
    "---EXPLICITLY-ALLOWED-TOOLS---",
  );
  const allowedRaw = extractSection(
    raw,
    "---EXPLICITLY-ALLOWED-TOOLS---",
    "---EXPLICITLY-BLOCKED---",
  );
  const blockedRaw = extractSection(raw, "---EXPLICITLY-BLOCKED---", "---CONTEXT-SWITCH---");

  if (
    moodRaw === null ||
    trustRaw === null ||
    intentRaw === null ||
    blockedIntentRaw === null ||
    allowedRaw === null ||
    blockedRaw === null
  ) {
    return null;
  }

  const mood = moodRaw.toLowerCase().trim() as Mood;
  if (!VALID_MOODS.has(mood)) return null;

  const trust = trustRaw.toLowerCase().trim() as Trust;
  if (!VALID_TRUSTS.has(trust)) return null;

  const intent = intentRaw.trim();
  const intentLower = intent.toLowerCase();
  if (intent.length === 0 || intentLower === "(none)" || intentLower === "unclear") {
    return null;
  }
  const blockedIntent =
    blockedIntentRaw.trim().toLowerCase() === "(none)" ? "" : blockedIntentRaw.trim();

  const explicitlyAllowedTools = parseAllowedTools(allowedRaw);
  const explicitlyBlockedSubstrings = parseBlockedEntries(blockedRaw);

  // The trailing sections parse leniently — defaults on missing/malformed.
  // The strict 6-section null-fail check above preserves the original fail-safe;
  // these trailing sections do NOT fail the parse if absent.
  const switchRaw = extractSection(raw, "---CONTEXT-SWITCH---", "---QUESTION-IS-STALLING---");
  const stallingRaw = extractSection(raw, "---QUESTION-IS-STALLING---", "---BLOCK-ALL-TOOLS---");
  const blockAllRaw = extractSection(raw, "---BLOCK-ALL-TOOLS---");
  const contextSwitch: "yes" | "no" = switchRaw?.trim() === "yes" ? "yes" : "no";
  const questionIsStalling: "yes" | "no" | "n/a" =
    stallingRaw?.trim() === "yes"
      ? "yes"
      : stallingRaw?.trim() === "no"
        ? "no"
        : "n/a";
  const blockAllTools = blockAllRaw?.trim().toLowerCase() === "yes";

  return {
    mood,
    trust,
    intent,
    blockedIntent,
    explicitlyAllowedTools,
    explicitlyBlockedSubstrings,
    blockAllTools,
    contextSwitch,
    questionIsStalling,
  };
}

function parseAllowedTools(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "(none)") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBlockedEntries(
  raw: string,
): Array<{ tool: string; targetSubstring?: string; reason: string }> {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "(none)") return [];
  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const out: Array<{ tool: string; targetSubstring?: string; reason: string }> = [];
  for (const line of lines) {
    if (line.toLowerCase() === "(none)") continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;
    const tool = parts[0];
    const targetSubstring = parts[1].length > 0 ? parts[1] : undefined;
    const reason = parts.slice(2).join(" | ").trim();
    if (!tool || !reason) continue;
    out.push(targetSubstring ? { tool, targetSubstring, reason } : { tool, reason });
  }
  return out;
}
