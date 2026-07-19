export const SENSITIVE_PATH_CLASSIFICATION_POLICY = {
  words: [
    "credential",
    "credentials",
    "secret",
    "secrets",
    "password",
    "passwords",
  ],
  segmentNames: [".ssh", ".aws", ".gnupg", ".kube"],
  compoundBasenamePattern: { source: "passwords", flags: "i" },
  basenamePatterns: [
    { source: "^\\.env$", flags: "i" },
    { source: "^\\.env\\.(?!example$).+", flags: "i" },
    { source: "^\\.sops\\.ya?ml$", flags: "i" },
    { source: "^.+\\.sops\\.(json|ya?ml|toml|env|ini)$", flags: "i" },
    { source: "^(auth|token|tokens)([-_.].*)?\\.(json|ya?ml|toml|env|ini|txt)$", flags: "i" },
    { source: "^.+\\.(agekey|key|pem|p12|pfx|jks|keystore)$", flags: "i" },
    { source: "^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$", flags: "i" },
    { source: "^(kubeconfig|config\\.kube)$", flags: "i" },
  ],
} as const;

const SENSITIVE_WORDS = SENSITIVE_PATH_CLASSIFICATION_POLICY.words;
const SENSITIVE_WORD_PATTERN = SENSITIVE_WORDS.join("|");
const SENSITIVE_WORD_RE = new RegExp(`(^|[-_.])(${SENSITIVE_WORD_PATTERN})([-_.]|$)`, "i");
const SENSITIVE_COMPOUND_BASENAME_RE = new RegExp(
  SENSITIVE_PATH_CLASSIFICATION_POLICY.compoundBasenamePattern.source,
  SENSITIVE_PATH_CLASSIFICATION_POLICY.compoundBasenamePattern.flags,
);

const SENSITIVE_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  ...SENSITIVE_PATH_CLASSIFICATION_POLICY.segmentNames,
  ...SENSITIVE_WORDS,
]);

const SENSITIVE_BASENAME_PATTERNS: RegExp[] =
  SENSITIVE_PATH_CLASSIFICATION_POLICY.basenamePatterns.map(
    ({ source, flags }) => new RegExp(source, flags),
  );

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
