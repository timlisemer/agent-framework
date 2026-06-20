import path from "node:path";

type JsonObject = Record<string, unknown>;

export function codexEntryCwd(event: JsonObject): string | null {
  const payload = objectAt(event, "payload");
  const cwd = typeof payload?.cwd === "string"
    ? payload.cwd
    : typeof event.cwd === "string"
      ? event.cwd
      : null;
  return cwd ? path.resolve(cwd) : null;
}

export function codexEntrySessionId(event: JsonObject): string | null {
  const payload = objectAt(event, "payload");
  if (event.type === "session_meta" && typeof payload?.id === "string") {
    return payload.id;
  }
  if (typeof event.thread_id === "string") return event.thread_id;
  return typeof payload?.thread_id === "string" ? payload.thread_id : null;
}

export function codexEventCwd(line: string): string | null {
  return parseCodexEventValue(line, codexEntryCwd);
}

export function codexEventSessionId(line: string): string | null {
  return parseCodexEventValue(line, codexEntrySessionId);
}

function parseCodexEventValue(line: string, extract: (event: JsonObject) => string | null): string | null {
  try {
    const event = JSON.parse(line) as unknown;
    return event && typeof event === "object" && !Array.isArray(event)
      ? extract(event as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function objectAt(input: JsonObject, key: string): JsonObject | null {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}
