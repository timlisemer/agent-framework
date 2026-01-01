const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /auth/i,
  /bearer/i,
  /private[_-]?key/i,
];

const SENSITIVE_VALUE_PATTERN = /^[a-zA-Z0-9_-]{32,}$/;

export function sanitizeToolInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
      sanitized[key] = "[REDACTED]";
      continue;
    }

    if (typeof value === "string" && SENSITIVE_VALUE_PATTERN.test(value)) {
      sanitized[key] = "[REDACTED_KEY]";
      continue;
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeToolInput(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
