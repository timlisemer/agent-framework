export function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

export function nonEmptyStringField(value: Record<string, unknown>, key: string): string | null {
  const field = stringField(value, key);
  return field && field.length > 0 ? field : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordFromUnknown(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function trimmedStringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (typeof field !== "string") return null;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function errorMessage(value: unknown, fallback = "Runtime error"): string {
  const message = value && typeof value === "object" && "message" in value && typeof value.message === "string"
    ? value.message
    : typeof value === "string" ? value : null;
  return message !== null && message.trim().length > 0 ? message : fallback;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function optionalNumber(value: number | undefined): number | null {
  return value === undefined ? null : value;
}
