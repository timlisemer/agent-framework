import type { JsonValue } from "../protocol/common.js";
import { digestScenarioValue } from "../protocol/digest.js";

const SECRET_FIELD_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "passkey",
  "secret",
  "token",
  "credential",
  "credentials",
  "privatekey",
  "clientsecret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
]);
const SECRET_FIELD_SUFFIXES = [
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "credentials",
  "privatekey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
] as const;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_AUTH = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;
const COOKIE = /\b(?:session|auth|token|jwt)=[^;\s]+/gi;
const ENVIRONMENT_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/g;
const HEADER_VALUE = /\b([A-Za-z][A-Za-z0-9-]*)\s*:\s*((?:Bearer|Basic)\s+[^\s'";,]+|[^\s'";,]+)/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const RECOGNIZED_CREDENTIALS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
] as const;

export type ScenarioRedactionOptions = {
  secretPaths?: readonly string[];
};

export function redactScenarioValue(
  value: JsonValue,
  key?: string,
  path: readonly string[] = [],
  options: ScenarioRedactionOptions = {},
): JsonValue {
  const currentPath = key ? [...path, key] : [...path];
  if (isCanonicalRedactedValue(value)) return value;
  if (configuredSecretPath(currentPath, options.secretPaths ?? [])) {
    return redacted(value, `Configured secret path ${currentPath.join(".")}`);
  }
  if (key && isSecretFieldName(key)) {
    return redacted(value, `Secret-like field ${key}`);
  }
  if (typeof value === "string") {
    return redactScenarioString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactScenarioValue(item, String(index), currentPath, options));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactScenarioValue(child, childKey, currentPath, options),
    ]));
  }
  return value;
}

function isCanonicalRedactedValue(value: JsonValue): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["redacted", "reason", "originalType", "shape"].includes(key))) return false;
  if (value.redacted !== true || typeof value.reason !== "string" || typeof value.originalType !== "string") {
    return false;
  }
  if (!/^(?:Secret-like field [A-Za-z0-9_.-]+|Configured secret path [A-Za-z0-9_.*-]+)$/.test(value.reason)) {
    return false;
  }
  if (!["null", "array", "object", "string", "number", "boolean"].includes(value.originalType)) return false;
  return value.shape === undefined || (
    typeof value.shape === "string" && /^(?:array|object)\(\d+\)$/.test(value.shape)
  );
}

/** Redact one durable value and repair digests that describe sanitized children. */
export function sanitizeScenarioValueForPersistence(
  value: JsonValue,
  path: readonly string[] = [],
  options: ScenarioRedactionOptions = {},
): JsonValue {
  return recomputeDigestBearingValues(redactScenarioValue(value, undefined, path, options));
}

function recomputeDigestBearingValues(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(recomputeDigestBearingValues);
  if (!value || typeof value !== "object") return value;
  const sanitized = Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    recomputeDigestBearingValues(child),
  ])) as Record<string, JsonValue>;
  if (typeof sanitized.contentDigest === "string") {
    const content = typeof sanitized.content === "string"
      ? sanitized.content
      : typeof sanitized.prompt === "string" ? sanitized.prompt : undefined;
    if (content !== undefined) sanitized.contentDigest = digestScenarioValue(content);
  }
  if (typeof sanitized.inputDigest === "string" && sanitized.input !== undefined) {
    sanitized.inputDigest = digestScenarioValue(sanitized.input);
  }
  if (
    typeof sanitized.digest === "string" &&
    Array.isArray(sanitized.messages) &&
    Array.isArray(sanitized.tools)
  ) {
    sanitized.digest = digestScenarioValue({
      messages: sanitized.messages,
      tools: sanitized.tools,
    });
  }
  return sanitized;
}

function redactScenarioString(value: string): string {
  let redactedValue = value
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(BASIC_AUTH, "Basic [REDACTED]")
    .replace(ENVIRONMENT_ASSIGNMENT, (match, key: string) =>
      isSecretFieldName(key) ? `${key}=[REDACTED]` : match
    )
    .replace(HEADER_VALUE, (match, key: string) =>
      isSecretFieldName(key) ? `${key}: [REDACTED]` : match
    )
    .replace(COOKIE, (match) => `${match.split("=")[0]}=[REDACTED]`);
  for (const pattern of RECOGNIZED_CREDENTIALS) {
    redactedValue = redactedValue.replace(pattern, "[REDACTED]");
  }
  return redactedValue;
}

function isSecretFieldName(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return SECRET_FIELD_NAMES.has(normalized) || SECRET_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function configuredSecretPath(path: readonly string[], configured: readonly string[]): boolean {
  const joined = path.join(".");
  return configured.some((candidate) => {
    const normalized = candidate.trim().replace(/^\$\.?/, "");
    if (!normalized) return false;
    const pattern = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^.]+");
    return new RegExp(`(?:^|\\.)${pattern}(?:$|\\.)`).test(joined);
  });
}

function redacted(value: JsonValue, reason: string): JsonValue {
  return {
    redacted: true,
    reason,
    originalType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    ...(value && typeof value === "object"
      ? { shape: Array.isArray(value) ? `array(${value.length})` : `object(${Object.keys(value).length})` }
      : {}),
  };
}
