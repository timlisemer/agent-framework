const SENSITIVE_WORDS = [
  "credential",
  "credentials",
  "secret",
  "secrets",
  "password",
  "passwords",
] as const;
const SENSITIVE_WORD_PATTERN = SENSITIVE_WORDS.join("|");
const SENSITIVE_WORD_RE = new RegExp(`(^|[-_.])(${SENSITIVE_WORD_PATTERN})([-_.]|$)`, "i");
const SENSITIVE_COMPOUND_BASENAME_RE = /passwords/i;

const SENSITIVE_SEGMENT_NAMES = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ...SENSITIVE_WORDS,
]);

const SENSITIVE_BASENAME_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!example$).+/i,
  /^\.sops\.ya?ml$/i,
  /^.+\.sops\.(json|ya?ml|toml|env|ini)$/i,
  /^.+\.(agekey|key|pem|p12|pfx|jks|keystore)$/i,
  /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  /^(kubeconfig|config\.kube)$/i,
];

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => SENSITIVE_SEGMENT_NAMES.has(part.toLowerCase()))) {
    return true;
  }
  const dirParts = parts.slice(0, -1);
  if (dirParts.some((part) => SENSITIVE_WORD_RE.test(part))) {
    return true;
  }
  const basename = parts[parts.length - 1] ?? normalized;
  return SENSITIVE_WORD_RE.test(basename) ||
    SENSITIVE_COMPOUND_BASENAME_RE.test(basename) ||
    SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(basename));
}
